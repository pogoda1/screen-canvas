import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, guestEval, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('a real isolated preview submits a form and saves the latest fetch-bound reload', { timeout: 45000 }, async t => {
  const folder = await makeHost(t, {
    'nested.html': '<!doctype html><html><head><title>Nested</title></head><body><h1>Nested frame</h1></body></html>',
    'screen-canvas.config.mjs': `export default {
      browser: '/src/bindings.js',
      schema: node => node.path === '/' ? {
        kind: 'object', sources: [], fields: { 'GET /api/profile': {
          kind: 'object', sources: [], binding: { kind: 'api', key: 'profile' }, fields: { name: { kind: 'string', sources: [] } }
        } }
      } : undefined,
      scenario: node => ({ data: node.path === '/' ? { 'GET /api/profile': { name: 'First' } } : {} })
    };`,
    'src/bindings.js': `
      import { registerBrowserBindings } from 'react-screen-canvas/browser';
      registerBrowserBindings({
        ready: () => Boolean(document.querySelector('h1') || document.querySelector('#form-ready')),
        read: scenario => ({ ...scenario, draft: { submitted: document.querySelector('output')?.textContent ?? '' } })
      });
    `,
    'src/main.jsx': `
      import React, {useEffect, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route, Link} from 'react-router-dom';
      function Form() {
        const [name, setName] = useState('');
        const [submitted, setSubmitted] = useState('');
        useEffect(() => { setTimeout(() => {
          fetch('/api/profile').then(r => r.json()).then(value => setName(value.name));
        }, 300); }, []);
        if (!name) return <p>Loading form</p>;
        return <section id="form-ready"><form onSubmit={evt => {
          evt.preventDefault(); setSubmitted(new FormData(evt.currentTarget).get('name'));
        }}>
          <label>Name <input name="name" defaultValue={name}/></label>
          <button>Submit</button><output>{submitted}</output>
        </form><Link to="/next">Next screen</Link></section>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Form/>}/><Route path="/next" element={<h1>Second screen</h1>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const first = shell.getByRole('button', { name: '/', exact: true });
  await first.click();
  await waitGuest(electron, "document.querySelector('input')?.value === 'First'");
  const info = await electron.evaluate(({ BrowserWindow, webContents }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window.contentView.children.at(-1);
    const guest = webContents.getAllWebContents().find(wc => wc.getURL().startsWith('http://127.0.0.1:'));
    return { bounds: view.getBounds(), sandbox: guest.getLastWebPreferences().sandbox,
      separate: guest.session !== window.webContents.session };
  });
  assert.ok(info.bounds.width > 100 && info.bounds.height > 100);
  assert.ok(info.sandbox && info.separate);
  assert.deepEqual(await guestEval(electron, '[typeof window.screenCanvas, typeof require, typeof process]'),
    ['undefined', 'undefined', 'undefined']);
  assert.equal(await guestEval(electron, "window.open('https://example.invalid/') === null"), true);
  await guestEval(electron, "document.querySelector('input').focus()");
  await electron.evaluate(({ BrowserWindow, webContents }) => {
    BrowserWindow.getAllWindows()[0].focus();
    const guest = webContents.getAllWebContents().find(wc => wc.getURL().startsWith('http://127.0.0.1:'));
    guest.focus();
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
    guest.sendInputEvent({ type: 'char', keyCode: 'Z' });
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    guest.sendInputEvent({ type: 'char', keyCode: '\r' });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  });
  await waitGuest(electron, "document.querySelector('output')?.textContent.includes('Z')");
  const open = await shell.evaluate(async () => {
    const state = await screenCanvas.state();
    const preview = await screenCanvas.open(state.generation, 'route:/');
    return { generation: state.generation, id: preview.id };
  });
  await guestEval(electron, `Promise.all([
    fetch('/nested.html', {headers:{accept:'text/html'}}).then(response => response.text()),
    new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.src = '/nested.html';
      frame.addEventListener('load', resolve, {once:true});
      document.body.append(frame);
    })
  ]).then(([text]) => {
    if (text.includes('__screenCanvasBoot=')) throw new Error('HTML fetch received the main document binding');
  })`);
  const nested = await shell.evaluate(({ generation, id }) => screenCanvas.save(generation, id, 'Main document unchanged'), open);
  assert.equal(nested.scenario.nodeId, 'route:/');
  assert.equal(nested.scenario.data['GET /api/profile'].name, 'First');
  const value = await shell.evaluate(async ({ generation, id }) => {
    const edited = await screenCanvas.patch(generation, id, [{ path: ['GET /api/profile', 'name'], value: 'Latest' }]);
    const saved = await screenCanvas.save(generation, id, 'Latest state');
    return { edited, saved };
  }, open);
  assert.equal(value.edited.reload, true);
  assert.equal(value.saved.scenario.data['GET /api/profile'].name, 'Latest');
  await waitGuest(electron, "document.querySelector('input')?.value === 'Latest'");
  await guestEval(electron, "document.querySelector('a').click()");
  await waitGuest(electron, "document.querySelector('h1')?.textContent === 'Second screen'");
  await shell.evaluate(() => { window.location.href = 'file:///invalid-canvas-page'; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(shell.url(), 'app://canvas/index.html');
  await shell.getByRole('button', { name: '/next', exact: true }).click();
  await waitGuest(electron, "document.querySelector('h1')?.textContent === 'Second screen'");
  await assert.rejects(shell.evaluate(({ generation, id }) => screenCanvas.read(generation, id), open), /expired/);
});

test('a timed-out navigation does not prevent saving after returning in the live view', { timeout: 45_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': "export default { browser: '/src/bindings.js' };",
    'src/bindings.js': `
      import { registerBrowserBindings } from 'react-screen-canvas/browser';
      registerBrowserBindings({ ready: () => Boolean(document.querySelector('h1')) && location.pathname === '/' });
    `,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route} from 'react-router-dom';
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<main><h1>Ready screen</h1><a href="/slow">Open slow screen</a></main>}/>
        <Route path="/slow" element={<main><h1>Slow screen</h1><a href="/">Return to ready screen</a></main>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  await shell.getByRole('button', { name: '/', exact: true }).click();
  const label = shell.getByRole('textbox', { name: 'Имя варианта' });
  const save = shell.getByRole('button', { name: 'Сохранить', exact: true });
  await waitGuest(electron, 'document.querySelector("h1")?.textContent === "Ready screen"');
  await label.fill('Back to the ready screen');
  await guestEval(electron, 'document.querySelector("a").click()');
  await waitGuest(electron, 'document.querySelector("h1")?.textContent === "Slow screen"');
  await save.click();
  await shell.getByText(/Timed out waiting for the current preview document/).waitFor();

  await guestEval(electron, 'document.querySelector("a").click()');
  await waitGuest(electron, 'document.querySelector("h1")?.textContent === "Ready screen"');
  await save.click();
  await shell.getByText('Вариант сохранён').waitFor();
  await shell.getByRole('button', { name: 'Back to the ready screen', exact: true }).waitFor();
});
