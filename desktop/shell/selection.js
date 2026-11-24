import { evidenceLabels } from './graph.js';

export function showNode(details, graph, id) {
  const node = graph?.nodes.find(candidate => candidate.id === id);
  details.replaceChildren();
  if (!node) return;
  const heading = document.createElement('h2');
  heading.textContent = node.state ? node.label : node.path;
  details.append(heading);
  for (const diagnostic of node.diagnostics ?? []) {
    const entry = document.createElement('p');
    entry.className = 'diagnostic';
    entry.textContent = diagnostic.message;
    details.append(entry);
  }
  if (node.requests?.length) {
    const requests = document.createElement('details');
    const title = document.createElement('summary');
    title.textContent = 'Запросы экрана';
    requests.append(title);
    for (const request of node.requests) {
      const entry = document.createElement('p');
      entry.textContent = request.method + ' ' + request.path + ' → ' + (request.status || '…');
      requests.append(entry);
    }
    details.append(requests);
  }
  const edges = graph.edges.filter(edge => edge.source === id);
  if (!edges.length) return;
  const list = document.createElement('ul');
  list.className = 'edge-details';
  for (const edge of edges) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = edge.label + ' → ' + (edge.expectedPath ?? edge.target.replace(/^route:/, ''));
    const evidence = document.createElement('small');
    evidence.textContent = [edge.condition, edge.role, evidenceLabels[edge.evidence.status], edge.evidence.reason].filter(Boolean).join(' · ');
    item.append(label, evidence);
    list.append(item);
  }
  details.append(list);
}
