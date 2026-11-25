import assert from 'node:assert/strict';
import test from 'node:test';
import { launchCanvas, pick, waitGraph, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('source error redirect distinguishes pre-navigation failure, late response, unknown XHR order, pending, unattributed requests, and verified automatic redirect telemetry', { timeout: 80_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      browser: '/bindings.js',
      actions: [
        { id: 'late-target', source: 'route:/', target: 'route:/done', label: 'Late target 501',
          steps: [{ type: 'click', selector: '#late-target' }],
          expectRequests: [{ method: 'POST', path: '/api/answer', status: 200 }] },
        { id: 'telemetry-ok', source: 'route:/', target: 'route:/done', label: 'Telemetry 501',
          steps: [{ type: 'click', selector: '#telemetry-ok' }],
          expectRequests: [{ method: 'POST', path: '/api/answer', status: 200 }] }
      ],
      createMocks: () => async ({ path }) => {
        if (path === '/api/items' || path === '/api/answer' || path === '/api/config') return { status: 200, body: { items: ['alpha'] } };
        if (path === '/api/broken' || path === '/api/details' || path === '/api/telemetry' ||
            path === '/api/source-late' || path === '/api/origin-fail' || path === '/api/items-fail') {
          await new Promise(resolve => setTimeout(resolve, 650));
          return { status: 501, body: {} };
        }
        if (path === '/api/source-pending') {
          await new Promise(resolve => setTimeout(resolve, 5500));
          return { status: 501, body: {} };
        }
        return { status: 501, body: {} };
      }
    };`,
    'bindings.js': `
      import { registerBrowserBindings } from 'react-screen-canvas/browser';
      registerBrowserBindings({
        captureReady() {
          if (location.pathname === '/items' || location.pathname === '/items-telemetry' || location.pathname === '/items-fail') {
            return Boolean(document.querySelector('[data-list-item]'));
          }
          return true;
        }
      });
    `,
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
      function XhrEarlyDetail() {
        const go = useNavigate();
        React.useEffect(() => {
          const xhr = new XMLHttpRequest();
          // Register listener BEFORE open() so it runs before bootstrap's listener.
          xhr.addEventListener('readystatechange', () => {
            if (xhr.readyState === 4 && xhr.status === 501) {
              history.replaceState(null, '', '/items');
              go('/items', { replace: true });
            }
          });
          xhr.open('GET', '/api/xhr-detail');
          xhr.send();
        }, [go]);
        return <div data-screen-canvas-loading>Loading XHR detail…</div>;
      }
      function LateSourceRedirect() {
        const [moved, setMoved] = React.useState(false);
        React.useEffect(() => {
          void fetch('/api/source-late');
          setMoved(true);
        }, []);
        if (moved) return <Navigate to="/items" replace/>;
        return <div data-screen-canvas-loading>Leaving…</div>;
      }
      function PendingSourceRedirect() {
        const [moved, setMoved] = React.useState(false);
        React.useEffect(() => {
          void fetch('/api/source-pending');
          setMoved(true);
        }, []);
        if (moved) return <Navigate to="/items" replace/>;
        return <div data-screen-canvas-loading>Leaving…</div>;
      }
      function UnattributedRedirect() {
        const [moved, setMoved] = React.useState(false);
        React.useEffect(() => {
          navigator.sendBeacon('/api/beacon-fail');
          setMoved(true);
        }, []);
        if (moved) return <Navigate to="/items" replace/>;
        return <div data-screen-canvas-loading>Leaving…</div>;
      }
      function ItemsList({ withTelemetry = false }) {
        const [items, setItems] = React.useState(null);
        React.useEffect(() => {
          fetch('/api/items').then(response => response.json()).then(data => setItems(data.items));
          if (withTelemetry) void fetch('/api/telemetry');
        }, [withTelemetry]);
        if (!items) return <main data-screen-canvas-loading>Loading list…</main>;
        return <main><h1>Items</h1><ul>{items.map(item => <li key={item} data-list-item="">{item}</li>)}</ul></main>;
      }
      function FailedItemsList() {
        const [failed, setFailed] = React.useState(false);
        React.useEffect(() => {
          void fetch('/api/config');
          fetch('/api/items-fail').then(response => { if (!response.ok) setFailed(true); });
        }, []);
        return <main><h1>Items</h1>{failed && <p role="alert">Не удалось загрузить список</p>}</main>;
      }
      function OriginTarget() {
        const [failed, setFailed] = React.useState(false);
        React.useEffect(() => {
          fetch('/api/origin-fail', { referrerPolicy: 'origin' }).then(response => {
            if (!response.ok) setFailed(true);
          });
        }, []);
        if (failed) return <main data-screen-canvas-error>Origin target failed</main>;
        return <main><h1>Origin target</h1></main>;
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
        <Route path="/items-telemetry" element={<ItemsList withTelemetry/>}/>
        <Route path="/items-fail" element={<FailedItemsList/>}/>
        <Route path="/items/:id" element={<ItemDetail/>}/>
        <Route path="/items-unready/:id" element={<UnreadyDetail/>}/>
        <Route path="/xhr-early" element={<XhrEarlyDetail/>}/>
        <Route path="/late-source" element={<LateSourceRedirect/>}/>
        <Route path="/pending-source" element={<PendingSourceRedirect/>}/>
        <Route path="/unattributed" element={<UnattributedRedirect/>}/>
        <Route path="/auto-telemetry" element={<Navigate to="/items-telemetry" replace/>}/>
        <Route path="/auto-list-fail" element={<Navigate to="/items-fail" replace/>}/>
        <Route path="/to-origin" element={<Navigate to="/origin-target" replace/>}/>
        <Route path="/origin-target" element={<OriginTarget/>}/>
        <Route path="/unready" element={<main data-screen-canvas-loading>Still loading</main>}/>
        <Route path="/target-fail" element={<Navigate to="/broken" replace/>}/>
        <Route path="/broken" element={<BrokenTarget/>}/>
        <Route path="/done" element={<Done/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const graph = await waitGraph(shell, 55_000);
  const byPath = pathname => graph.nodes.find(node => node.path === pathname);
  const capturePanel = shell.locator('#details .capture-details');

  // 1. Pre-navigation source data error -> catch redirect to ready /items.
  const sourceReady = byPath('/items/:id');
  assert.equal(sourceReady.screenshot, undefined);
  assert.equal(sourceReady.capture.outcome, 'blocked');
  assert.equal(sourceReady.capture.transition, 'source-error');
  assert.equal(sourceReady.capture.actualPath, '/items');
  assert.equal(sourceReady.capture.targetReady, true, JSON.stringify(sourceReady.capture));
  assert.equal(sourceReady.capture.sourceFailure?.message, 'GET /api/items/id-1 → 501');
  const sourceReadyEdge = graph.edges.find(edge => edge.source === 'route:/items/:id' && edge.target === 'route:/items');
  assert.equal(sourceReadyEdge.evidence.targetReady, true, JSON.stringify(sourceReadyEdge.evidence));
  assert.equal(sourceReadyEdge.evidence.targetReason, undefined);
  assert.equal(sourceReadyEdge.evidence.sourceFailure?.message, 'GET /api/items/id-1 → 501');

  const sourceCard = shell.getByRole('button', { name: '/items/:id', exact: true });
  await sourceCard.getByText('Переход после ошибки источника · /items', { exact: true }).waitFor();
  assert.equal(await sourceCard.locator('img').count(), 0);
  await sourceCard.click();
  await waitGuest(electron, "location.pathname === '/items' && document.querySelector('h1')?.textContent === 'Items'");
  await capturePanel.getByText('Ошибка источника · GET /api/items/id-1 → 501', { exact: true }).waitFor();
  await capturePanel.getByText('Переход после ошибки источника', { exact: true }).waitFor();
  await capturePanel.getByText('Назначение готово', { exact: true }).waitFor();
  assert.equal(await capturePanel.getByText('Путь наблюдался, цель не готова').count(), 0);

  // 2. Pre-navigation source data error -> catch redirect to unready /unready.
  const sourceUnready = byPath('/items-unready/:id');
  assert.equal(sourceUnready.screenshot, undefined);
  assert.equal(sourceUnready.capture.transition, 'source-error');
  assert.equal(sourceUnready.capture.targetReady, false);
  await shell.getByRole('button', { name: '/items-unready/:id', exact: true }).click();
  await capturePanel.getByText('Готовность назначения не подтверждена', { exact: true }).waitFor();

  // 3. XHR with early listener before open() keeps order unknown (never mislabeled late).
  const xhrEarly = byPath('/xhr-early');
  assert.equal(xhrEarly.screenshot, undefined);
  assert.equal(xhrEarly.capture.sourceFailure, undefined, JSON.stringify(xhrEarly.capture));
  assert.equal(xhrEarly.capture.lateSourceFailure, undefined, JSON.stringify(xhrEarly.capture));
  assert.equal(xhrEarly.capture.unorderedSourceFailure?.message, 'GET /api/xhr-detail → 501');
  assert.notEqual(xhrEarly.capture.transition, 'source-error');
  await shell.getByRole('button', { name: '/xhr-early', exact: true }).click();
  await capturePanel.getByText('Ошибка источника (порядок с переходом не подтверждён) · GET /api/xhr-detail → 501', { exact: true }).waitFor();
  assert.equal(await capturePanel.getByText('Поздний ответ источника после перехода').count(), 0);

  // 3b. Late source 501 arriving AFTER navigation must NOT say source-error.
  const lateSource = byPath('/late-source');
  assert.equal(lateSource.screenshot, undefined);
  assert.equal(lateSource.capture.sourceFailure, undefined, JSON.stringify(lateSource.capture));
  assert.equal(lateSource.capture.lateSourceFailure?.message, 'GET /api/source-late → 501');
  assert.equal(lateSource.capture.targetReady, true);
  assert.notEqual(lateSource.capture.transition, 'source-error');
  await shell.getByRole('button', { name: '/late-source', exact: true }).click();
  await capturePanel.getByText('Поздний ответ источника после перехода · GET /api/source-late → 501', { exact: true }).waitFor();
  await capturePanel.getByText('Наблюдался переход; ответ источника пришёл после перехода', { exact: true }).waitFor();
  assert.equal(await capturePanel.getByText('Переход после ошибки источника').count(), 0);

  // 4. Pending source request must NOT say source-error.
  const pendingSource = byPath('/pending-source');
  assert.equal(pendingSource.screenshot, undefined);
  assert.equal(pendingSource.capture.sourceFailure, undefined, JSON.stringify(pendingSource.capture));
  assert.equal(pendingSource.capture.sourcePending, true);
  assert.notEqual(pendingSource.capture.transition, 'source-error');
  await shell.getByRole('button', { name: '/pending-source', exact: true }).click();
  await capturePanel.getByText('Запрос источника не завершился вовремя', { exact: true }).waitFor();
  await capturePanel.getByText('Наблюдался переход; запрос источника не завершился', { exact: true }).waitFor();

  // 5. Origin-only Referer on target route stays attributed to the target route, never the source.
  const originTarget = byPath('/to-origin');
  assert.equal(originTarget.screenshot, undefined);
  assert.equal(originTarget.capture.sourceFailure, undefined, JSON.stringify(originTarget.capture));
  assert.equal(originTarget.capture.targetReady, false);
  assert.equal(originTarget.capture.transition, 'observed-url');
  assert.equal(originTarget.capture.reason.message, 'GET /api/origin-fail → 501');

  // 6. Unattributed sendBeacon 501 during redirect reports confirmed facts only.
  const unattributed = byPath('/unattributed');
  assert.equal(unattributed.screenshot, undefined);
  assert.equal(unattributed.capture.targetReady, false);
  assert.equal(unattributed.capture.sourceFailure, undefined);
  assert.equal(unattributed.capture.unattributedFailure?.message, 'POST /api/beacon-fail → 501');
  await shell.getByRole('button', { name: '/unattributed', exact: true }).click();
  await capturePanel.getByText('Путь наблюдался, источник ошибки не определён', { exact: true }).waitFor();

  // 7. Automatic redirect to ready list (200) + background telemetry 501 preserves readiness.
  const autoTelemetry = byPath('/auto-telemetry');
  assert.equal(autoTelemetry.screenshot, undefined);
  assert.equal(autoTelemetry.capture.transition, 'verified', JSON.stringify(autoTelemetry.capture));
  assert.equal(autoTelemetry.capture.targetReady, true);
  assert.equal(autoTelemetry.capture.backgroundFailure?.message, 'GET /api/telemetry → 501');
  const autoTelemetryEdge = graph.edges.find(edge => edge.source === 'route:/auto-telemetry' && edge.target === 'route:/items-telemetry');
  assert.equal(autoTelemetryEdge.evidence.status, 'confirmed', JSON.stringify(autoTelemetryEdge.evidence));
  assert.equal(autoTelemetryEdge.evidence.targetReady, true);
  assert.equal(autoTelemetryEdge.evidence.backgroundFailure?.message, 'GET /api/telemetry → 501');
  await shell.getByRole('button', { name: '/auto-telemetry', exact: true }).click();
  await capturePanel.getByText('Фоновая ошибка · GET /api/telemetry → 501', { exact: true }).waitFor();
  await capturePanel.getByText('Переход подтверждён', { exact: true }).waitFor();

  // 8. Paired counterexamples: blocking target list failure (with service 200 + role="alert", and /target-fail -> /broken).
  const autoListFail = byPath('/auto-list-fail');
  assert.equal(autoListFail.screenshot, undefined);
  assert.equal(autoListFail.capture.transition, 'observed-url');
  assert.equal(autoListFail.capture.targetReady, false);
  assert.equal(autoListFail.capture.backgroundFailure, undefined);
  assert.equal(autoListFail.capture.reason.message, 'GET /api/items-fail → 501');
  const autoListFailEdge = graph.edges.find(edge => edge.source === 'route:/auto-list-fail' && edge.target === 'route:/items-fail');
  assert.equal(autoListFailEdge.evidence.targetReady, false);
  assert.equal(autoListFailEdge.evidence.targetReason, 'GET /api/items-fail → 501');
  assert.equal(autoListFailEdge.evidence.backgroundFailure, undefined);

  const targetFail = byPath('/target-fail');
  assert.equal(targetFail.screenshot, undefined);
  assert.equal(targetFail.capture.transition, 'observed-url');
  assert.equal(targetFail.capture.targetReady, false);
  assert.equal(targetFail.capture.backgroundFailure, undefined);
  assert.equal(targetFail.capture.reason.message, 'GET /api/broken → 501');
  const targetFailEdge = graph.edges.find(edge => edge.source === 'route:/target-fail' && edge.target === 'route:/broken');
  assert.equal(targetFailEdge.evidence.targetReady, false);
  assert.equal(targetFailEdge.evidence.targetReason, 'GET /api/broken → 501');

  // 9. S02 click controls remain intact.
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

test('origin-only Referer, stale keepalive, and unverified service-200 + alert-list never misattribute or falsely confirm readiness', { timeout: 45_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      captureRules: [
        { source: 'route:/', target: 'route:/done', path: '/done' },
        { source: 'route:/full-old', target: 'route:/full-new', path: '/full-new' }
      ],
      createMocks: () => async ({ path }) => {
        if (path === '/api/new-data' || path === '/api/config') return { status: 200, body: { ok: true } };
        if (path === '/api/old-keepalive') {
          await new Promise(resolve => setTimeout(resolve, 600));
          return { status: 501, body: {} };
        }
        return { status: 501, body: {} };
      }
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Navigate, Routes, Route} from 'react-router-dom';
      function Done() {
        const [failed, setFailed] = React.useState(false);
        React.useEffect(() => {
          fetch('/api/done-origin', { referrerPolicy: 'origin' }).then(response => {
            if (!response.ok) setFailed(true);
          });
        }, []);
        if (failed) return <main data-screen-canvas-error>Done failed</main>;
        return <main><h1>Done</h1></main>;
      }
      function FullOld() {
        React.useEffect(() => {
          void fetch('/api/old-keepalive', { keepalive: true, referrerPolicy: 'no-referrer' });
          window.location.assign('/full-new');
        }, []);
        return <main data-screen-canvas-loading>Leaving…</main>;
      }
      function FullNew() {
        const [ready, setReady] = React.useState(false);
        React.useEffect(() => {
          fetch('/api/new-data').then(() => setReady(true));
        }, []);
        if (!ready) return <main data-screen-canvas-loading>Loading new…</main>;
        return <main><h1>Full new</h1></main>;
      }
      function AlertList() {
        const [failed, setFailed] = React.useState(false);
        React.useEffect(() => {
          void fetch('/api/config');
          fetch('/api/list').then(response => { if (!response.ok) setFailed(true); });
        }, []);
        return <main><h1>Items</h1>{failed && <p role="alert">Не удалось загрузить список</p>}</main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Navigate to="/done" replace/>}/>
        <Route path="/done" element={<Done/>}/>
        <Route path="/full-old" element={<FullOld/>}/>
        <Route path="/full-new" element={<FullNew/>}/>
        <Route path="/to-alert" element={<Navigate to="/alert-list" replace/>}/>
        <Route path="/alert-list" element={<AlertList/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const graph = await waitGraph(shell, 35_000);
  const byPath = pathname => graph.nodes.find(node => node.path === pathname);

  // SPA / -> /done where /done uses referrerPolicy:'origin': must be attributed to /done, NEVER /.
  const root = byPath('/');
  assert.equal(root.screenshot, undefined);
  assert.equal(root.capture.sourceFailure, undefined, JSON.stringify(root.capture));
  assert.equal(root.capture.lateSourceFailure, undefined, JSON.stringify(root.capture));
  assert.equal(root.capture.targetReady, false);
  assert.equal(root.capture.transition, 'observed-url');
  assert.equal(root.capture.reason.message, 'GET /api/done-origin → 501');

  // Full navigation /full-old -> /full-new with delayed keepalive from /full-old:
  // must NOT blame /full-new and must NOT claim transition happened after source error.
  const fullOld = byPath('/full-old');
  assert.equal(fullOld.screenshot, undefined);
  assert.equal(fullOld.capture.sourceFailure, undefined, JSON.stringify(fullOld.capture));
  assert.notEqual(fullOld.capture.transition, 'source-error');
  assert.equal(fullOld.capture.lateSourceFailure?.message, 'GET /api/old-keepalive → 501');
  assert.equal(fullOld.capture.targetReady, true);

  // Generic neutral page (no adapter captureReady) with service GET /api/config 200 + GET /api/list 501 + role="alert":
  // must NOT downgrade 501 to backgroundFailure and must NOT confirm targetReady.
  const toAlert = byPath('/to-alert');
  assert.equal(toAlert.screenshot, undefined);
  assert.equal(toAlert.capture.outcome, 'blocked');
  assert.equal(toAlert.capture.transition, 'observed-url');
  assert.equal(toAlert.capture.targetReady, false, JSON.stringify(toAlert.capture));
  assert.equal(toAlert.capture.backgroundFailure, undefined);
  assert.equal(toAlert.capture.reason.message, 'GET /api/list → 501');
  const alertEdge = graph.edges.find(edge => edge.source === 'route:/to-alert' && edge.target === 'route:/alert-list');
  assert.equal(alertEdge.evidence.targetReady, false, JSON.stringify(alertEdge.evidence));
  assert.equal(alertEdge.evidence.targetReason, 'GET /api/list → 501');
  assert.equal(alertEdge.evidence.backgroundFailure, undefined);
});
