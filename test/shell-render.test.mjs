import assert from 'node:assert/strict';
import test from 'node:test';
import { transitionLabel } from '../desktop/shell/graph.js';
import { showNode } from '../desktop/shell/selection.js';

function createElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    textContent: '',
    open: false,
    children: [],
    parentElement: null,
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
    querySelectorAll(selector) {
      const results = [];
      const walk = node => {
        for (const child of node.children) {
          if (selector === 'details[open] > summary' && child.tagName === 'SUMMARY' && node.tagName === 'DETAILS' && node.open) {
            results.push(child);
          } else if (selector === 'summary' && child.tagName === 'SUMMARY') {
            results.push(child);
          }
          walk(child);
        }
      };
      walk(this);
      return results;
    }
  };
}

function withFakeDocument(fn) {
  const previous = globalThis.document;
  globalThis.document = { createElement };
  try { return fn(createElement('div')); }
  finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

function findEdgeRows(root) {
  const rows = new Map();
  const walk = node => {
    if (node.tagName === 'LI' && node.dataset.edgeId) rows.set(node.dataset.edgeId, node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return rows;
}

function texts(node) {
  const values = [];
  const walk = item => {
    if (item.textContent) values.push(item.textContent);
    for (const child of item.children) walk(child);
  };
  walk(node);
  return values;
}

test('selection panel renders multi-step origin reason separately from single-click and fallback reasons', () => {
  const graph = {
    nodes: [
      { id: 'route:/step-1', path: '/step-1', label: '/step-1' },
      { id: 'route:/step-2', path: '/step-2', label: '/step-2' }
    ],
    edges: [
      {
        id: 'multi',
        source: 'route:/step-1',
        target: 'route:/step-2',
        label: 'Continue',
        evidence: {
          status: 'confirmed',
          actualPath: '/step-2',
          actualTarget: 'route:/step-2',
          transitionObserved: true,
          targetReady: true,
          originReason: 'multi-step'
        }
      },
      {
        id: 'single',
        source: 'route:/step-1',
        target: 'route:/step-2',
        label: 'Next',
        evidence: {
          status: 'confirmed',
          actualPath: '/step-2',
          actualTarget: 'route:/step-2',
          transitionObserved: true,
          targetReady: true,
          origin: { x: 0.5, y: 0.5 }
        }
      },
      {
        id: 'different',
        source: 'route:/step-1',
        target: 'route:/step-2',
        label: 'Alternate role',
        evidence: {
          status: 'confirmed',
          actualPath: '/step-2',
          actualTarget: 'route:/step-2',
          transitionObserved: true,
          targetReady: true,
          originReason: 'different-scenario'
        }
      },
      {
        id: 'missing-frame',
        source: 'route:/step-1',
        target: 'route:/step-2',
        label: 'Off-frame click',
        evidence: {
          status: 'confirmed',
          actualPath: '/step-2',
          actualTarget: 'route:/step-2',
          transitionObserved: true,
          targetReady: true,
          originReason: 'control-not-in-frame'
        }
      },
      {
        id: 'auto',
        source: 'route:/step-1',
        target: 'route:/step-2',
        label: 'Redirect',
        action: 'redirect',
        direct: true,
        evidence: {
          status: 'confirmed',
          actualPath: '/step-2',
          actualTarget: 'route:/step-2',
          transitionObserved: true,
          targetReady: true,
          originReason: 'automatic'
        }
      }
    ]
  };

  withFakeDocument(container => {
    showNode(container, graph, 'route:/step-1');
    const rows = findEdgeRows(container);
    assert.ok(texts(rows.get('multi')).includes('Источник стрелки · Экран · Многошаговое действие'));
    assert.ok(!texts(rows.get('multi')).some(line => line.includes('элемент на исходном кадре не подтверждён')));
    assert.ok(texts(rows.get('single')).includes('Источник стрелки · Видимый элемент'));
    assert.ok(texts(rows.get('different')).includes('Источник стрелки · Экран · роль или состояние отличаются от кадра'));
    assert.ok(texts(rows.get('missing-frame')).includes('Источник стрелки · Экран · элемент на исходном кадре не подтверждён'));
    assert.ok(texts(rows.get('auto')).includes('Источник стрелки · Экран · автоматический переход'));
  });
});

test('selection panel and transition labels separate source-error redirects, target failures, ambiguous errors, and telemetry controls', () => {
  const sourceReadyNode = {
    id: 'route:/items/:id',
    path: '/items/:id',
    label: '/items/:id',
    capture: {
      outcome: 'blocked',
      phase: 'request',
      expectedNode: 'route:/items',
      expectedPath: '/items',
      actualNode: 'route:/items',
      actualPath: '/items',
      targetReady: true,
      transition: 'source-error',
      sourceFailure: { code: 'mock-response', message: 'GET /api/items/id-1 → 501' },
      reason: { code: 'mock-response', message: 'GET /api/items/id-1 → 501' },
      observations: []
    }
  };
  const sourceUnreadyNode = {
    id: 'route:/items/:id',
    path: '/items/:id',
    label: '/items/:id',
    capture: {
      ...sourceReadyNode.capture,
      targetReady: false,
      observations: [{ code: 'loading-timeout', message: 'The route still displays a loading screen' }]
    }
  };
  const targetFailNode = {
    id: 'route:/old',
    path: '/old',
    label: '/old',
    capture: {
      outcome: 'blocked',
      phase: 'request',
      expectedNode: 'route:/target',
      expectedPath: '/target',
      actualNode: 'route:/target',
      actualPath: '/target',
      targetReady: false,
      transition: 'observed-url',
      reason: { code: 'mock-response', message: 'GET /api/target → 501' },
      observations: []
    }
  };
  const ambiguousNode = {
    id: 'route:/ambiguous',
    path: '/ambiguous',
    label: '/ambiguous',
    capture: {
      outcome: 'blocked',
      phase: 'request',
      expectedNode: 'route:/items',
      expectedPath: '/items',
      actualNode: 'route:/items',
      actualPath: '/items',
      targetReady: false,
      transition: 'observed-url',
      unattributedFailure: { code: 'mock-response', message: 'GET /api/unknown → 501' },
      reason: { code: 'mock-response', message: 'GET /api/unknown → 501' },
      observations: []
    }
  };

  assert.equal(transitionLabel(sourceReadyNode.capture), 'Переход после ошибки источника');
  assert.equal(transitionLabel(targetFailNode.capture), 'Путь наблюдался, цель не готова');
  assert.equal(transitionLabel(ambiguousNode.capture), 'Путь наблюдался, источник ошибки не определён');

  withFakeDocument(container => {
    showNode(container, {
      nodes: [sourceReadyNode, { id: 'route:/items', path: '/items', label: '/items' }],
      edges: [{
        id: 'catch-redirect',
        source: 'route:/items/:id',
        target: 'route:/items',
        label: '/items',
        action: 'redirect',
        expectedPath: '/items',
        evidence: {
          status: 'unverified',
          expectedPath: '/items',
          actualPath: '/items',
          actualTarget: 'route:/items',
          transitionObserved: true,
          targetReady: true,
          sourceFailure: { code: 'mock-response', message: 'GET /api/items/id-1 → 501' },
          originReason: 'automatic',
          reason: 'The destination was observed, but the automatic branch was not proved'
        }
      }]
    }, 'route:/items/:id');
    const all = texts(container);
    assert.ok(all.includes('Ошибка источника · GET /api/items/id-1 → 501'));
    assert.ok(all.includes('Переход после ошибки источника'));
    assert.ok(all.includes('Наблюдалось · route:/items · /items'));
    assert.ok(all.includes('Назначение готово'));
    assert.ok(!all.includes('Путь наблюдался, цель не готова'));
    const edgeTexts = texts(findEdgeRows(container).get('catch-redirect'));
    assert.ok(edgeTexts.includes('Цель перехода готова'));
    assert.ok(edgeTexts.includes('Ошибка источника · GET /api/items/id-1 → 501'));
    assert.ok(!edgeTexts.includes('Готовность цели перехода не подтверждена'));
  });

  withFakeDocument(container => {
    showNode(container, { nodes: [sourceUnreadyNode], edges: [] }, 'route:/items/:id');
    const all = texts(container);
    assert.ok(all.includes('Ошибка источника · GET /api/items/id-1 → 501'));
    assert.ok(all.includes('Готовность назначения не подтверждена'));
    assert.ok(!all.includes('Назначение готово'));
  });

  withFakeDocument(container => {
    showNode(container, {
      nodes: [ambiguousNode, { id: 'route:/items', path: '/items', label: '/items' }],
      edges: [{
        id: 'ambiguous-redirect',
        source: 'route:/ambiguous',
        target: 'route:/items',
        label: '/items',
        action: 'redirect',
        expectedPath: '/items',
        evidence: {
          status: 'unverified',
          expectedPath: '/items',
          actualPath: '/items',
          actualTarget: 'route:/items',
          transitionObserved: true,
          targetReady: false,
          unattributedFailure: { code: 'mock-response', message: 'GET /api/unknown → 501' },
          originReason: 'automatic'
        }
      }]
    }, 'route:/ambiguous');
    const all = texts(container);
    assert.ok(all.includes('Путь наблюдался, источник ошибки не определён'));
    assert.ok(all.includes('Готовность экрана не подтверждена'));
    assert.ok(!all.includes('Путь наблюдался, цель не готова'));
    const edgeTexts = texts(findEdgeRows(container).get('ambiguous-redirect'));
    assert.ok(edgeTexts.includes('Готовность цели перехода не подтверждена'));
    assert.ok(edgeTexts.includes('Неуспешный запрос при переходе · GET /api/unknown → 501'));
    assert.ok(!edgeTexts.some(line => line.startsWith('Ошибка источника')));
  });

  withFakeDocument(container => {
    showNode(container, {
      nodes: [
        { id: 'route:/', path: '/', label: '/' },
        { id: 'route:/done', path: '/done', label: '/done' }
      ],
      edges: [
        {
          id: 'late-target-fail',
          source: 'route:/',
          target: 'route:/done',
          label: 'Submit',
          evidence: {
            status: 'unverified',
            actualPath: '/done',
            actualTarget: 'route:/done',
            transitionObserved: true,
            targetReady: false,
            targetReason: 'GET /api/details → 501',
            requestCheck: 'verified'
          }
        },
        {
          id: 'telemetry-ok',
          source: 'route:/',
          target: 'route:/done',
          label: 'Telemetry',
          evidence: {
            status: 'confirmed',
            actualPath: '/done',
            actualTarget: 'route:/done',
            transitionObserved: true,
            targetReady: true,
            requestCheck: 'verified',
            backgroundFailure: { code: 'mock-response', message: 'GET /api/telemetry → 501' }
          }
        }
      ]
    }, 'route:/');
    const rows = findEdgeRows(container);
    const lateTexts = texts(rows.get('late-target-fail'));
    assert.ok(lateTexts.includes('Готовность цели перехода не подтверждена'));
    assert.ok(lateTexts.includes('GET /api/details → 501'));
    const telemetryTexts = texts(rows.get('telemetry-ok'));
    assert.ok(telemetryTexts.includes('Цель перехода готова'));
    assert.ok(telemetryTexts.includes('Фоновая ошибка · GET /api/telemetry → 501'));
  });
});
