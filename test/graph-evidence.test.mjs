import assert from 'node:assert/strict';
import test from 'node:test';
import { actionOriginReason, captureEvidence, captureExpectation, isMultiStepAction, localRequests } from '../core/graph-evidence.mjs';

const source = { id: 'route:/entry', path: '/entry' };
const complete = { source: source.id, role: 'complete', target: 'route:/detail/:slug', path: '/detail/first' };
const guest = { source: source.id, role: 'guest', target: 'route:/steps#start', path: '/steps' };
const graph = {
  nodes: [source, { id: complete.target, path: '/detail/:slug' },
    { id: guest.target, path: '/steps', state: 'start' }],
  edges: [],
  captureRules: [complete, guest]
};
const observed = (id, pathname, ready = true) => ({ id, pathname, ready });
function record(expected, observation, requests = [], consoleCodes = []) {
  return captureEvidence(source, { ...expected, sourcePath: '/entry' }, observation, undefined, requests, consoleCodes);
}

test('capture transitions require the declared mode, concrete path and node', () => {
  assert.equal(captureExpectation(graph, source, 'complete', '/entry'), complete);
  assert.equal(captureExpectation(graph, source, 'guest', '/entry'), guest);
  assert.deepEqual(captureExpectation(graph, source, 'new', '/entry'), { target: source.id, path: '/entry', inferRedirect: true });
  assert.equal(record(complete, observed(complete.target, complete.path)).transition, 'verified');
  for (const [expected, found] of [
    [complete, observed(complete.target, '/detail/substituted')],
    [guest, observed('route:/steps#skipped', guest.path)],
    [{ target: source.id, path: source.path }, observed(guest.target, guest.path)]
  ]) {
    const result = record(expected, found);
    assert.equal(result.outcome, 'different-screen');
    assert.equal(result.transition, 'unexpected');
    assert.equal(result.targetReady, false);
  }
  const urlOnly = record(guest, observed(guest.target, guest.path, false));
  assert.equal(urlOnly.transition, 'observed-url');
  assert.equal(urlOnly.outcome, 'blocked');
});

test('request failure outranks a matching destination and secondary console noise', () => {
  const requests = localRequests([
    { method: 'GET', path: '/api/session', status: 401 },
    { method: 'POST', path: '/api/load', status: 501, body: { token: 'do-not-keep' } },
    { method: 'GET', path: 'https://example.invalid/?token=secret', status: 404 },
    { method: 'GET', path: '/api/data?code=secret#fragment', status: 500 }
  ]);
  assert.deepEqual(requests, [{ method: 'GET', path: '/api/session', status: 401 },
    { method: 'POST', path: '/api/load', status: 501 }]);
  const result = record(complete, observed(complete.target, complete.path), requests, ['console-csp']);
  assert.equal(result.reason.message, 'POST /api/load → 501');
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.phase, 'request');
  assert.equal(result.transition, 'observed-url');
  assert.deepEqual(result.observations.map(item => item.code), ['console-csp']);
  assert.equal(record(complete, observed(complete.target, complete.path), requests.slice(0, 1)).outcome, 'transition');
});


test('failed or pending raw requests block capture without preserving unsafe details', () => {
  const expected = { target: source.id, path: source.path, sourcePath: source.path };
  const found = observed(source.id, source.path);
  const reason = requests => captureEvidence(source, expected, found, 'data:image/png;base64,pixels', requests, []).reason;
  const records = [{ method: 'POST', path: '/api/books:search', status: 501, body: { token: 'hidden' } }];
  assert.deepEqual(localRequests(records), [{ method: 'POST', path: '/api/books:search', status: 501 }]);
  assert.equal(reason(records).message, 'POST /api/books:search → 501');
  assert.equal(reason([{ method: 'GET', path: '/api/books?key=hidden', status: 501 }]).message, 'A local request failed → 501');
  assert.equal(reason([{ method: 'GET', path: '/api/books', status: 0 }]).code, 'request-pending');
});

test('multi-step actions receive a dedicated screen origin reason without altering single-step fallbacks', () => {
  assert.equal(isMultiStepAction({ steps: [{ type: 'click', selector: '#a' }, { type: 'click', selector: '#submit' }] }), true);
  assert.equal(isMultiStepAction({ steps: [
    { type: 'click', selector: '#a' }, { type: 'click', selector: '#b' }, { type: 'click', selector: '#submit' }
  ] }), true);
  assert.equal(isMultiStepAction({ steps: [{ type: 'fill', selector: '#q', value: 'x' }, { type: 'click', selector: '#submit' }] }), true);
  assert.equal(isMultiStepAction({ steps: [{ type: 'click', selector: '#next' }] }), false);
  assert.equal(isMultiStepAction({ steps: [{ type: 'click', selector: '#next' }, { type: 'redirect' }] }), false);
  assert.equal(isMultiStepAction({ steps: [{ type: 'redirect' }] }), false);
  assert.equal(isMultiStepAction({ action: 'link' }), false);

  assert.equal(actionOriginReason({ redirects: false, multiStep: true, hasSourceFrame: true, sameScenario: true }), 'multi-step');
  assert.equal(actionOriginReason({ redirects: false, multiStep: true, hasSourceFrame: true, sameScenario: false }), 'multi-step');
  assert.equal(actionOriginReason({ redirects: false, multiStep: true, hasSourceFrame: false, sameScenario: false }), 'multi-step');
  assert.equal(actionOriginReason({ redirects: true, multiStep: false, hasSourceFrame: true, sameScenario: true }), 'automatic');
  assert.equal(actionOriginReason({ redirects: false, multiStep: false, hasSourceFrame: true, sameScenario: false }), 'different-scenario');
  assert.equal(actionOriginReason({ redirects: false, multiStep: false, hasSourceFrame: true, sameScenario: true }), 'control-not-in-frame');
  assert.equal(actionOriginReason({ redirects: false, multiStep: false, hasSourceFrame: false, sameScenario: false }), 'control-not-in-frame');
});
