import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { launchCanvas, pick, guestEval, waitGuest } from './helpers/electron.mjs';
import { hashFile, prepareBasic, prepareTransfer } from './prepare-transfer.mjs';

export async function runBasic(t, project, options = {}) {
  const { electron, shell } = await launchCanvas(t, options);
  await pick(electron, shell, project);
  await shell.getByRole('button', { name: '/', exact: true }).click();
  await waitGuest(electron, "document.querySelector('h1')?.textContent === 'Welcome'");
  await guestEval(electron, "document.querySelector('a').click()");
  await waitGuest(electron, "document.querySelector('h1')?.textContent === 'About this example'");
  await closeOwned(electron);
}

export async function runCatalog(t, project, options = {}, revalidate = false) {
  const start = async () => {
    const canvas = await launchCanvas(t, options);
    await pick(canvas.electron, canvas.shell, project);
    return canvas;
  };
  const first = await start();
  await first.shell.getByRole('button', { name: '/products', exact: true }).click();
  await waitGuest(first.electron, "document.querySelector('h1')?.textContent === 'Products'");
  await guestEval(first.electron, "document.querySelector('a').click()");
  await waitGuest(first.electron, "document.querySelector('h1')?.textContent === 'Field Notes'");
  assert.deepEqual(await guestEval(first.electron,
    "[location.pathname, document.querySelector('[data-product-id]').dataset.productId]"),
    ['/products/field-notes', 'field-notes']);
  assert.ok(await first.shell.getByRole('textbox', { name: 'id', exact: true }).isDisabled());
  await first.shell.getByText('ID связан с параметром URL и записью API').waitFor();
  const title = first.shell.getByRole('textbox', { name: 'title', exact: true });
  assert.equal(await title.getAttribute('aria-description'), 'Максимум 24 символов');
  const eyebrow = first.shell.getByRole('textbox', { name: 'eyebrow', exact: true });
  assert.match(await eyebrow.locator('..').getAttribute('title'), /typescript.*main.tsx/);
  await eyebrow.fill('Trail kit');
  await waitGuest(first.electron, "document.querySelector('[data-caption]')?.textContent === 'Trail kit'");
  await title.fill('Trail Journal');
  await first.shell.getByRole('textbox', { name: 'Имя варианта' }).fill('Portable draft');
  await first.shell.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await first.shell.getByText('Вариант сохранён').waitFor();
  await waitGuest(first.electron, "document.querySelector('h1')?.textContent === 'Trail Journal'");
  const state = await first.shell.evaluate(() => screenCanvas.state());
  assert.ok(state.graph.nodes.find(node => node.path === '/products/:id').requests.some(
    request => request.method === 'GET' && request.path === '/api/products/field-notes' && request.status === 200));
  const directory = path.join(project, 'screen-canvas', 'scenarios');
  const files = await readdir(directory);
  const filename = files.find(name => name.endsWith('.json'));
  const variant = path.join(directory, filename);
  const before = await hashFile(variant);
  await closeOwned(first.electron);

  const second = await start();
  await second.shell.getByRole('button', { name: '/products/:id', exact: true }).click();
  await second.shell.getByRole('button', { name: 'Portable draft', exact: true }).click();
  await waitGuest(second.electron, "document.querySelector('h1')?.textContent === 'Trail Journal'");
  await waitGuest(second.electron, "document.querySelector('[data-caption]')?.textContent === 'Trail kit'");
  if (revalidate) {
    const openapi = path.join(project, 'openapi.json');
    const initial = await readFile(openapi, 'utf8');
    try {
      const schema = JSON.parse(initial);
      schema.components.schemas.Product.properties.title.maxLength = 11;
      await writeFile(openapi, JSON.stringify(schema));
      await second.shell.getByRole('button', { name: 'Перестроить', exact: true }).click();
      const next = second.shell.getByRole('button', { name: '/products/:id', exact: true });
      await next.click();
      await second.shell.getByText('Несовместимый вариант', { exact: false }).waitFor();
      assert.equal(await second.shell.getByRole('textbox', { name: 'title', exact: true }).getAttribute('aria-description'),
        'Максимум 11 символов');
      assert.equal(await hashFile(variant), before);
    } finally {
      await writeFile(openapi, initial);
    }
  }
  await closeOwned(second.electron);
}

async function closeOwned(electron) {
  const origin = await guestEval(electron, 'location.origin');
  const processes = await electron.evaluate(({ app }) =>
    app.getAppMetrics().map(metric => metric.pid));
  await electron.close();
  await assert.rejects(fetch(origin));
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return false;
    }
  };
  const deadline = Date.now() + 2500;
  while (processes.some(alive) && Date.now() < deadline) await setTimeout(50);
  assert.deepEqual(processes.filter(alive), []);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  test('loads independent consumers in desktop Electron with and without SDK', { timeout: 75_000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'screen-canvas-transfer-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const [catalog, basic] = await Promise.all([
      prepareTransfer(path.join(root, 'catalog')), prepareBasic(path.join(root, 'basic'))
    ]);
    assert.equal(await hashFile(catalog.artifact), catalog.digest);
    await runCatalog(t, catalog.project);
    await runBasic(t, basic);
    console.log('Installed runtime SHA-256:', catalog.digest);
  });
}
