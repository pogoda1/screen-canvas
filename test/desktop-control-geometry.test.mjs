import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, waitGraph, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('layout changes during frame capture use a screen origin and still click the real control', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      scenario: (node, mode) => ({ mode: mode ?? 'member' }),
      actions: [
        {id:'stable', source:'route:/stable'}, {id:'shifted', source:'route:/shift'},
        {id:'alternate', source:'route:/stable', role:'guest'}
      ].map(action => ({...action, label:action.id, target:'route:/done',
        steps:[{type:'click', selector:'#next'}],
        expectRequests:[{method:'POST',path:'/api/clicked',status:200}]})),
      createMocks: () => () => ({status:200,body:{}})
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route, useNavigate} from 'react-router-dom';
      function Start() {
        const go = useNavigate();
        async function click() {
          await fetch('/api/clicked',{method:'POST'});
          go('/done');
        }
        return <main><h1>Start</h1>
          <button id="next" style={{position:'absolute',left:40,top:145,width:100,height:42}} onClick={click}>Next</button>
          <p style={{position:'absolute',left:40,top:240,width:100,height:42,margin:0,pointerEvents:'none'}}>Visible caption</p>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/stable" element={<Start/>}/><Route path="/shift" element={<Start/>}/>
        <Route path="/done" element={<main><h1>Done</h1></main>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await electron.evaluate(({ app }) => {
    let frames = 0;
    app.on('browser-window-created', (_event, window) => {
      const contents = window.webContents;
      if (!contents.isOffscreen()) return;
      const capturePage = contents.capturePage.bind(contents);
      contents.capturePage = async (...args) => {
        const image = await capturePage(...args);
        if (new URL(contents.getURL()).pathname === '/shift' && ++frames === 2) {
          await contents.executeJavaScript("document.querySelector('#next').style.top = '240px'");
        }
        return image;
      };
    });
  });
  await pick(electron, shell, folder);
  const { edges } = await waitGraph(shell);
  for (const [id, path, reason] of [
    ['stable', '/stable', undefined], ['alternate', '/stable', 'different-scenario'],
    ['shifted', '/shift', 'control-not-in-frame']
  ]) {
    const { evidence } = edges.find(edge => edge.id === id);
    assert.equal(evidence.requestCheck, 'verified', JSON.stringify(evidence));
    assert.equal(evidence.actualPath, '/done');
    assert.equal(evidence.status, 'confirmed');
    await shell.getByRole('button', { name: path, exact: true }).click();
    await waitGuest(electron, 'Boolean(document.querySelector("#next"))');
    const arrow = shell.locator('#connections path[data-edge-id="' + id + '"]');
    const marker = shell.locator('#connection-origins [data-edge-id="' + id + '"]');
    const row = shell.locator('.edge-details li[data-edge-id="' + id + '"]');
    if (reason) {
      assert.equal(evidence.origin, undefined, JSON.stringify(evidence));
      assert.equal(evidence.originReason, reason);
      assert.equal(await arrow.getAttribute('data-origin'), 'screen');
      assert.equal(await marker.count(), 0);
      await row.getByText(/Источник стрелки · Экран/).waitFor();
    } else {
      assert.deepEqual(evidence.origin, {x:90 / 390, y:166 / 844});
      assert.equal(await arrow.getAttribute('data-origin'), 'control');
      assert.equal(await marker.count(), 1);
    }
  }
});
