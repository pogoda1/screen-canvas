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
