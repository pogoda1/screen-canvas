import { routeMatches } from './discovery/actions.mjs';

export function identifyNode(graph, pathname, reported) {
  const candidates = graph.nodes.filter(node => routeMatches(node.path, pathname));
  if (reported) {
    const explicit = candidates.find(node => node.id === reported);
    if (explicit) return explicit.id;
  }
  const routes = candidates.filter(node => !node.state);
  const rank = node => node.path.split('/').reduce((score, part) =>
    score + (part === '*' ? -100 : part.startsWith(':') ? 1 : 10), 0) + (node.index ? 0.5 : 0);
  routes.sort((a, b) => rank(b) - rank(a));
  if (routes[0] && (!routes[1] || rank(routes[0]) > rank(routes[1]))) return routes[0].id;
}

export function interactiveSteps(edge) {
  return Array.isArray(edge?.steps) ? edge.steps.filter(step => step.type !== 'redirect') : [];
}

export function isMultiStepAction(edge) {
  return interactiveSteps(edge).length > 1;
}

export function actionOriginReason({ redirects, multiStep, hasSourceFrame, sameScenario }) {
  if (redirects) return 'automatic';
  if (multiStep) return 'multi-step';
  return hasSourceFrame && !sameScenario ? 'different-scenario' : 'control-not-in-frame';
}

export function edgeEvidence(edge, actualTarget, requests, reason, actualPath) {
  const evidence = { status: actualTarget === edge.target && !reason ? 'confirmed' : 'unverified', requests };
  if (edge.expectedPath) evidence.expectedPath = edge.expectedPath;
  if (exactLocalPath(actualPath)) evidence.actualPath = actualPath;
  if (actualTarget) evidence.actualTarget = actualTarget;
  if (evidence.status !== 'confirmed') evidence.reason = reason ?? 'The expected target was not observed';
  return evidence;
}

export function containsValue(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((value, index) => containsValue(actual[index], value));
  return Boolean(actual && typeof actual === 'object' && !Array.isArray(actual) &&
    Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && containsValue(actual[key], value)));
}

export function captureExpectation(graph, node, mode, initialPath) {
  const rules = (graph.captureRules ?? []).filter(item => item.source === node.id && concreteLocalPath(item.path) &&
    graph.nodes.some(target => target.id === item.target && routeMatches(target.path, item.path)));
  const rule = rules.find(item => item.role === mode) ?? rules.find(item => item.role === undefined);
  if (rule) return rule;
  const redirects = graph.edges.filter(edge => edge.action === 'redirect' && edge.direct && edge.source === node.id && concreteLocalPath(edge.expectedPath));
  if (redirects.length === 1) {
    return { target: redirects[0].target, path: redirects[0].expectedPath };
  }
  return { target: node.id, path: initialPath, inferRedirect: true };
}

export function observedRedirect(graph, node, observed) {
  if (!observed?.id || observed.id === node.id || !exactLocalPath(observed.pathname)) return;
  const declared = graph.edges.some(edge => edge.action === 'redirect' && edge.source === node.id &&
    edge.target === observed.id && edge.expectedPath === observed.pathname);
  if (declared) return { target: observed.id, path: observed.pathname };
}

function exactLocalPath(value) {
  return typeof value === 'string' && value.length <= 240 && /^\/(?!\/)[^\s?#\\]*$/.test(value);
}

function concreteLocalPath(value) {
  return exactLocalPath(value) && !value.split('/').some(part => part === '*' || part.startsWith(':'));
}

export function requestFailure(records) {
  const failed = records.find(request => Number.isInteger(request.status) && request.status >= 500);
  if (!failed) return;
  const visible = localRequests([failed])[0];
  const message = visible ? visible.method + ' ' + visible.path + ' → ' + visible.status :
    'A local request failed → ' + failed.status;
  return { code: 'mock-response', message };
}

export function localRequests(records) {
  return records.filter(({ method, path, status }) =>
    /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method) && exactLocalPath(path) && Number.isInteger(status)
  ).slice(-250).map(({ method, path, status }) => ({ method, path, status }));
}

export function partitionRequests(records, { sourcePath, actualPath, actualDocumentId } = {}) {
  const changedPath = Boolean(exactLocalPath(sourcePath) && exactLocalPath(actualPath) && actualPath !== sourcePath);
  const changedDocument = Boolean(actualDocumentId &&
    records.some(record => record.initialDocument === true && record.documentId && record.documentId !== actualDocumentId));
  if (!changedPath && !changedDocument) {
    return { source: [], target: [...records], ambiguous: [] };
  }
  const source = [];
  const target = [];
  const ambiguous = [];
  for (const record of records) {
    const hasWitness = Boolean(record.documentId && exactLocalPath(record.sourcePath));
    if (!hasWitness) {
      ambiguous.push(record);
      continue;
    }
    const matchesTargetDoc = !actualDocumentId || record.documentId === actualDocumentId;
    const matchesTargetPath = !changedPath || record.sourcePath === actualPath;
    if (matchesTargetDoc && matchesTargetPath) {
      target.push(record);
      continue;
    }
    const matchesSourceDoc = changedDocument
      ? record.initialDocument === true && record.documentId !== actualDocumentId
      : !actualDocumentId || record.documentId === actualDocumentId;
    const matchesSourcePath = !changedPath || record.sourcePath === sourcePath;
    if (matchesSourceDoc && matchesSourcePath) source.push(record);
    else ambiguous.push(record);
  }
  return { source, target, ambiguous };
}

const SKIP_TOKEN_KEYS = /^(?:id|code|status|type|kind|role|mode|locale|lang|version|error|token|secret|password|auth|authorization|cookie|session|key|csrf|nonce|signature)$/i;
const GENERIC_TOKENS = new Set(['ok', 'yes', 'no', 'true', 'false', 'null', 'undefined', 'none', 'default', 'success', 'error', 'loading', 'pending']);

function normalizeContentText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function extractResponseTokens(body) {
  const tokens = [];
  const seen = new Set();
  let visited = 0;
  const walk = (value, depth, key) => {
    if (visited >= 256 || tokens.length >= 64 || depth > 6 || value == null) return;
    visited++;
    if (typeof value === 'string') {
      if (key && SKIP_TOKEN_KEYS.test(key)) return;
      const normalized = normalizeContentText(value);
      if (normalized.length < 2 || normalized.length > 120 || GENERIC_TOKENS.has(normalized)) return;
      if (/^(?:https?:\/\/|\/|data:|blob:)/.test(normalized)) return;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) return;
      if (/^\d+(?:[.,:/-]\d+)*$/.test(normalized)) return;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        tokens.push(normalized);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, undefined);
      return;
    }
    if (typeof value === 'object') {
      for (const [entryKey, entryValue] of Object.entries(value)) walk(entryValue, depth + 1, entryKey);
    }
  };
  walk(body, 0, undefined);
  return tokens;
}

export function matchesRenderedContent(tokens, visibleTexts) {
  if (!Array.isArray(tokens) || !tokens.length || !Array.isArray(visibleTexts) || !visibleTexts.length) return false;
  const normalizedTexts = visibleTexts.map(normalizeContentText).filter(text => text.length >= 2);
  if (!normalizedTexts.length) return false;
  for (const rawToken of tokens) {
    const token = normalizeContentText(rawToken);
    if (token.length < 2) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('(?:^|[^\\p{L}\\p{N}_])' + escaped + '(?:$|[^\\p{L}\\p{N}_])', 'u');
    if (normalizedTexts.some(text => text === token || pattern.test(text))) return true;
  }
  return false;
}

function requestProblem(records) {
  const http = requestFailure(records);
  if (http) return http;
  if (records.some(request => request.status === 0)) {
    return { code: 'request-pending', message: 'A local request did not finish within the capture budget' };
  }
}

export function redirectEdgeOutcome(entries, observed, { sourcePath, actualPath } = {}) {
  const partitioned = partitionRequests(entries, {
    sourcePath, actualPath, actualDocumentId: observed?.status?.documentId
  });
  const sourceFailure = requestFailure(partitioned.source.filter(record => record.settledBeforeNavigation === true));
  const lateSourceFailure = requestFailure(partitioned.source.filter(record => record.settledBeforeNavigation === false));
  const unorderedSourceFailure = requestFailure(partitioned.source.filter(record => record.settledBeforeNavigation === undefined));
  const sourcePending = partitioned.source.some(record => record.status === 0);
  const targetHttp = requestFailure(partitioned.target);
  const targetPending = partitioned.target.some(record => record.status === 0)
    ? { code: 'request-pending', message: 'A local request did not finish within the capture budget' }
    : undefined;
  const targetHasSuccess = partitioned.target.some(record => record.status >= 200 && record.status < 300);
  const targetContentVerified = Boolean(observed?.ready && !observed?.status?.alert &&
    (observed?.status?.contentVerified === true || observed?.responseContentVerified === true));
  const backgroundFailure = targetHttp && !targetPending && targetContentVerified && targetHasSuccess
    ? targetHttp : undefined;
  const targetFailure = backgroundFailure ? undefined : (targetHttp || targetPending);
  const ambiguousFailure = requestProblem(partitioned.ambiguous);
  const targetReady = Boolean(observed?.ready && !targetFailure && !ambiguousFailure);
  const targetReason = targetFailure?.message ?? observed?.diagnostic?.message;
  return {
    targetReady,
    ...(targetReason ? { targetReason } : {}),
    ...(sourceFailure ? { sourceFailure } : {}),
    ...(lateSourceFailure ? { lateSourceFailure } : {}),
    ...(unorderedSourceFailure ? { unorderedSourceFailure } : {}),
    ...(sourcePending ? { sourcePending: true } : {}),
    ...(backgroundFailure ? { backgroundFailure } : {}),
    ...(!targetFailure && ambiguousFailure ? { unattributedFailure: ambiguousFailure } : {})
  };
}

export function captureEvidence(node, expected, observed, screenshot, requests, consoleCodes) {
  const path = exactLocalPath(observed.pathname) ? observed.pathname : undefined;
  const actualNode = observed.id;
  const matches = actualNode === expected.target && path === expected.path;
  const expectsTransition = expected.target !== node.id || expected.path !== expected.sourcePath;
  const changed = Boolean(path && (path !== expected.sourcePath || actualNode && actualNode !== node.id));
  const partitioned = changed ? partitionRequests(requests, {
    sourcePath: expected.sourcePath, actualPath: path, actualDocumentId: observed.status?.documentId
  }) : { source: [], target: requests, ambiguous: [] };
  const sourceFailure = requestFailure(partitioned.source.filter(record => record.settledBeforeNavigation === true));
  const lateSourceFailure = requestFailure(partitioned.source.filter(record => record.settledBeforeNavigation === false));
  const unorderedSourceFailure = requestFailure(partitioned.source.filter(record => record.settledBeforeNavigation === undefined));
  const sourcePending = partitioned.source.some(record => record.status === 0)
    ? { code: 'request-pending', message: 'A local request did not finish within the capture budget' }
    : undefined;
  const targetHttp = requestFailure(partitioned.target);
  const targetPending = partitioned.target.some(record => record.status === 0)
    ? { code: 'request-pending', message: 'A local request did not finish within the capture budget' }
    : undefined;
  const targetHasSuccess = partitioned.target.some(record => record.status >= 200 && record.status < 300);
  const targetContentVerified = Boolean(observed?.ready && !observed?.status?.alert &&
    (observed?.status?.contentVerified === true || observed?.responseContentVerified === true));
  const backgroundFailure = changed && targetHttp && !targetPending && targetContentVerified && targetHasSuccess
    ? targetHttp : undefined;
  const targetFailure = backgroundFailure ? undefined : (targetHttp || targetPending);
  const ambiguousFailure = requestProblem(partitioned.ambiguous);
  const blockingTarget = Boolean(targetFailure || ambiguousFailure);
  const sourceRedirect = Boolean(changed && sourceFailure && !blockingTarget);
  const sourceOther = Boolean(changed && !sourceFailure && (lateSourceFailure || unorderedSourceFailure || sourcePending) && !blockingTarget);
  const failure = targetFailure || ambiguousFailure || sourceFailure || lateSourceFailure || unorderedSourceFailure || sourcePending;
  const targetReady = (sourceRedirect || sourceOther)
    ? Boolean(observed.ready && actualNode && path)
    : Boolean(observed.ready && matches && !blockingTarget);
  const transition = sourceRedirect ? 'source-error'
    : matches && expectsTransition ? (!sourceOther && targetReady ? 'verified' : 'observed-url')
    : changed && !matches ? 'unexpected' : undefined;
  const different = !matches && (Boolean(observed.ready) || changed);
  const mismatch = different && { code: 'different-screen', message: 'The observed screen differs from the expected destination' };
  const readyReason = expected.state ? { code: 'special-state', message: expected.state } :
    { code: 'captured', message: 'A rendered frame was verified' };
  const reason = failure || mismatch || observed.diagnostic || (transition === 'verified'
    ? { code: 'expected-transition', message: 'The expected destination became ready' }
    : screenshot && targetReady ? readyReason : { code: 'not-ready', message: 'No matching content became ready' });
  const outcome = failure ? 'blocked' : different ? 'different-screen' :
    transition === 'verified' ? 'transition' :
    screenshot && targetReady ? expected.state ? 'special-state' : 'captured' : 'blocked';
  const phase = failure ? 'request' :
    reason.code.startsWith('navigation') ? 'navigation' :
    reason.code === 'frame-not-observed' ? 'frame' : targetReady ? 'complete' : 'readiness';
  const observations = [failure, mismatch, observed.diagnostic, ...consoleCodes.map(code => ({
    code,
    message: code === 'console-csp' ? 'A renderer resource was blocked by Content Security Policy' : 'The renderer logged an error'
  }))].filter(item => item && item !== reason);
  return { outcome, phase, expectedNode: expected.target, expectedPath: expected.path,
    ...(actualNode ? { actualNode } : {}), ...(path ? { actualPath: path } : {}),
    targetReady, ...(transition ? { transition } : {}),
    ...(sourceFailure ? { sourceFailure } : {}),
    ...(lateSourceFailure ? { lateSourceFailure } : {}),
    ...(unorderedSourceFailure ? { unorderedSourceFailure } : {}),
    ...(sourcePending ? { sourcePending: true } : {}),
    ...(backgroundFailure ? { backgroundFailure } : {}),
    ...(!targetFailure && ambiguousFailure ? { unattributedFailure: ambiguousFailure } : {}),
    ...(outcome === 'special-state' ? { state: expected.state } : {}), reason, observations };
}
