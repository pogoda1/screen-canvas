import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { launchCanvas, pick } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('Electron selects, keeps, switches and stops local projects', { timeout: 60000 }, async t => {
  const root = await makeHost(t);
  const unsupported = await makeHost(t, { 'package.json': '{"scripts":{"dev":"custom launcher"}}' });
  const control = createServer(socket => socket.end());
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  t.after(() => control.close());
  const { electron, shell } = await launchCanvas(t);
  assert.equal(shell.url(), 'app://canvas/index.html');
  await pick(electron, shell, null);
  await shell.getByText('Выберите папку локального React-проекта').waitFor();
  await pick(electron, shell, root);
  await shell.getByText('Маршруты найдены', { exact: false }).waitFor();
  await shell.getByText('/next', { exact: true }).waitFor();
  const generation = await shell.evaluate(async () => (await window.screenCanvas.state()).generation);
  await pick(electron, shell, root);
  await pick(electron, shell, null);
  assert.equal(await shell.evaluate(async () => (await window.screenCanvas.state()).generation), generation);
  await pick(electron, shell, unsupported);
  await shell.getByText('Use a standard Vite dev script', { exact: false }).waitFor();
  await pick(electron, shell, root);
  await shell.getByText('/next', { exact: true }).waitFor();
  await shell.getByRole('button', { name: 'Закрыть проект' }).click();
  await shell.getByText('Выберите папку локального React-проекта').waitFor();
  assert.ok(control.listening);
});


test('rebuild reloads adapter dependencies and rechecks variants without writing them', { timeout: 60_000 }, async t => {
  const description = (name, maxLength) => `export const label = ${JSON.stringify(name)};
    export const maximum = ${maxLength};`;
  const root = await makeHost(t, {
    'description.mjs': description('Original adapter node', 20),
    'screen-canvas.config.mjs': `import { label, maximum } from './description.mjs';
      export default {
        nodes: [{ id: 'route:/#added', path: '/', state: 'added', label }],
        schema: () => ({ kind:'object', sources:[], fields: { text: { kind:'string', sources:[], maxLength:maximum } } }),
        scenario: () => ({ data: { text: 'Example' } })
      };`
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, root);
  await shell.getByRole('button', { name: 'Original adapter node' }).waitFor();
  await shell.getByRole('button', { name: '/', exact: true }).click();
  const label = shell.getByRole('textbox', { name: 'Имя варианта' });
  await label.fill('Existing JSON');
  await shell.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await shell.getByText('Вариант сохранён').waitFor();
  const dir = path.join(root, 'screen-canvas/scenarios');
  const file = path.join(dir, (await readdir(dir)).find(name => name.endsWith('.json')));
  const before = await readFile(file);
  await writeFile(path.join(root, 'description.mjs'), description('Updated adapter node', 4));
  await shell.getByRole('button', { name: 'Перестроить' }).click();
  await shell.getByRole('button', { name: 'Updated adapter node' }).waitFor();
  assert.equal(await shell.getByRole('button', { name: 'Original adapter node' }).count(), 0);
  await shell.getByRole('button', { name: '/', exact: true }).click();
  await shell.getByText('Несовместимый вариант', { exact: false }).waitFor();
  assert.deepEqual(await readFile(file), before);
  await electron.close();
});

test('cancel and close release active scan and live ports and permit reopening', { timeout: 35_000 }, async t => {
  const root = await makeHost(t, {
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route, Link} from 'react-router-dom';

      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<main><h1>Local home</h1><Link to="/steady">Local details</Link></main>}/>
        <Route path="/steady" element={<h1>Local details</h1>}/>
        <Route path="/load-first" element={<main aria-busy="true">Loading…</main>}/>
        <Route path="/load-second" element={<main aria-busy="true">Loading…</main>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { preparePackagedLaunch } = await import('./packaged/launcher.mjs');
  const appPath = process.env.SCREEN_CANVAS_PACKAGED_APP;
  const options = appPath ? (await preparePackagedLaunch(t, appPath, root)).options : {};
  const { electron, shell } = await launchCanvas(t, options);
  async function until(observe, message) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await observe();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw new Error(message);
  }
  const resources = () => electron.evaluate(({ BrowserWindow, app }) => {
    const windows = BrowserWindow.getAllWindows();
    const local = contents => contents?.getURL().startsWith('http://127.0.0.1:');
    const scans = windows.flatMap(window => local(window.webContents) && window.webContents.isOffscreen()
      ? [window.webContents.getURL()] : []);
    const live = windows.flatMap(window => window.contentView.children.flatMap(view =>
      view.webContents && local(view.webContents) ? [view.webContents.getURL()] : []));
    const workers = app.getAppMetrics().filter(item => item.name === 'Screen Canvas Project').map(item => item.pid);
    return { scans, live, workers };
  });

  try {
    await pick(electron, shell, root);
    await shell.getByRole('button', { name: '/', exact: true }).click();
    const old = await until(async () => {
      const snapshot = await resources();
      return snapshot.live.length && snapshot.scans.some(url => /\/load-/.test(url)) && snapshot;
    }, 'No simultaneous live and unfinished capture sessions were observed');
    assert.equal(old.workers.length, 1, JSON.stringify(old));
    await shell.getByRole('button', { name: 'Остановить обход' }).click();
    await shell.getByText('Обход остановлен').waitFor();
    await until(async () => (await resources()).scans.length === 0, 'Offscreen capture windows survived cancellation');
    const progress = await shell.evaluate(async () => (await screenCanvas.state()).progress);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepEqual(await shell.evaluate(async () => (await screenCanvas.state()).progress), progress);

    await shell.getByRole('button', { name: 'Закрыть проект' }).click();
    await shell.getByText('Выберите папку локального React-проекта').waitFor();
    await until(async () => (await resources()).workers.length === 0, 'The project worker survived closing');
    for (const url of [...old.scans, ...old.live]) {
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(750) }), error => error.cause?.code === 'ECONNREFUSED');
    }

    await pick(electron, shell, root);
    await shell.getByRole('button', { name: '/steady', exact: true }).click();
    await until(async () => (await resources()).live.some(url => url.endsWith('/steady')), 'The reopened preview did not load');
  } finally {
    await electron.close();
  }
});
