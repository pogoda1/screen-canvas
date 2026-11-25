import assert from 'node:assert/strict';
import test from 'node:test';
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
