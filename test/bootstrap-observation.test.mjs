import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { captureEvidence, redirectEdgeOutcome } from '../core/graph-evidence.mjs';
import { transitionLabel } from '../desktop/shell/graph.js';
import { showNode } from '../desktop/shell/selection.js';

const bootstrapSource = await readFile(new URL('../core/host/bootstrap.js', import.meta.url), 'utf8');

function createDomElement(tag, { text = '', attrs = {}, visible = true } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    textContent: text,
    open: false,
    children: [],
    parentElement: null,
    _attrs: { ...attrs },
    _visible: visible,
    get firstChild() { return this.children[0] ?? null; },
    append(...nodes) {
      for (const node of nodes) {
        if (!node) continue;
        node.parentElement = this;
        this.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    },
    getAttribute(name) { return Object.hasOwn(this._attrs, name) ? this._attrs[name] : null; },
    getClientRects() { return this._visible ? [{ width: 100, height: 20 }] : []; },
    closest(selector) {
      const selectors = selector.split(',').map(part => part.trim());
      for (let cursor = this; cursor; cursor = cursor.parentElement) {
        if (selectors.some(sel => cursor.matches(sel))) return cursor;
      }
      return null;
    },
    matches(selector) {
      return selector.split(',').map(part => part.trim()).some(part => {
        if (part === '[hidden]') return Object.hasOwn(this._attrs, 'hidden');
        if (part === '[aria-hidden="true"]') return this._attrs['aria-hidden'] === 'true';
        if (part === '[aria-busy="true"]') return this._attrs['aria-busy'] === 'true';
        if (part === '[role="alert"]') return this._attrs.role === 'alert';
        if (part === '[role="status"]') return this._attrs.role === 'status';
        if (part === '[role="progressbar"]') return this._attrs.role === 'progressbar';
        if (part === '[data-screen-canvas-loading]') return Object.hasOwn(this._attrs, 'data-screen-canvas-loading');
        if (part === '[data-screen-canvas-error]') return Object.hasOwn(this._attrs, 'data-screen-canvas-error');
        if (part === 'main') return this.tagName === 'MAIN';
        if (part === '[role="main"]') return this._attrs.role === 'main';
        if (part === 'vite-error-overlay') return this.tagName === 'VITE-ERROR-OVERLAY';
        return false;
      });
    },
    querySelectorAll(selector) {
      const results = [];
      const walk = node => {
        for (const child of node.children) {
          if (selector === 'details[open] > summary' && child.tagName === 'SUMMARY' && node.tagName === 'DETAILS' && node.open) {
            results.push(child);
          } else if (selector === 'summary' && child.tagName === 'SUMMARY') {
            results.push(child);
          } else if (child.matches(selector)) {
            results.push(child);
          }
          walk(child);
        }
      };
      walk(this);
      return results;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  };
  return el;
}

function collectTexts(node) {
  const out = [];
  const walk = item => {
    if (item.textContent) out.push(item.textContent);
    for (const child of item.children) walk(child);
  };
  walk(node);
  return out;
}

function renderPanel(graph, nodeId) {
  const previous = globalThis.document;
  const container = createDomElement('div');
  globalThis.document = { createElement: tag => createDomElement(tag) };
  try {
    showNode(container, graph, nodeId);
    return collectTexts(container);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

function bootEnvironment({ initialPath = '/old', bodyNodes = [] } = {}) {
  const observedPosts = [];
  const fetchCalls = [];
  const location = { origin: 'http://127.0.0.1:41234', pathname: initialPath, get href() { return this.origin + this.pathname; } };
  const history = {
    pushState(_state, _title, next) { location.pathname = new URL(next, location.href).pathname; },
    replaceState(_state, _title, next) { location.pathname = new URL(next, location.href).pathname; }
  };
  const body = createDomElement('body');
  for (const node of bodyNodes) body.append(node);
  const textNodes = [];
  const collectLeaves = node => {
    for (const child of node.children) {
      if (!child.children.length && child.textContent) textNodes.push({ textContent: child.textContent, parentElement: child });
      collectLeaves(child);
    }
  };
  collectLeaves(body);

  class FakeXHR {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.headers = {};
      this._listeners = [];
    }
    addEventListener(type, fn) {
      if (type === 'readystatechange') this._listeners.push(fn);
    }
    open(method, target) {
      this.method = method;
      this.target = target;
      this.readyState = 1;
    }
    setRequestHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
    send() {
      this.sent = true;
    }
    finish(status) {
      this.status = status;
      this.readyState = 4;
      for (const listener of [...this._listeners]) listener.call(this);
    }
  }

  const fakeFetch = (input, init = {}) => {
    const raw = input instanceof Request ? input.url : String(input);
    const resolved = new URL(raw, location.href);
    if (resolved.pathname === '/__screen_canvas/observe') {
      observedPosts.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 200 });
    }
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const headers = {};
    if (init.headers instanceof Headers) {
      for (const [k, v] of init.headers.entries()) headers[k.toLowerCase()] = v;
    }
    fetchCalls.push({ url: resolved.pathname, headers, resolve });
    return promise;
  };

  const sandbox = {
    URL, Headers, Request, Promise, Map, Set, WeakMap, Object, String, Number, Boolean, Array, JSON, Symbol,
    NodeFilter: { SHOW_TEXT: 4 },
    location, history,
    fetch: fakeFetch,
    XMLHttpRequest: FakeXHR,
    addEventListener() {},
    getComputedStyle: () => ({ visibility: 'visible', opacity: '1' }),
    document: {
      body,
      querySelector: sel => body.querySelector(sel),
      querySelectorAll: sel => body.querySelectorAll(sel),
      createTreeWalker: () => {
        let idx = -1;
        return {
          get currentNode() { return textNodes[idx]; },
          nextNode() { return ++idx < textNodes.length; }
        };
      },
      createRange: () => ({
        selectNodeContents(node) { this._node = node; },
        getClientRects() { return this._node?.parentElement?.getClientRects() ?? []; }
      })
    },
    __screenCanvasBoot: {
      stamp: { generation: 1, sessionId: 's1', documentId: 'doc-1', revision: 0 },
      token: 'ctl-token',
      observeToken: 'obs-token',
      apiPrefixes: ['/api'],
      initial: { version: 1, nodeId: 'route:/old', seed: 1, params: {}, mode: 'default', data: {} },
      browser: null
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(bootstrapSource, sandbox);
  return { sandbox, location, history, fetchCalls, observedPosts };
}

test('real bootstrap XHR with early listener before open() keeps order unknown instead of mislabeling it late', () => {
  const { sandbox, history } = bootEnvironment({ initialPath: '/old' });
  const xhr = new sandbox.XMLHttpRequest();
  // Register app callback BEFORE open() — exact counterexample order.
  xhr.addEventListener('readystatechange', () => {
    if (xhr.readyState === 4 && xhr.status === 501) {
      history.replaceState(null, '', '/list');
    }
  });
  xhr.open('GET', '/api/detail');
  xhr.send();
  assert.equal(xhr.headers['x-screen-canvas-req-doc'], 'obs-token');
  assert.equal(xhr.headers['x-screen-canvas-req-path'], '/old');
  const reqId = xhr.headers['x-screen-canvas-req-id'];
  xhr.finish(501);

  const evidence = sandbox.__screenCanvasRequestEvidence();
  assert.equal(evidence.settlements[reqId], undefined, 'XHR navigated inside early callback must not claim beforeNavigation=false');

  const records = [
    { sequence: 1, method: 'GET', path: '/api/detail', status: 501, sourcePath: '/old', documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/list', status: 200, sourcePath: '/list', documentId: 'doc-1', initialDocument: true }
  ];
  const observed = { id: 'route:/list', pathname: '/list', ready: true, status: { documentId: 'doc-1', contentVerified: true } };
  const capture = captureEvidence(
    { id: 'route:/old', path: '/old' },
    { target: 'route:/list', path: '/list', sourcePath: '/old' },
    observed, undefined, records, []
  );
  assert.equal(capture.sourceFailure, undefined);
  assert.equal(capture.lateSourceFailure, undefined);
  assert.equal(capture.unorderedSourceFailure?.message, 'GET /api/detail → 501');
  assert.notEqual(capture.transition, 'source-error');
  assert.equal(transitionLabel(capture), 'Наблюдался переход; порядок ошибки источника не подтверждён');

  const edge = redirectEdgeOutcome(records, observed, { sourcePath: '/old', actualPath: '/list' });
  assert.equal(edge.sourceFailure, undefined);
  assert.equal(edge.lateSourceFailure, undefined);
  assert.equal(edge.unorderedSourceFailure?.message, 'GET /api/detail → 501');

  const panelTexts = renderPanel({
    nodes: [
      { id: 'route:/old', path: '/old', label: '/old', capture },
      { id: 'route:/list', path: '/list', label: '/list' }
    ],
    edges: [{
      id: 'xhr-redirect', source: 'route:/old', target: 'route:/list', label: '/list', action: 'redirect',
      evidence: { status: 'unverified', actualPath: '/list', actualTarget: 'route:/list', transitionObserved: true, ...edge }
    }]
  }, 'route:/old');
  assert.ok(panelTexts.includes('Ошибка источника (порядок с переходом не подтверждён) · GET /api/detail → 501'));
  assert.ok(panelTexts.includes('Наблюдался переход; порядок ошибки источника не подтверждён'));
  assert.ok(!panelTexts.some(line => line.includes('Поздний ответ источника после перехода')));
  assert.ok(!panelTexts.includes('Переход после ошибки источника'));
});

test('real bootstrap fetch distinguishes strictly proved before-navigation and after-navigation settlements', async () => {
  // 1. Fetch resolves 501 BEFORE caller navigates -> beforeNavigation === true.
  const beforeEnv = bootEnvironment({ initialPath: '/old' });
  const beforePromise = beforeEnv.sandbox.fetch('/api/detail');
  const beforeReqId = beforeEnv.fetchCalls[0].headers['x-screen-canvas-req-id'];
  const navigated = beforePromise.then(() => {
    beforeEnv.history.replaceState(null, '', '/list');
  });
  beforeEnv.fetchCalls[0].resolve({ ok: false, status: 501 });
  await navigated;
  assert.equal(beforeEnv.sandbox.__screenCanvasRequestEvidence().settlements[beforeReqId]?.beforeNavigation, true);

  // 2. Caller navigates BEFORE fetch resolves 501 -> beforeNavigation === false.
  const afterEnv = bootEnvironment({ initialPath: '/old' });
  const afterPromise = afterEnv.sandbox.fetch('/api/telemetry');
  const afterReqId = afterEnv.fetchCalls[0].headers['x-screen-canvas-req-id'];
  afterEnv.history.replaceState(null, '', '/list');
  afterEnv.fetchCalls[0].resolve({ ok: false, status: 501 });
  await afterPromise;
  assert.equal(afterEnv.sandbox.__screenCanvasRequestEvidence().settlements[afterReqId]?.beforeNavigation, false);
});

test('real bootstrap status + classifier reject service 200 + list 501 with role="alert" and confirm only explicit content proof', async () => {
  // Counterexample: neutral page WITHOUT captureReady hook, GET /api/config 200 + GET /api/list 501 + role="alert".
  const mainAlert = createDomElement('main');
  mainAlert.append(
    createDomElement('h1', { text: 'Список' }),
    createDomElement('p', { text: 'Не удалось загрузить список', attrs: { role: 'alert' } })
  );
  const neutralEnv = bootEnvironment({ initialPath: '/list', bodyNodes: [mainAlert] });
  const alertStatus = await neutralEnv.sandbox.__screenCanvasStatus(false, true);
  assert.equal(alertStatus.ready, true);
  assert.equal(alertStatus.alert, true);
  assert.equal(alertStatus.contentVerified, undefined);

  const counterRecords = [
    { sequence: 1, method: 'GET', path: '/api/config', status: 200, sourcePath: '/list', documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/list', status: 501, sourcePath: '/list', documentId: 'doc-1', initialDocument: true }
  ];
  const alertObserved = { id: 'route:/list', pathname: '/list', ready: alertStatus.ready, status: alertStatus };
  const alertCapture = captureEvidence(
    { id: 'route:/old', path: '/old' },
    { target: 'route:/list', path: '/list', sourcePath: '/old' },
    alertObserved, undefined, counterRecords, []
  );
  assert.equal(alertCapture.outcome, 'blocked');
  assert.equal(alertCapture.transition, 'observed-url');
  assert.equal(alertCapture.targetReady, false);
  assert.equal(alertCapture.backgroundFailure, undefined);
  assert.equal(alertCapture.reason.message, 'GET /api/list → 501');

  const alertEdge = redirectEdgeOutcome(counterRecords, alertObserved, { sourcePath: '/old', actualPath: '/list' });
  assert.equal(alertEdge.targetReady, false);
  assert.equal(alertEdge.targetReason, 'GET /api/list → 501');
  assert.equal(alertEdge.backgroundFailure, undefined);

  const alertPanel = renderPanel({
    nodes: [
      { id: 'route:/old', path: '/old', label: '/old', capture: alertCapture },
      { id: 'route:/list', path: '/list', label: '/list' }
    ],
    edges: [{
      id: 'alert-redirect', source: 'route:/old', target: 'route:/list', label: '/list', action: 'redirect', direct: true,
      evidence: { status: 'confirmed', actualPath: '/list', actualTarget: 'route:/list', transitionObserved: true, ...alertEdge }
    }]
  }, 'route:/old');
  assert.ok(alertPanel.includes('Путь наблюдался, цель не готова'));
  assert.ok(alertPanel.includes('Готовность цели перехода не подтверждена'));
  assert.ok(alertPanel.includes('GET /api/list → 501'));
  assert.ok(!alertPanel.includes('Переход подтверждён'));
  assert.ok(!alertPanel.includes('Цель перехода готова'));
  assert.ok(!alertPanel.some(line => line.startsWith('Фоновая ошибка')));

  // Positive control: explicit adapter captureReady proves list item is rendered (no alert), 200 list + 501 telemetry.
  const mainList = createDomElement('main');
  mainList.append(
    createDomElement('h1', { text: 'Список' }),
    createDomElement('p', { text: 'Alpha item' })
  );
  const verifiedEnv = bootEnvironment({ initialPath: '/list', bodyNodes: [mainList] });
  const bridge = verifiedEnv.sandbox[Symbol.for('react-screen-canvas.browser')];
  bridge.register({ captureReady: () => true });
  const verifiedStatus = await verifiedEnv.sandbox.__screenCanvasStatus(false, true);
  assert.equal(verifiedStatus.ready, true);
  assert.equal(verifiedStatus.contentVerified, true);
  assert.equal(verifiedStatus.alert, undefined);

  const telemetryRecords = [
    { sequence: 1, method: 'GET', path: '/api/list', status: 200, sourcePath: '/list', documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/telemetry', status: 501, sourcePath: '/list', documentId: 'doc-1', initialDocument: true }
  ];
  const verifiedObserved = { id: 'route:/list', pathname: '/list', ready: verifiedStatus.ready, status: verifiedStatus };
  const verifiedCapture = captureEvidence(
    { id: 'route:/old', path: '/old' },
    { target: 'route:/list', path: '/list', sourcePath: '/old' },
    verifiedObserved, undefined, telemetryRecords, []
  );
  assert.equal(verifiedCapture.outcome, 'transition');
  assert.equal(verifiedCapture.transition, 'verified');
  assert.equal(verifiedCapture.targetReady, true);
  assert.equal(verifiedCapture.backgroundFailure?.message, 'GET /api/telemetry → 501');

  const verifiedEdge = redirectEdgeOutcome(telemetryRecords, verifiedObserved, { sourcePath: '/old', actualPath: '/list' });
  assert.equal(verifiedEdge.targetReady, true);
  assert.equal(verifiedEdge.targetReason, undefined);
  assert.equal(verifiedEdge.backgroundFailure?.message, 'GET /api/telemetry → 501');

  const verifiedPanel = renderPanel({
    nodes: [
      { id: 'route:/old', path: '/old', label: '/old', capture: verifiedCapture },
      { id: 'route:/list', path: '/list', label: '/list' }
    ],
    edges: [{
      id: 'telemetry-redirect', source: 'route:/old', target: 'route:/list', label: '/list', action: 'redirect', direct: true,
      evidence: { status: 'confirmed', actualPath: '/list', actualTarget: 'route:/list', transitionObserved: true, ...verifiedEdge }
    }]
  }, 'route:/old');
  assert.ok(verifiedPanel.includes('Переход подтверждён'));
  assert.ok(verifiedPanel.includes('Цель перехода готова'));
  assert.ok(verifiedPanel.includes('Фоновая ошибка · GET /api/telemetry → 501'));
  assert.ok(!verifiedPanel.includes('Путь наблюдался, цель не готова'));
});
