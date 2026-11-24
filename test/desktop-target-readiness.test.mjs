import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, waitGraph, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('a late target failure updates readiness separately from the proved POST', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      actions: [['error', '/done'], ['loading', '/done'], ['telemetry', '/done']].map(([name, path]) => ({
        id: name, label: name, source: 'route:/', target: 'route:' + path,
        steps: [{type:'click', selector:'#' + name}],
        expectRequests: [{method:'POST', path:'/api/answer', status:200}]
      })),
      createMocks: () => async ({path}) => {
        if (path !== '/api/answer') await new Promise(resolve => setTimeout(resolve, 650));
        return {status:path === '/api/answer' ? 200 : 501, body:{}};
      }
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route, useNavigate, useLocation} from 'react-router-dom';
      function Start() {
        const go = useNavigate();
        async function open(kind) {
          await fetch('/api/answer', {method:'POST'});
          go('/done', {state:kind});
        }
        return <main><h1>Start</h1>{['error','loading','telemetry'].map(kind =>
          <button key={kind} id={kind} onClick={() => open(kind)}>{kind}</button>)}</main>;
      }
      function Done() {
        const kind = useLocation().state;
        const [failed, setFailed] = React.useState(false);
        React.useEffect(() => {
          if (!kind) return;
          fetch(kind === 'telemetry' ? '/api/telemetry' : '/api/details').then(response => {
            if (!response.ok && kind !== 'telemetry') setFailed(true);
          });
        }, [kind]);
        if (failed && kind === 'error') return <main data-screen-canvas-error>Details failed</main>;
        return <main><h1>Done</h1>{failed && <aside data-screen-canvas-loading>Details unavailable</aside>}</main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Start/>}/><Route path="/done" element={<Done/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const { edges } = await waitGraph(shell);
  await shell.getByRole('button', { name: '/', exact: true }).click();
  await waitGuest(electron, 'Boolean(document.querySelector("#error"))');
  for (const kind of ['error', 'loading', 'telemetry']) {
    const { evidence } = edges.find(edge => edge.id === kind);
    assert.equal(evidence.actualPath, '/done');
    assert.equal(evidence.transitionObserved, true);
    assert.equal(evidence.requestCheck, 'verified');
    assert.equal(evidence.targetReady, kind === 'telemetry', JSON.stringify(evidence));
    const row = shell.locator('.edge-details li[data-edge-id="' + kind + '"]');
    await row.getByText('Заявленный обмен подтверждён', { exact: true }).waitFor();
    await row.getByText('Наблюдаемый путь · /done', { exact: true }).waitFor();
    if (kind === 'telemetry') {
      assert.equal(evidence.status, 'confirmed');
      await row.getByText('Цель перехода готова', { exact: true }).waitFor();
      await row.getByText('Фоновая ошибка · GET /api/telemetry → 501', { exact: true }).waitFor();
    } else {
      assert.match(evidence.targetReason, /GET \/api\/details → 501/);
      assert.equal(evidence.backgroundFailure, undefined);
      await row.getByText('Готовность цели перехода не подтверждена', { exact: true }).waitFor();
      await row.getByText(/GET \/api\/details → 501/).waitFor();
    }
  }
});
