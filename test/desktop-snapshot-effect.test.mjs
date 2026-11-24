import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, waitGraph, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('a delayed snapshot effect confirms only a real change on the same screen', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      browser:'/bindings.js',
      scenario: () => ({data:{value:'initial'}}),
      actions: [
        {id:'delayed', value:'changed'}, {id:'noop', value:'changed'}, {id:'already', value:'initial'}
      ].map(({id,value}) => ({id, label:id, source:'route:/', target:'route:/',
        steps:[{type:'click',selector:'#' + id}], expectSnapshot:{data:{value}}}))
    };`,
    'bindings.js': `
      import {registerBrowserBindings} from 'react-screen-canvas/browser';
      registerBrowserBindings({read: scenario => ({...scenario, data:{value:document.querySelector('output').textContent}})});
    `,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route} from 'react-router-dom';
      function Form() {
        const [value, setValue] = React.useState('initial');
        return <main><h1>Editor</h1><output>{value}</output>
          <button id="delayed" onClick={() => setTimeout(() => setValue('changed'), 300)}>Change</button>
          <button id="noop" onClick={() => {}}>No change</button>
          <button id="already" onClick={() => {}}>Already true</button>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Form/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const { edges } = await waitGraph(shell);
  await shell.getByRole('button', { name: '/', exact: true }).click();
  await waitGuest(electron, 'document.querySelector("output")?.textContent === "initial"');
  const evidence = id => edges.find(edge => edge.id === id).evidence;
  assert.equal(evidence('delayed').status, 'confirmed', JSON.stringify(evidence('delayed')));
  assert.equal(evidence('delayed').actionEffect, true);
  assert.equal(evidence('delayed').transitionObserved, undefined);
  await shell.locator('li[data-edge-id="delayed"]').getByText('Эффект на текущем экране подтверждён').first().waitFor();
  assert.equal(await shell.locator('#connections path[data-edge-id="delayed"]').count(), 1);
  for (const id of ['noop', 'already']) {
    assert.equal(evidence(id).status, 'unverified');
    assert.equal(evidence(id).actionEffect, undefined);
    assert.equal(await shell.locator('#connections path[data-edge-id="' + id + '"]').count(), 0);
  }
});
