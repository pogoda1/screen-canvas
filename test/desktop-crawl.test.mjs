import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchCanvas, pick, waitGraph, waitGuest } from './helpers/electron.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('Chromium captures node content and proves distinct observed actions', { timeout: 45000 }, async t => {
  const folder = await makeHost(t, {
    'public/spinner.gif': Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
    'screen-canvas.config.mjs': `export default {
      createMocks: () => ({ path }) => path === '/api/answer' ? { body: { ok: true } } : undefined,
      actions: [
      { id:'wrong-doc', source:'route:/privacy', target:'route:/legal/:document', label:'Wrong legal document',
        expectedPath:'/legal/offer', steps:[{type:'redirect'}] },
      { id:'wrong-answer', source:'route:/', target:'route:/next#index', label:'Wrong answer',
        expectRequests:[{method:'POST',path:'/api/answer',status:200,body:{value:'expected'}}],
        steps:[{type:'click',selector:'#answer'}] },
      { id:'accepted-answer', source:'route:/', target:'route:/next#index', label:'Expected answer',
        displayValues:['observed',15,false,{ token:'not for display' }],
        expectRequests:[{method:'POST',path:'/api/answer',status:200,body:{
          value:'observed', target:'answer-label', trusted:true,
          sequence:['pointerdown','mousedown','pointerup','mouseup','click']}}],
        steps:[{type:'click',selector:'#answer'}] },
      { id:'wrong-destination', source:'route:/', target:'route:/next#index', label:'Wrong destination',
        expectedPath:'/next', steps:[{type:'click',selector:'#wrong-destination'}] },
      { id:'covered', source:'route:/', target:'route:/next#index',
        label:'Covered control', steps:[{type:'click',selector:'#covered'}] },
      { id:'nested-blocker', source:'route:/', target:'route:/next#index',
        label:'Intercepted label', steps:[{type:'click',selector:'#parent'}] },
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
        const sequence = React.useRef([]);
        const record = event => sequence.current.push(event.type);
        const submit = event => {
          record(event);
          void fetch('/api/telemetry');
          return fetch('/api/answer', { method: 'POST', body: JSON.stringify({
            value:'observed', target:event.target.id, trusted:event.nativeEvent.isTrusted, sequence:sequence.current
          }) }).then(() => setTimeout(() => navigate('/next'), 650));
        };
        return <main><h1>Home screen</h1><Link to="/next">Next screen</Link>
          <button id="one" onClick={() => navigate('/next')}>One</button>
          <button id="two" onClick={() => navigate('/next')}>Two</button>
          <button id="wrong-destination" onClick={() => setTimeout(() => navigate('/about'), 650)}>About</button>
          <div style={{position:'relative',width:'max-content'}}>
            <button id="covered" onClick={submit}>Covered</button>
            <span aria-hidden="true" style={{position:'absolute',inset:0}}/>
          </div>
          <button id="parent" onClick={submit}>
            <span style={{display:'block'}} onClick={event => event.stopPropagation()}>Intercepted answer</span>
          </button>
          <button id="answer" onPointerDown={record} onMouseDown={record} onPointerUp={record} onMouseUp={record}
            onClick={submit}><span id="answer-label" style={{display:'block'}}>Answer</span></button></main>;
      }
      function Broken() { throw new Error('Broken route render'); }
      function Deferred() {
        const [pending, setPending] = React.useState(true);
        React.useEffect(() => { const timer = setTimeout(() => setPending(false), 380); return () => clearTimeout(timer); }, []);
        return pending ? <main aria-busy="true">Loading…</main> : <main>Deferred content</main>;
      }
      class Boundary extends React.Component {
        static getDerivedStateFromError() { return { error: true }; }
        render() { return this.state?.error ? <h1 data-screen-canvas-error>Route failed</h1> : this.props.children; }
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<Home/>}/>
        <Route path="/broken" element={<Boundary><Broken /></Boundary>}/>
        <Route path="/loading" element={<div data-screen-canvas-loading><h1>Loading</h1></div>}/>
        <Route path="/text-loading" element={<p>Loading…</p>}/>
        <Route path="/decorative-loading" element={<main><p>Loading…</p><img alt="" src="/spinner.gif"/></main>}/>
        <Route path="/busy" element={<main aria-busy="true">Getting the screen ready</main>}/>
        <Route path="/local-busy" element={<main><h1>Ready catalog</h1><aside aria-busy="true">Loading…</aside></main>}/>
        <Route path="/image" element={<main><img alt="Product preview" src="/spinner.gif"/></main>}/>
        <Route path="/deferred" element={<Deferred/>}/>
        <Route path="/about" element={<main>About</main>}/>
        <Route path="/empty" element={<main><h1>Product</h1></main>}>
          <Route index element={<main><h1>Product</h1></main>}/>
        </Route>
        <Route path="/legal/:document" element={<h1>Legal document</h1>}/>
        <Route path="/privacy" element={<Navigate to="/legal/privacy" replace/>}/>
        <Route path="/old" element={<Navigate to="/next" replace/>}/>
        <Route path="/next" element={<><h1>Layout</h1><Outlet/></>}>
          <Route index element={<main><h1>Product</h1></main>}/>
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
  assert.equal(state.progress?.completed, state.progress?.total, JSON.stringify(
    state.graph?.nodes.map(({ id, diagnostics, screenshot }) => [id, diagnostics, !!screenshot])
  ));
  const { graph } = state;
  const index = graph.nodes.find(node => node.id === 'route:/next#index');
  const layout = graph.nodes.find(node => node.id === 'route:/next');
  assert.ok(index.screenshot?.startsWith('data:image/png;base64,iVBOR'));
  assert.ok(index.screenshot.length > 3000);
  for (const id of ['route:/about', 'route:/deferred', 'route:/local-busy', 'route:/image']) {
    const node = graph.nodes.find(item => item.id === id);
    assert.ok(node.screenshot?.startsWith('data:image/png;base64,iVBOR'), id);
    assert.deepEqual(node.diagnostics, [], id);
  }
  assert.equal(layout.screenshot, undefined);
  assert.equal(layout.diagnostics.at(-1).code, 'different-screen');
  for (const [id, diagnostic] of [
    ['route:/broken', 'render-error'], ['route:/loading', 'loading-timeout'],
    ['route:/text-loading', 'loading-timeout'], ['route:/decorative-loading', 'loading-timeout'], ['route:/busy', 'loading-timeout'],
    ['route:/empty#index', 'index-unmounted']
  ]) {
    const node = graph.nodes.find(item => item.id === id);
    assert.equal(Boolean(node.screenshot), false, id);
    assert.equal(node.diagnostics.at(-1).code, diagnostic, id);
  }
  assert.equal(graph.edges.find(edge => edge.action === 'link').evidence.status, 'confirmed');
  assert.equal(graph.edges.find(edge => edge.action === 'redirect').evidence.status, 'confirmed');
  assert.equal(graph.edges.find(edge => edge.id === 'one').evidence.status, 'confirmed');
  assert.equal(graph.edges.find(edge => edge.id === 'two').evidence.status, 'confirmed');
  const answer = graph.edges.find(edge => edge.id === 'accepted-answer').evidence;
  assert.equal(answer.status, 'confirmed', JSON.stringify(answer));
  assert.equal(answer.actualTarget, 'route:/next#index');
  assert.deepEqual(answer.requests.filter(request => request.method === 'POST'),
    [{ method: 'POST', path: '/api/answer', status: 200 }]);
  assert.ok(answer.requests.some(request => request.path === '/api/telemetry' && request.status === 501));
  assert.equal(answer.targetReady, true);
  assert.equal(answer.transitionObserved, true);
  assert.match(graph.edges.find(edge => edge.id === 'wrong-answer').evidence.reason, /submitted answer/);
  const wrongDestination = graph.edges.find(edge => edge.id === 'wrong-destination').evidence;
  assert.equal(wrongDestination.status, 'unverified');
  assert.equal(wrongDestination.actualTarget, 'route:/about');
  const covered = graph.edges.find(edge => edge.id === 'covered').evidence;
  assert.equal(covered.status, 'unverified');
  assert.ok(!covered.requests.some(request => request.method === 'POST'));
  assert.match(covered.reason, /unavailable/);
  const blocked = graph.edges.find(edge => edge.id === 'nested-blocker').evidence;
  assert.equal(blocked.status, 'unverified', JSON.stringify(blocked));
  assert.equal(blocked.actualPath, '/');
  assert.ok(!blocked.requests.some(request => request.method === 'POST'));
  const wrongDoc = graph.edges.find(edge => edge.id === 'wrong-doc').evidence;
  assert.equal(wrongDoc.status, 'unverified');
  assert.equal(wrongDoc.actualPath, '/legal/privacy');
  assert.equal(wrongDoc.expectedPath, '/legal/offer');
  assert.match(graph.edges.find(edge => edge.id === 'never').evidence.reason, /unavailable/);
  await shell.getByRole('button', { name: '/', exact: true }).click();
  const proven = shell.locator('.edge-details [data-edge-id="accepted-answer"]');
  for (const value of ['"observed"', '15', 'false']) {
    await proven.getByText('Ответ · ' + value, { exact: true }).waitFor();
  }
  assert.doesNotMatch(await proven.innerText(), /not for display|answer-label/);
});

test('capture waits for painted content in the current document without gating live readiness', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      browser: '/src/bindings.js',
      nodes: ['first', 'second'].map(step => ({
        id: 'route:/steps#' + step, path: '/steps', state: step, label: step
      }))
    };`,
    'src/bindings.js': `
      import { registerBrowserBindings } from 'react-screen-canvas/browser';
      registerBrowserBindings({
        ready: () => Boolean(document.querySelector('h1')),
        identify: () => document.querySelector('[data-step]')?.dataset.step,
        captureReady: () => {
          if (location.pathname === '/indeterminate') return new Promise(() => {});
          return !document.querySelector('[data-cover]') && location.pathname !== '/live';
        }
      });
    `,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route} from 'react-router-dom';
      import { getInitialScenario } from 'react-screen-canvas/browser';
      function Covered() {
        const [covered, setCovered] = React.useState(true);
        React.useEffect(() => {
          const timer = setTimeout(() => requestAnimationFrame(() => setCovered(false)), 550);
          return () => clearTimeout(timer);
        }, []);
        return <main style={{background:'#12b456',position:'fixed',inset:0}}>
          <h1>Covered screen</h1>
          {covered && <div data-cover style={{background:'#ba2040',position:'fixed',inset:0}}>Starting</div>}
        </main>;
      }
      function Reload() {
        const second = sessionStorage.getItem('reloaded');
        return <main style={{background:second ? '#12b456' : '#ba2040',position:'fixed',inset:0}}>
          <h1>{second ? 'Current document' : 'Original document'}</h1>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/covered" element={<Covered/>}/>
        <Route path="/reload" element={<Reload/>}/>
        <Route path="/steps" element={<main data-step={getInitialScenario()?.nodeId}><h1>Step</h1></main>}/>
        <Route path="/live" element={<main><h1>Live form</h1><input aria-label="Name"/></main>}/>
        <Route path="/indeterminate" element={<h1>Unsettled capture hook</h1>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  // Interleave a real reload with a real Chromium capture at the same pathname.
  await electron.evaluate(({ app }) => {
    app.on('browser-window-created', (_event, window) => {
      const contents = window.webContents;
      if (!contents.isOffscreen()) return;
      const capturePage = contents.capturePage.bind(contents);
      let reloaded = false;
      contents.capturePage = async (...args) => {
        const image = await capturePage(...args);
        if (!reloaded && new URL(contents.getURL()).pathname === '/reload') {
          reloaded = true;
          await contents.executeJavaScript("sessionStorage.setItem('reloaded', '1')");
          contents.reloadIgnoringCache();
        }
        if (new URL(contents.getURL()).pathname === '/steps') {
          await contents.executeJavaScript(
            "document.querySelector('[data-step]').dataset.step = 'route:/steps#second'"
          );
        }
        return image;
      };
    });
  });
  const start = performance.now();
  await pick(electron, shell, folder);
  await shell.getByRole('button', { name: '/live', exact: true }).click();
  assert.equal(await waitGuest(electron, "document.querySelector('h1')?.textContent === 'Live form'"), true);
  const live = await waitGuest(electron, "globalThis.__screenCanvasStatus?.().then(status => status.ready)");
  assert.equal(live, true);
  let state;
  // Seven nodes, two scan slots. The 4 s UI phase bounds a stalled hook.
  // 20 s leaves room for the remaining waves and cold Vite/Electron startup.
  while (performance.now() - start < 20_000) {
    state = await shell.evaluate(() => screenCanvas.state());
    if (state.status === 'error') throw new Error(state.error);
    if (state.progress?.total && state.progress.total === state.progress.completed) break;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  t.diagnostic('Chromium scan elapsed ' + Math.round(performance.now() - start) + ' ms');
  assert.ok(state.progress?.total);
  assert.equal(state.progress.completed, state.progress.total);
  const byId = id => state.graph.nodes.find(node => node.id === 'route:' + id);
  for (const id of ['/covered', '/reload']) {
    const { screenshot, diagnostics } = byId(id);
    assert.deepEqual(diagnostics, [], id);
    assert.ok(screenshot, id);
    const pixel = await electron.evaluate(({ nativeImage }, source) => {
      const image = nativeImage.createFromDataURL(source);
      const bitmap = image.toBitmap();
      return [...bitmap.subarray(0, 4)];
    }, screenshot);
    assert.equal(pixel[1], 180, id + ' shows the unobstructed green frame: ' + pixel);
  }
  assert.equal(byId('/live').screenshot, undefined);
  assert.equal(byId('/live').diagnostics.at(-1).code, 'capture-not-ready');
  assert.equal(byId('/indeterminate').screenshot, undefined);
  assert.equal(byId('/steps#first').screenshot, undefined);
  assert.equal(byId('/steps#first').diagnostics.at(-1).code, 'different-screen');
  assert.ok(byId('/steps#second').screenshot);
});

test('Chromium reports expected destinations and request failures independently', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      captureRules: [
        { source:'route:/entry', role:'member', target:'route:/detail/:slug', path:'/detail/first' },
        { source:'route:/wrong', target:'route:/detail/:slug', path:'/detail/first' },
        { source:'route:/blocked', target:'route:/detail/:slug', path:'/detail/blocked' },
        { source:'route:/result', target:'route:/result', path:'/result', state:'Unverified result' }
      ],
      scenario: node => node.id === 'route:/entry' ? {mode:'member'} : {},
      createMocks: () => ({path}) => path === '/api/session' ? {status:401,body:{}} : undefined,
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route, useNavigate, useParams} from 'react-router-dom';
      function Entry({target}) {
        const navigate = useNavigate();
        React.useEffect(() => { navigate(target); }, [navigate, target]);
        return null;
      }
      function Detail() {
        const {slug} = useParams();
        React.useEffect(() => {
          if (slug !== 'blocked') return;
          void fetch('/api/resource?code=secret-query', {headers:{'x-extra':'secret-header'}}).then(() => {
            const script = document.createElement('script');
            script.src = 'https://example.invalid/tracker?code=secret-console';
            document.head.append(script);
          });
        }, [slug]);
        return slug === 'blocked' ? <main aria-busy="true">Loading…</main> : <main><h1>{slug}</h1></main>;
      }
      function Signin() {
        React.useEffect(() => { void fetch('/api/session'); }, []);
        return <main><h1>Sign in</h1><input aria-label="Email"/></main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/entry" element={<Entry target="/detail/first"/>}/>
        <Route path="/wrong" element={<Entry target="/detail/second"/>}/>
        <Route path="/unlisted" element={<Entry target="/detail/first"/>}/>
        <Route path="/blocked" element={<Entry target="/detail/blocked#secret-fragment"/>}/>
        <Route path="/detail/:slug" element={<Detail/>}/>
        <Route path="/result" element={<h1>Unverified result</h1>}/>
        <Route path="/signin" element={<Signin/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  let state;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    state = await shell.evaluate(() => screenCanvas.state());
    if (state.status === 'error') throw new Error(state.error);
    if (state.progress?.total && state.progress.total === state.progress.completed) break;
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  assert.ok(state.progress?.total);
  assert.equal(state.progress.completed, state.progress.total);
  const byPath = pathname => state.graph.nodes.find(node => node.path === pathname);
  assert.equal(byPath('/entry').capture.transition, 'verified');
  assert.equal(byPath('/entry').capture.actualPath, '/detail/first');
  for (const path of ['/wrong', '/unlisted']) {
    assert.equal(byPath(path).capture.outcome, 'different-screen');
    assert.equal(byPath(path).screenshot, undefined);
  }
  const blocked = byPath('/blocked');
  assert.equal(blocked.capture.transition, 'observed-url');
  assert.equal(blocked.capture.targetReady, false);
  assert.equal(blocked.capture.actualPath, '/detail/blocked');
  assert.equal(blocked.capture.reason.message, 'GET /api/resource → 501');
  assert.ok(blocked.capture.observations.some(item => item.code === 'console-csp'), JSON.stringify(blocked.capture));
  assert.equal(blocked.screenshot, undefined);
  assert.doesNotMatch(JSON.stringify(blocked), /secret-|example\.invalid/);
  assert.equal(byPath('/result').capture.state, 'Unverified result');
  assert.equal(byPath('/result').capture.outcome, 'special-state');
  assert.ok(byPath('/signin').screenshot);
  assert.equal(byPath('/signin').capture.outcome, 'captured');
  assert.deepEqual(byPath('/signin').requests, [{method:'GET',path:'/api/session',status:401}]);

  for (const [pathname, cardText, liveContent] of [
    ['/entry', 'Переход подтверждён', 'first'],
    ['/blocked', 'GET /api/resource → 501', 'Loading…'],
    ['/wrong', 'Незаявленное назначение', 'second'],
    ['/signin', 'Снимок готов', 'Sign in'],
    ['/result', 'Unverified result', 'Unverified result']
  ]) {
    const card = shell.getByRole('button', { name: pathname, exact: true });
    if (pathname === '/signin') {
      await card.locator('img').waitFor();
      assert.match(await card.getAttribute('aria-description'), /Снимок готов/);
      assert.equal(await card.getByText(cardText, { exact: true }).isVisible(), false);
    } else await card.getByText(cardText, { exact: false }).waitFor();
    await card.click();
    await waitGuest(electron, `document.querySelector('main,h1')?.textContent.includes(${JSON.stringify(liveContent)})`);
    const report = byPath(pathname).capture;
    const details = shell.locator('#details .capture-details');
    await details.getByText(report.reason.message, { exact: true }).waitFor();
    await details.getByText('Наблюдалось · ' + report.actualNode + ' · ' + report.actualPath).waitFor();
    assert.equal(await card.locator('img').count(), report.targetReady && !report.transition ? 1 : 0);
  }

  const filename = path.join(folder, 'src/main.jsx');
  const source = await readFile(filename, 'utf8');
  await writeFile(filename, source.replace('<h1>Unverified result</h1>', '<main aria-busy="true">Loading…</main>'));
  await shell.getByRole('button', { name: 'Перестроить' }).click();
  const rebuilt = shell.getByRole('button', { name: '/result', exact: true });
  await rebuilt.getByText('The route still displays a loading screen').waitFor();
  assert.equal(await rebuilt.getAttribute('aria-pressed'), 'true');
  assert.equal(await rebuilt.locator('img').count(), 0);
  assert.equal(await rebuilt.getByText('Unverified result').count(), 0);
  await waitGuest(electron, "document.querySelector('main[aria-busy=true]')?.textContent === 'Loading…'");
});

test('a guarded automatic route keeps a member frame without confirming coincident branches', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t, {
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Navigate, Routes, Route} from 'react-router-dom';
      function Member() {
        const member = location.pathname === '/member';
        if (member) return <main><h1>Private member content</h1></main>;
        return <Navigate to="/signin" replace/>;
      }
      function Guest() {
        const bonus = new URLSearchParams(location.search).has('bonus');
        if (bonus) return <Navigate to="/signin" replace/>;
        return <Navigate to="/signin" replace/>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/member" element={<Member/>}/>
        <Route path="/guest" element={<Guest/>}/>
        <Route path="/signin" element={<h1>Sign-in form</h1>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const graph = await waitGraph(shell);
  const member = graph.nodes.find(node => node.path === '/member');
  assert.equal(member.capture.outcome, 'captured');
  assert.equal(member.capture.actualPath, '/member');
  assert.ok(member.screenshot?.startsWith('data:image/png;base64,'));
  const guest = graph.nodes.find(node => node.path === '/guest');
  assert.equal(guest.capture.outcome, 'transition');
  assert.equal(guest.capture.actualPath, '/signin');
  assert.equal(guest.screenshot, undefined);
  const branches = graph.edges.filter(edge => edge.source === guest.id);
  assert.equal(branches.length, 2);
  for (const { evidence } of branches) {
    assert.equal(evidence.status, 'unverified');
    assert.equal(evidence.actualPath, '/signin');
    assert.match(evidence.reason, /branch was not proved/);
  }
});


test('the transition panel preserves the actual path and blocked target independently', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t, {
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Navigate, Routes, Route} from 'react-router-dom';
      function Target() {
        React.useEffect(() => { void fetch('/api/target'); }, []);
        return <main><h1>Target shell</h1></main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/old" element={<Navigate to="/target" replace/>}/>
        <Route path="/target" element={<Target/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const graph = await waitGraph(shell);
  const edge = graph.edges.find(item => item.source === 'route:/old');
  assert.equal(edge.evidence.actualPath, '/target');
  assert.equal(edge.evidence.transitionObserved, true);
  assert.equal(edge.evidence.targetReady, false);
  assert.equal(edge.evidence.targetReason, 'GET /api/target → 501');
  await shell.getByRole('button', { name: '/old', exact: true }).click();
  await waitGuest(electron, "location.pathname === '/target'");
  const row = shell.locator('.edge-details li').filter({ hasText: 'Наблюдаемый путь · /target' });
  await row.getByText('Готовность цели перехода не подтверждена', { exact: true }).waitFor();
  await row.getByText('GET /api/target → 501', { exact: true }).waitFor();
});


test('Chromium rejects frames if an already started local request fails or cannot finish in budget', { timeout: 35_000 }, async t => {
  const folder = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      createMocks: () => async ({ path }) => {
        if (path === '/api/delayed') await new Promise(resolve => setTimeout(resolve, 650));
        if (path === '/api/pending') await new Promise(resolve => setTimeout(resolve, 6500));
        return {status:501,body:{error:'private response'}};
      }
    };`,
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Routes, Route} from 'react-router-dom';
      function Ready({ api }) {
        React.useEffect(() => { void fetch(api + '?secret=hidden', { method:'POST' }); }, [api]);
        return <main><h1>Visible content</h1></main>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/fast" element={<Ready api="/api/books:search"/>}/>
        <Route path="/late" element={<Ready api="/api/delayed"/>}/>
        <Route path="/timeout" element={<Ready api="/api/pending"/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  const graph = await waitGraph(shell);
  for (const [route, code, reason] of [
    ['/fast', 'mock-response', 'POST /api/books:search → 501'],
    ['/late', 'mock-response', 'POST /api/delayed → 501'],
    ['/timeout', 'request-pending', 'A local request did not finish within the capture budget']
  ]) {
    const node = graph.nodes.find(item => item.path === route);
    assert.equal(node.screenshot, undefined);
    assert.equal(node.capture.outcome, 'blocked');
    assert.equal(node.capture.phase, 'request');
    assert.deepEqual(node.capture.reason, { code, message: reason });
    assert.doesNotMatch(JSON.stringify(node), /secret=|private response/);
  }
});


test('rebuild keeps a declared redirect card selected once its new evidence arrives', { timeout: 30_000 }, async t => {
  const folder = await makeHost(t, {
    'src/main.jsx': `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, Navigate, Routes, Route} from 'react-router-dom';
      function Legal() {
        const [pending, ready] = React.useState(true);
        React.useEffect(() => { const timer = setTimeout(() => ready(false), 650); return () => clearTimeout(timer); }, []);
        return pending ? <h1 aria-busy="true">Loading</h1> : <h1>Terms and conditions</h1>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/terms" element={<Navigate to="/legal" replace/>}/>
        <Route path="/legal" element={<Legal/>}/>
      </Routes></BrowserRouter>);
    `
  });
  const { electron, shell } = await launchCanvas(t);
  await pick(electron, shell, folder);
  await waitGraph(shell);
  const input = shell.getByRole('button', { name: '/terms', exact: true });
  const legal = "location.pathname === '/legal' && document.querySelector('h1')?.textContent === 'Terms and conditions'";
  await input.click();
  const documentId = await waitGuest(electron, '(' + legal + ') && performance.timeOrigin');
  await shell.getByRole('button', { name: 'Перестроить' }).click();
  await waitGuest(electron, '(' + legal + ') && performance.timeOrigin > ' + documentId);
  await shell.locator('#details').getByText('Переход подтверждён', { exact: true }).waitFor();
  assert.equal(await input.getAttribute('aria-pressed'), 'true');
  assert.equal(await shell.getByRole('button', { name: '/legal', exact: true }).getAttribute('aria-pressed'), 'false');
  await shell.locator('#details').getByText('Наблюдалось · route:/legal · /legal', { exact: true }).waitFor();
});
