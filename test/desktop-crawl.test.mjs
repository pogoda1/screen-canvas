import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('Chromium captures node content and proves distinct observed actions', { timeout: 45000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default { actions: [
      { id:'one', source:'route:/', target:'route:/next#index', role:'guest', condition:'One',
        label:'Continue', steps:[{type:'click',selector:'#one'}] },
      { id:'two', source:'route:/', target:'route:/next#index', role:'member', condition:'Two',
        label:'Continue', steps:[{type:'click',selector:'#two'}] },
      { id:'never', source:'route:/', target:'route:/next#index',
        label:'Unavailable', steps:[{type:'click',selector:'#never'}] }
    ] };`,
    'src/main.jsx': `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { BrowserRouter, Routes, Route, Link, Navigate, Outlet, useNavigate } from 'react-router-dom';
      function Home() {
        const navigate = useNavigate();
        return <main><h1>Home screen</h1><Link to="/next">Next screen</Link>
          <button id="one" onClick={() => navigate('/next')}>One</button>
          <button id="two" onClick={() => navigate('/next')}>Two</button></main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Home/>}/>
        <Route path="/old" element={<Navigate to="/next" replace/>}/>
        <Route path="/next" element={<><h1>Layout</h1><Outlet/></>}>
          <Route index element={<p>Index content</p>}/>
        </Route>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const deadline = Date.now() + 30_000;
  let state;
  while (Date.now() < deadline) {
    state = await shell.evaluate(() => screenCanvas.state());
    if (state.status === 'error') throw new Error(state.error);
    if (state.progress?.total && state.progress.total === state.progress.completed) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(state.progress?.completed, state.progress?.total);
  const { graph } = state;
  const index = graph.nodes.find(node => node.id === 'route:/next#index');
  const layout = graph.nodes.find(node => node.id === 'route:/next');
  assert.ok(index.screenshot?.startsWith('data:image/png;base64,iVBOR'));
  assert.ok(index.screenshot.length > 3000);
  assert.equal(layout.screenshot, undefined);
  assert.equal(layout.diagnostics.at(-1).code, 'different-screen');
  assert.equal(graph.edges.find(edge => edge.action === 'link').evidence.status, 'confirmed');
  assert.equal(graph.edges.find(edge => edge.action === 'redirect').evidence.status, 'confirmed');
  assert.equal(graph.edges.find(edge => edge.id === 'one').evidence.status, 'confirmed');
  assert.equal(graph.edges.find(edge => edge.id === 'two').evidence.status, 'confirmed');
  assert.match(graph.edges.find(edge => edge.id === 'never').evidence.reason, /unavailable/);
});
