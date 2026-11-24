import assert from 'node:assert/strict';
import test from 'node:test';
import { defineAdapter } from 'react-screen-canvas';
import { getInitialScenario, registerBrowserBindings } from 'react-screen-canvas/browser';
import { assertJson, assertScenario, matchesStamp } from '../core/contracts.mjs';

test('package exposes a standalone node and browser SDK', () => {
  const adapter = { apiPrefixes: ['/api'] };
  assert.equal(defineAdapter(adapter), adapter);
  assert.throws(() => defineAdapter(null));
  assert.equal(getInitialScenario(), undefined);
  assert.equal(typeof registerBrowserBindings({}), 'function');
});

test('validates JSON and scenario generation boundaries', () => {
  const scenario = { version: 1, nodeId: 'route:/', seed: 0, params: {}, mode: 'default', data: { enabled: false } };
  assert.equal(assertScenario(scenario), scenario);
  assert.throws(() => assertScenario({ ...scenario, params: { id: 1 } }));
  const circular = {};
  circular.self = circular;
  assert.throws(() => assertJson(circular));
  assert.throws(() => assertJson({ bad: Infinity }));
  const stamp = { generation: 1, sessionId: 'session', documentId: 'document', revision: 2 };
  assert.ok(matchesStamp({ ...stamp }, stamp));
  assert.ok(!matchesStamp({ ...stamp, documentId: 'old' }, stamp));
});
