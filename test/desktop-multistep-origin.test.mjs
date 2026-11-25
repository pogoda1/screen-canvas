import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, waitGraph, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('confirmed multi-step actions anchor to the screen with the multi-step reason while preserving single-click anchors and fallbacks', { timeout: 45_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      scenario: (node, mode) => ({ mode: mode ?? 'member' }),
      actions: [
        { id: 'multi-two', source: 'route:/form', target: 'route:/done', label: 'Two-step select',
          steps: [{ type: 'click', selector: '#opt-a' }, { type: 'click', selector: '#submit' }],
          expectRequests: [{ method: 'POST', path: '/api/submit', status: 200 }] },
        { id: 'multi-three', source: 'route:/form', target: 'route:/done', label: 'Three-step select',
          steps: [
            { type: 'click', selector: '#opt-a' },
            { type: 'click', selector: '#opt-b' },
            { type: 'click', selector: '#submit' }
          ],
          expectRequests: [{ method: 'POST', path: '/api/submit', status: 200 }] },
        { id: 'multi-fill', source: 'route:/form', target: 'route:/done', label: 'Fill and submit',
          steps: [{ type: 'fill', selector: '#note', value: 'sample' }, { type: 'click', selector: '#submit' }],
          expectRequests: [{ method: 'POST', path: '/api/submit', status: 200 }] },
        { id: 'single-stable', source: 'route:/form', target: 'route:/done', label: 'Single stable click',
          steps: [{ type: 'click', selector: '#skip' }] },
        { id: 'single-alternate', source: 'route:/form', target: 'route:/done', label: 'Alternate role click',
          role: 'guest', steps: [{ type: 'click', selector: '#skip' }] },
        { id: 'single-scrolled', source: 'route:/form', target: 'route:/done', label: 'Below frame click',
          steps: [{ type: 'click', selector: '#below' }] },
        { id: 'auto-redirect', source: 'route:/auto', target: 'route:/done', label: 'Automatic redirect',
          expectedPath: '/done', steps: [{ type: 'redirect' }] }
      ],
      createMocks: () => () => ({ status: 200, body: { ok: true } })
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Navigate, Routes, Route, useNavigate} from 'react-router-dom';
      function Form() {
        const go = useNavigate();
        const [selected, setSelected] = React.useState([]);
        const [note, setNote] = React.useState('');
        const toggle = id => setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
        async function submit() {
          await fetch('/api/submit', { method: 'POST' });
          go('/done');
        }
        return <main style={{minHeight:1600}}>
          <h1>Wizard step</h1>
          <button id="opt-a" style={{position:'absolute',left:30,top:110,width:100,height:40}} onClick={() => toggle('a')}>Option A</button>
          <button id="opt-b" style={{position:'absolute',left:150,top:110,width:100,height:40}} onClick={() => toggle('b')}>Option B</button>
          <input id="note" value={note} onChange={e => setNote(e.target.value)} style={{position:'absolute',left:30,top:170,width:220,height:36}} />
          <button id="submit" disabled={!selected.length && !note} style={{position:'absolute',left:30,top:230,width:120,height:42}} onClick={submit}>Continue</button>
          <button id="skip" style={{position:'absolute',left:40,top:310,width:120,height:42}} onClick={() => go('/done')}>Skip</button>
          <button id="below" style={{position:'absolute',left:40,top:1440,width:120,height:42}} onClick={() => go('/done')}>Below fold</button>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/form" element={<Form/>}/>
        <Route path="/auto" element={<Navigate to="/done" replace/>}/>
        <Route path="/done" element={<main><h1>Done</h1></main>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const { edges } = await waitGraph(shell);
  await shell.getByRole('button', { name: '/form', exact: true }).click();
  await waitGuest(electron, 'Boolean(document.querySelector("#skip"))');

  for (const id of ['multi-two', 'multi-three', 'multi-fill']) {
    const { evidence } = edges.find(edge => edge.id === id);
    assert.equal(evidence.status, 'confirmed', JSON.stringify(evidence));
    assert.equal(evidence.origin, undefined, JSON.stringify(evidence));
    assert.equal(evidence.originReason, 'multi-step', JSON.stringify(evidence));
    assert.equal(await shell.locator('#connections path[data-edge-id="' + id + '"]').getAttribute('data-origin'), 'screen');
    assert.equal(await shell.locator('#connection-origins [data-edge-id="' + id + '"]').count(), 0);
    const row = shell.locator('.edge-details li[data-edge-id="' + id + '"]');
    await row.getByText('Источник стрелки · Экран · Многошаговое действие', { exact: true }).waitFor();
    assert.equal(await row.getByText('элемент на исходном кадре не подтверждён').count(), 0);
  }

  const single = edges.find(edge => edge.id === 'single-stable').evidence;
  assert.equal(single.status, 'confirmed');
  assert.deepEqual(single.origin, { x: 100 / 390, y: 331 / 844 });
  assert.equal(single.originReason, undefined);
  assert.equal(await shell.locator('#connections path[data-edge-id="single-stable"]').getAttribute('data-origin'), 'control');
  assert.equal(await shell.locator('#connection-origins [data-edge-id="single-stable"]').count(), 1);
  await shell.locator('.edge-details li[data-edge-id="single-stable"]')
    .getByText('Источник стрелки · Видимый элемент', { exact: true }).waitFor();

  for (const [id, reason, label] of [
    ['single-alternate', 'different-scenario', 'Источник стрелки · Экран · роль или состояние отличаются от кадра'],
    ['single-scrolled', 'control-not-in-frame', 'Источник стрелки · Экран · элемент на исходном кадре не подтверждён']
  ]) {
    const { evidence } = edges.find(edge => edge.id === id);
    assert.equal(evidence.status, 'confirmed');
    assert.equal(evidence.origin, undefined);
    assert.equal(evidence.originReason, reason);
    assert.equal(await shell.locator('#connections path[data-edge-id="' + id + '"]').getAttribute('data-origin'), 'screen');
    await shell.locator('.edge-details li[data-edge-id="' + id + '"]').getByText(label, { exact: true }).waitFor();
  }

  const auto = edges.find(edge => edge.id === 'auto-redirect').evidence;
  assert.equal(auto.status, 'confirmed');
  assert.equal(auto.origin, undefined);
  assert.equal(auto.originReason, 'automatic');
  await shell.getByRole('button', { name: '/auto', exact: true }).click();
  await shell.locator('.edge-details li[data-edge-id="auto-redirect"]')
    .getByText('Источник стрелки · Экран · автоматический переход', { exact: true }).waitFor();
});
