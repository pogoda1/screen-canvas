import assert from 'node:assert/strict';
import test from 'node:test';
import { actionOriginReason, captureEvidence, captureExpectation, isMultiStepAction, localRequests, partitionRequests, redirectEdgeOutcome } from '../core/graph-evidence.mjs';

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

test('source data failure before redirect is separated from destination readiness and controls', () => {
  const detailNode = { id: 'route:/items/:id', path: '/items/:id' };
  const expectedRedirect = { target: 'route:/items', path: '/items', sourcePath: '/items/id-1' };
  const sourceRecords = [
    { sequence: 1, method: 'GET', path: '/api/session', status: 200, sourcePath: '/items/id-1', documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/items/id-1', status: 501, sourcePath: '/items/id-1', documentId: 'doc-1', initialDocument: true },
    { sequence: 3, method: 'GET', path: '/api/items', status: 200, sourcePath: '/items', documentId: 'doc-1', initialDocument: true }
  ];
  const readyTarget = { id: 'route:/items', pathname: '/items', ready: true, status: { documentId: 'doc-1' } };
  const capture = captureEvidence(detailNode, expectedRedirect, readyTarget, undefined, sourceRecords, []);
  assert.equal(capture.outcome, 'blocked');
  assert.equal(capture.phase, 'request');
  assert.equal(capture.transition, 'source-error');
  assert.equal(capture.actualNode, 'route:/items');
  assert.equal(capture.actualPath, '/items');
  assert.equal(capture.targetReady, true);
  assert.equal(capture.sourceFailure?.message, 'GET /api/items/id-1 → 501');
  assert.equal(capture.reason.message, 'GET /api/items/id-1 → 501');
  assert.equal(capture.unattributedFailure, undefined);

  const edgeResult = redirectEdgeOutcome(sourceRecords, readyTarget, { sourcePath: '/items/id-1', actualPath: '/items' });
  assert.equal(edgeResult.targetReady, true);
  assert.equal(edgeResult.targetReason, undefined);
  assert.equal(edgeResult.sourceFailure?.message, 'GET /api/items/id-1 → 501');
  assert.equal(edgeResult.unattributedFailure, undefined);

  // Source error redirecting to an unready destination never claims readiness without evidence.
  const unreadyTarget = {
    id: 'route:/items', pathname: '/items', ready: false, status: { documentId: 'doc-1' },
    diagnostic: { code: 'loading-timeout', message: 'The route still displays a loading screen' }
  };
  const unreadyCapture = captureEvidence(detailNode, expectedRedirect, unreadyTarget, undefined, sourceRecords, []);
  assert.equal(unreadyCapture.outcome, 'blocked');
  assert.equal(unreadyCapture.transition, 'source-error');
  assert.equal(unreadyCapture.targetReady, false);
  assert.equal(unreadyCapture.sourceFailure?.message, 'GET /api/items/id-1 → 501');
  assert.ok(unreadyCapture.observations.some(item => item.code === 'loading-timeout'));

  const unreadyEdge = redirectEdgeOutcome(sourceRecords, unreadyTarget, { sourcePath: '/items/id-1', actualPath: '/items' });
  assert.equal(unreadyEdge.targetReady, false);
  assert.equal(unreadyEdge.targetReason, 'The route still displays a loading screen');
  assert.equal(unreadyEdge.sourceFailure?.message, 'GET /api/items/id-1 → 501');

  // Target failure on the destination remains attributed to the destination (observed-url).
  const targetFailRecords = [
    { sequence: 1, method: 'GET', path: '/api/session', status: 200, sourcePath: '/old', documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/target', status: 501, sourcePath: '/target', documentId: 'doc-1', initialDocument: true }
  ];
  const targetFailCapture = captureEvidence(
    { id: 'route:/old', path: '/old' },
    { target: 'route:/target', path: '/target', sourcePath: '/old' },
    { id: 'route:/target', pathname: '/target', ready: true, status: { documentId: 'doc-1' } },
    undefined, targetFailRecords, []
  );
  assert.equal(targetFailCapture.transition, 'observed-url');
  assert.equal(targetFailCapture.targetReady, false);
  assert.equal(targetFailCapture.sourceFailure, undefined);
  assert.equal(targetFailCapture.unattributedFailure, undefined);
  assert.equal(targetFailCapture.reason.message, 'GET /api/target → 501');

  const targetFailEdge = redirectEdgeOutcome(
    targetFailRecords, { id: 'route:/target', pathname: '/target', ready: true, status: { documentId: 'doc-1' } },
    { sourcePath: '/old', actualPath: '/target' }
  );
  assert.equal(targetFailEdge.targetReady, false);
  assert.equal(targetFailEdge.targetReason, 'GET /api/target → 501');
  assert.equal(targetFailEdge.sourceFailure, undefined);

  // Both source and target failures keep both facts without claiming target readiness.
  const bothFailRecords = [
    { sequence: 1, method: 'GET', path: '/api/items/id-1', status: 501, sourcePath: '/items/id-1', documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/items', status: 501, sourcePath: '/items', documentId: 'doc-1', initialDocument: true }
  ];
  const bothFail = captureEvidence(detailNode, expectedRedirect, readyTarget, undefined, bothFailRecords, []);
  assert.equal(bothFail.transition, 'observed-url');
  assert.equal(bothFail.targetReady, false);
  assert.equal(bothFail.sourceFailure?.message, 'GET /api/items/id-1 → 501');
  assert.equal(bothFail.reason.message, 'GET /api/items → 501');
});

test('ambiguous, full-document and same-URL request attribution preserve confirmed facts only', () => {
  // Missing Referer on same-document redirect is ambiguous: never claim readiness or blame target.
  const noReferer = [
    { sequence: 1, method: 'GET', path: '/api/ambiguous', status: 501, documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/items', status: 200, sourcePath: '/items', documentId: 'doc-1', initialDocument: true }
  ];
  const targetObs = { id: 'route:/items', pathname: '/items', ready: true, status: { documentId: 'doc-1' } };
  const ambiguousCapture = captureEvidence(
    { id: 'route:/items/:id', path: '/items/:id' },
    { target: 'route:/items', path: '/items', sourcePath: '/items/id-1' },
    targetObs, undefined, noReferer, []
  );
  assert.equal(ambiguousCapture.outcome, 'blocked');
  assert.equal(ambiguousCapture.transition, 'observed-url');
  assert.equal(ambiguousCapture.targetReady, false);
  assert.equal(ambiguousCapture.sourceFailure, undefined);
  assert.equal(ambiguousCapture.unattributedFailure?.message, 'GET /api/ambiguous → 501');

  const ambiguousEdge = redirectEdgeOutcome(noReferer, targetObs, { sourcePath: '/items/id-1', actualPath: '/items' });
  assert.equal(ambiguousEdge.targetReady, false);
  assert.equal(ambiguousEdge.targetReason, undefined);
  assert.equal(ambiguousEdge.sourceFailure, undefined);
  assert.equal(ambiguousEdge.unattributedFailure?.message, 'GET /api/ambiguous → 501');

  // A root-path Referer arriving AFTER target requests is treated as ambiguous (guards origin-only Referrer-Policy).
  const rootLate = partitionRequests([
    { sequence: 1, method: 'GET', path: '/api/target', status: 200, sourcePath: '/done', documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/late', status: 501, sourcePath: '/', documentId: 'doc-1', initialDocument: true }
  ], { sourcePath: '/', actualPath: '/done', actualDocumentId: 'doc-1' });
  assert.equal(rootLate.source.length, 0);
  assert.equal(rootLate.ambiguous.length, 1);

  // Full-document navigation distinguishes initial document from destination document even without Referer.
  const fullReload = partitionRequests([
    { sequence: 1, method: 'GET', path: '/api/source', status: 501, documentId: 'doc-1', initialDocument: true },
    { sequence: 2, method: 'GET', path: '/api/dest', status: 200, documentId: 'doc-2', initialDocument: false }
  ], { sourcePath: '/items/1', actualPath: '/items', actualDocumentId: 'doc-2' });
  assert.equal(fullReload.source.length, 1);
  assert.equal(fullReload.target.length, 1);
  assert.equal(fullReload.ambiguous.length, 0);

  // Same-URL request failure stays attributed to the current screen, never source-error.
  const sameUrl = captureEvidence(
    { id: 'route:/done', path: '/done' },
    { target: 'route:/done', path: '/done', sourcePath: '/done' },
    { id: 'route:/done', pathname: '/done', ready: true, status: { documentId: 'doc-1' } },
    'data:image/png;base64,pixels',
    [{ sequence: 1, method: 'GET', path: '/api/details', status: 501, sourcePath: '/done', documentId: 'doc-1', initialDocument: true }],
    []
  );
  assert.equal(sameUrl.outcome, 'blocked');
  assert.equal(sameUrl.targetReady, false);
  assert.equal(sameUrl.sourceFailure, undefined);
  assert.equal(sameUrl.transition, undefined);
});
