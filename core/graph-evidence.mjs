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

export function edgeEvidence(edge, actualTarget, requests, reason, actualPath) {
  const evidence = { status: actualTarget === edge.target && !reason ? 'confirmed' : 'unverified', requests };
  if (edge.expectedPath) evidence.expectedPath = edge.expectedPath;
  if (actualPath) evidence.actualPath = actualPath;
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
