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

export function edgeEvidence(edge, actualTarget, requests, reason) {
  const evidence = { status: actualTarget === edge.target && !reason ? 'confirmed' : 'unverified', requests };
  if (actualTarget) evidence.actualTarget = actualTarget;
  if (evidence.status !== 'confirmed') evidence.reason = reason ?? 'The expected target was not observed';
  return evidence;
}
