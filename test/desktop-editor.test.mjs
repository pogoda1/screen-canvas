import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { launchCanvas, pick, guestEval, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('editing survives a rapid Save and restores UI draft with the same server value', { timeout: 45_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      browser: '/src/bindings.js',
      schema: () => ({ kind: 'object', sources: [], fields: {
        title: { kind:'string', sources:[], maxLength:8, binding:{kind:'state', key:'title'} },
        settings: { kind:'object', sources:[], binding:{kind:'state', key:'settings'}, fields: {
          enabled: { kind:'boolean', sources:[] },
          tags: { kind:'array', sources:[], minItems:1, maxItems:2, items:{kind:'string',sources:[]} }
        } }
      } }),
      scenario: () => ({ data: {title:'Base', settings:{enabled:false,tags:['First']}} })
    };`,
    'src/bindings.js': `
      import { registerBrowserBindings } from 'react-screen-canvas/browser';
      let draft = 'C1';
      window.addEventListener('change', event => { if (event.target.id === 'level') draft = event.target.value; });
      registerBrowserBindings({
        ready: () => Boolean(document.querySelector('#title')),
        apply(scenario) {
          document.querySelector('#title').textContent = scenario.data.title;
          document.querySelector('#server').textContent = 'C1';
          if (scenario.draft) { draft = scenario.draft.level; document.querySelector('#level').value = draft; }
        },
        read: scenario => ({ ...scenario, draft: { level: draft } })
      });
    `,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route} from 'react-router-dom';
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<main><h1 id="title">Base</h1><label>Level<select id="level">
          <option>C1</option><option>C1_native</option>
        </select></label><p id="server">C1</p></main>}/>
      </Routes></BrowserRouter>);
    `
  });
  const first = await launchCanvas(t);
  await pick(first.electron, first.shell, folder);
  await first.shell.getByRole('button', { name: '/', exact: true }).click();
  await waitGuest(first.electron, "document.querySelector('#title')?.textContent === 'Base'");
  const title = first.shell.getByRole('textbox', { name: 'title', exact: true });
  await title.fill('Oversized');
  await first.shell.getByText('Text length is out of bounds').waitFor();
  assert.equal(await guestEval(first.electron, "document.querySelector('#title').textContent"), 'Base');
  await first.shell.getByRole('checkbox', { name: 'enabled' }).check();
  const variantName = first.shell.getByRole('textbox', { name: 'Имя варианта' });
  const save = first.shell.getByRole('button', { name: 'Сохранить', exact: true });
  const append = first.shell.getByRole('button', { name: 'Добавить элемент' });
  const listError = first.shell.locator('.field-error').filter({ hasText: 'List length is out of bounds' });
  const resetList = listError.getByRole('button', { name: 'Сбросить правку' });
  await variantName.fill('Rejected draft');
  await first.shell.getByRole('button', { name: 'Удалить', exact: true }).click();
  await resetList.waitFor();
  assert.equal(await first.shell.getByRole('textbox', { name: '1', exact: true }).inputValue(), 'First');
  await resetList.click();
  await save.click();
  await first.shell.getByText('Исправьте значения полей перед сохранением').waitFor();
  await first.shell.getByText('Text length is out of bounds', { exact: false }).waitFor();
  assert.equal(await title.inputValue(), 'Oversized');
  await title.fill('Last');
  await append.click();
  await first.shell.getByRole('textbox', { name: '2', exact: true }).waitFor();
  await first.shell.getByRole('textbox', { name: '2', exact: true }).fill('Second');
  await append.click();
  await resetList.waitFor();
  assert.equal(await listError.locator('..').locator(':scope > .field-title > label').textContent(), 'tags');
  assert.equal(await first.shell.getByRole('textbox', { name: '3', exact: true }).count(), 0);
  await save.click();
  await first.shell.getByText('Исправьте значения полей перед сохранением').waitFor();
  await resetList.click();
  await listError.waitFor({ state: 'hidden' });
  assert.equal(await first.shell.getByRole('textbox', { name: '2', exact: true }).inputValue(), 'Second');
  await guestEval(first.electron, `(() => {
    const input = document.querySelector('#level');
    input.value = 'C1_native'; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await first.shell.getByRole('textbox', { name: 'Имя варианта' }).fill('Restored option');
  await title.fill('Last!');
  await save.click();
  await first.shell.getByText('Вариант сохранён').waitFor();
  const scenarios = path.join(folder, 'screen-canvas/scenarios');
  const [filename] = await readdir(scenarios);
  const saved = JSON.parse(await readFile(path.join(scenarios, filename), 'utf8'));
  assert.deepEqual(saved.scenario.data, { title: 'Last!', settings: { enabled: true, tags: ['First', 'Second'] } });
  assert.deepEqual(saved.scenario.draft, { level: 'C1_native' });
  await first.electron.close();

  const second = await launchCanvas(t);
  await pick(second.electron, second.shell, folder);
  await second.shell.getByRole('button', { name: '/', exact: true }).click();
  await second.shell.getByRole('button', { name: 'Restored option', exact: true }).click();
  await waitGuest(second.electron, "document.querySelector('#title')?.textContent === 'Last!'");
  assert.deepEqual(await guestEval(second.electron,
    "[document.querySelector('#level').value, document.querySelector('#server').textContent]"), ['C1_native', 'C1']);
});
