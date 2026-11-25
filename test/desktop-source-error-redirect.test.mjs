import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, waitGraph, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('source data error redirect separates source failure from destination readiness while preserving target and telemetry controls', { timeout: 50_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      actions: [
        { id: 'late-target', source: 'route:/', target: 'route:/done', label: 'Late target 501',
          steps: [{ type: 'click', selector: '#late-target' }],
          expectRequests: [{ method: 'POST', path: '/api/answer', status: 200 }] },
        { id: 'telemetry-ok', source: 'route:/', target: 'route:/done', label: 'Telemetry 501',
          steps: [{ type: 'click', selector: '#telemetry-ok' }],
          expectRequests: [{ method: 'POST', path: '/api/answer', status: 200 }] }
      ],
      createMocks: () => async ({ path }) => {
        if (path === '/api/items' || path === '/api/answer') return { status: 200, body: { items: ['alpha'] } };
        if (path === '/api/broken' || path === '/api/details' || path === '/api/telemetry') {
          await new Promise(resolve => setTimeout(resolve, 650));
          return { status: 501, body: {} };
        }
        return { status: 501, body: {} };
      }
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Navigate, Routes, Route, useNavigate, useLocation, useParams} from 'react-router-dom';
      function Home() {
        const go = useNavigate();
        async function open(kind) {
          await fetch('/api/answer', { method: 'POST' });
          go('/done', { state: kind });
        }
        return <main><h1>Home</h1>
          <button id="late-target" onClick={() => open('details')}>Late target</button>
          <button id="telemetry-ok" onClick={() => open('telemetry')}>Telemetry</button>
        </main>;
      }
      function ItemDetail() {
        const { id = 'id-1' } = useParams();
        const [missing, setMissing] = React.useState(false);
        React.useEffect(() => {
          fetch('/api/items/' + id)
            .then(response => { if (!response.ok) setMissing(true); })
            .catch(() => setMissing(true));
        }, [id]);
        if (missing) return <Navigate to="/items" replace/>;
        return <div data-screen-canvas-loading>Loading detail…</div>;
      }
      function UnreadyDetail() {
        const { id = 'id-1' } = useParams();
        const [missing, setMissing] = React.useState(false);
        React.useEffect(() => {
          fetch('/api/items/' + id)
            .then(response => { if (!response.ok) setMissing(true); })
            .catch(() => setMissing(true));
        }, [id]);
        if (missing) return <Navigate to="/unready" replace/>;
        return <div data-screen-canvas-loading>Loading detail…</div>;
      }
      function AmbiguousDetail() {
        const { id = 'id-1' } = useParams();
        const [missing, setMissing] = React.useState(false);
        React.useEffect(() => {
          fetch('/api/items/' + id, { referrerPolicy: 'no-referrer' })
            .then(response => { if (!response.ok) setMissing(true); })
            .catch(() => setMissing(true));
        }, [id]);
        if (missing) return <Navigate to="/items" replace/>;
        return <div data-screen-canvas-loading>Loading detail…</div>;
      }
      function ItemsList() {
        const [items, setItems] = React.useState(null);
        React.useEffect(() => {
          fetch('/api/items').then(response => response.json()).then(data => setItems(data.items));
        }, []);
        if (!items) return <main data-screen-canvas-loading>Loading list…</main>;
        return <main><h1>Items</h1><p>{items.join(', ')}</p></main>;
      }
      function BrokenTarget() {
        const [failed, setFailed] = React.useState(false);
        React.useEffect(() => {
          fetch('/api/broken').then(response => { if (!response.ok) setFailed(true); });
        }, []);
        if (failed) return <main data-screen-canvas-error>Target data failed</main>;
        return <main><h1>Broken shell</h1></main>;
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
        if (failed) return <main data-screen-canvas-error>Done details failed</main>;
        return <main><h1>Done</h1></main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Home/>}/>
        <Route path="/items" element={<ItemsList/>}/>
        <Route path="/items/:id" element={<ItemDetail/>}/>
        <Route path="/items-unready/:id" element={<UnreadyDetail/>}/>
        <Route path="/items-ambiguous/:id" element={<AmbiguousDetail/>}/>
        <Route path="/unready" element={<main data-screen-canvas-loading>Still loading</main>}/>
        <Route path="/target-fail" element={<Navigate to="/broken" replace/>}/>
        <Route path="/broken" element={<BrokenTarget/>}/>
        <Route path="/done" element={<Done/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const graph = await waitGraph(shell, 40_000);
  const byPath = pathname => graph.nodes.find(node => node.path === pathname);

  // 1. Source data error -> catch redirect to ready /items.
  const sourceReady = byPath('/items/:id');
  assert.equal(sourceReady.screenshot, undefined);
  assert.equal(sourceReady.capture.outcome, 'blocked');
  assert.equal(sourceReady.capture.phase, 'request');
  assert.equal(sourceReady.capture.transition, 'source-error');
  assert.equal(sourceReady.capture.actualPath, '/items');
  assert.equal(sourceReady.capture.targetReady, true, JSON.stringify(sourceReady.capture));
  assert.equal(sourceReady.capture.sourceFailure?.message, 'GET /api/items/id-1 → 501');
  const sourceReadyEdge = graph.edges.find(edge => edge.source === 'route:/items/:id' && edge.target === 'route:/items');
  assert.equal(sourceReadyEdge.evidence.actualPath, '/items');
  assert.equal(sourceReadyEdge.evidence.transitionObserved, true);
  assert.equal(sourceReadyEdge.evidence.targetReady, true, JSON.stringify(sourceReadyEdge.evidence));
  assert.equal(sourceReadyEdge.evidence.targetReason, undefined);
  assert.equal(sourceReadyEdge.evidence.sourceFailure?.message, 'GET /api/items/id-1 → 501');

  const sourceCard = shell.getByRole('button', { name: '/items/:id', exact: true });
  await sourceCard.getByText('Переход после ошибки источника · /items', { exact: true }).waitFor();
  assert.equal(await sourceCard.locator('img').count(), 0);
  await sourceCard.click();
  await waitGuest(electron, "location.pathname === '/items' && document.querySelector('h1')?.textContent === 'Items'");
  const capturePanel = shell.locator('#details .capture-details');
  await capturePanel.getByText('Ошибка источника · GET /api/items/id-1 → 501', { exact: true }).waitFor();
  await capturePanel.getByText('Переход после ошибки источника', { exact: true }).waitFor();
  await capturePanel.getByText('Назначение готово', { exact: true }).waitFor();
  assert.equal(await capturePanel.getByText('Путь наблюдался, цель не готова').count(), 0);
  const edgeRow = shell.locator('.edge-details li[data-edge-id=' + JSON.stringify(sourceReadyEdge.id) + ']');
  await edgeRow.getByText('Цель перехода готова', { exact: true }).waitFor();
  await edgeRow.getByText('Ошибка источника · GET /api/items/id-1 → 501', { exact: true }).waitFor();

  // 2. Source data error -> catch redirect to unready /unready (must NOT claim readiness).
  const sourceUnready = byPath('/items-unready/:id');
  assert.equal(sourceUnready.screenshot, undefined);
  assert.equal(sourceUnready.capture.transition, 'source-error');
  assert.equal(sourceUnready.capture.targetReady, false);
  assert.equal(sourceUnready.capture.sourceFailure?.message, 'GET /api/items/id-1 → 501');
  await shell.getByRole('button', { name: '/items-unready/:id', exact: true }).click();
  await capturePanel.getByText('Готовность назначения не подтверждена', { exact: true }).waitFor();

  // 3. Ambiguous no-referrer 501 during redirect: confirmed facts only.
  const ambiguous = byPath('/items-ambiguous/:id');
  assert.equal(ambiguous.screenshot, undefined);
  assert.equal(ambiguous.capture.transition, 'observed-url');
  assert.equal(ambiguous.capture.targetReady, false);
  assert.equal(ambiguous.capture.sourceFailure, undefined);
  assert.equal(ambiguous.capture.unattributedFailure?.message, 'GET /api/items/id-1 → 501');
  await shell.getByRole('button', { name: '/items-ambiguous/:id', exact: true }).click();
  await capturePanel.getByText('Путь наблюдался, источник ошибки не определён', { exact: true }).waitFor();

  // 4. Control: direct redirect where target page fails with late 501.
  const targetFail = byPath('/target-fail');
  assert.equal(targetFail.screenshot, undefined);
  assert.equal(targetFail.capture.transition, 'observed-url');
  assert.equal(targetFail.capture.targetReady, false);
  assert.equal(targetFail.capture.sourceFailure, undefined);
  assert.equal(targetFail.capture.reason.message, 'GET /api/broken → 501');
  const targetFailEdge = graph.edges.find(edge => edge.source === 'route:/target-fail' && edge.target === 'route:/broken');
  assert.equal(targetFailEdge.evidence.targetReady, false);
  assert.equal(targetFailEdge.evidence.targetReason, 'GET /api/broken → 501');

  // 5. Controls: late 501 on target page at same URL vs background telemetry 501 on ready target.
  const lateTarget = graph.edges.find(edge => edge.id === 'late-target').evidence;
  assert.equal(lateTarget.requestCheck, 'verified');
  assert.equal(lateTarget.targetReady, false);
  assert.equal(lateTarget.targetReason, 'GET /api/details → 501');
  const telemetry = graph.edges.find(edge => edge.id === 'telemetry-ok').evidence;
  assert.equal(telemetry.status, 'confirmed');
  assert.equal(telemetry.requestCheck, 'verified');
  assert.equal(telemetry.targetReady, true);
  assert.equal(telemetry.backgroundFailure?.message, 'GET /api/telemetry → 501');
});
