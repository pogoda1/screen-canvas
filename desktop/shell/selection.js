import { captureLabels, evidenceLabels, transitionLabels } from './graph.js';

const phases = {
  navigation: 'Документ',
  readiness: 'Готовность',
  frame: 'Кадр',
  request: 'Запрос',
  complete: 'Завершено'
};

function paragraph(text, className) {
  const value = document.createElement('p');
  value.textContent = text;
  if (className) value.className = className;
  return value;
}

function disclosure(title, entries) {
  const section = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = title;
  section.append(summary, ...entries);
  return section;
}

function showCapture(details, report) {
  const section = document.createElement('section');
  section.className = 'capture-details';
  section.append(
    paragraph([captureLabels[report.outcome], phases[report.phase], report.state].filter(Boolean).join(' · ')),
    paragraph('Ожидалось · ' + [report.expectedNode, report.expectedPath].filter(Boolean).join(' · ')),
    paragraph('Наблюдалось · ' + ([report.actualNode, report.actualPath].filter(Boolean).join(' · ') || '—')),
    paragraph(report.targetReady ? 'Экран готов' : 'Готовность экрана не подтверждена'),
    paragraph(report.reason.message, 'diagnostic')
  );
  if (report.transition) section.append(paragraph(transitionLabels[report.transition]));
  if (report.observations.length) section.append(disclosure('Дополнительные наблюдения',
    report.observations.map(observation => paragraph(observation.message, 'diagnostic'))));
  details.append(section);
}

function directionGroup(title, edges, neighborId, neighbors) {
  if (!edges.length) return undefined;
  const section = document.createElement('section');
  section.className = 'edge-group';
  const heading = document.createElement('h4');
  heading.textContent = title;
  const list = document.createElement('ul');
  list.className = 'edge-details';
  for (const edge of edges) {
    const item = document.createElement('li');
    item.dataset.edgeId = edge.id;
    const label = document.createElement('strong');
    label.textContent = edge.label;
    const neighbor = neighbors.get(neighborId(edge));
    const path = neighbor?.path ?? neighborId(edge).replace(/^route:/, '');
    const direction = document.createElement('span');
    direction.className = 'edge-neighbor';
    direction.textContent = [neighbor?.label !== path && neighbor?.label, path,
      neighbor?.state && '#' + neighbor.state].filter(Boolean).join(' · ');
    item.append(label, direction);

    if (edge.condition) item.append(paragraph('Условие · ' + edge.condition));
    if (edge.role) item.append(paragraph('Роль · ' + edge.role));
    for (const step of edge.steps ?? []) {
      if (step.type === 'fill') item.append(paragraph('Значение · ' + JSON.stringify(step.value)));
      if (step.type === 'press') item.append(paragraph('Клавиша · ' + step.key));
    }
    const { evidence } = edge;
    if (edge.expectedPath) item.append(paragraph('Ожидаемый путь · ' + edge.expectedPath));
    if (evidence.actualPath) item.append(paragraph('Наблюдаемый путь · ' + evidence.actualPath));
    const status = paragraph(evidenceLabels[evidence.status], 'edge-status');
    status.dataset.status = evidence.status;
    item.append(status);
    if (evidence.transitionObserved) {
      item.append(paragraph(evidence.targetReady ? 'Цель перехода готова' : 'Готовность цели перехода не подтверждена'));
      if (evidence.targetReason) item.append(paragraph(evidence.targetReason, 'diagnostic'));
    }
    if (evidence.reason) item.append(paragraph(evidence.reason, 'edge-reason'));
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

function showEdges(details, edges, graph, id) {
  if (!edges.length) return;
  const neighbors = new Map(graph.nodes.map(node => [node.id, node]));
  const content = document.createElement('section');
  content.className = 'node-connections';
  const heading = document.createElement('h3');
  heading.textContent = 'Связи экрана';
  content.append(heading);
  const incoming = directionGroup('Входящие', edges.filter(edge => edge.target === id), edge => edge.source, neighbors);
  const outgoing = directionGroup('Исходящие', edges.filter(edge => edge.source === id), edge => edge.target, neighbors);
  if (incoming) content.append(incoming);
  if (outgoing) content.append(outgoing);
  details.append(content);
}

let lastDetails;
export function showNode(details, graph, id) {
  const node = graph?.nodes.find(candidate => candidate.id === id);
  const edges = graph?.edges.filter(edge => edge.source === id || edge.target === id) ?? [];
  const fingerprint = JSON.stringify([id, node?.capture, node?.diagnostics, node?.requests, edges]);
  if (fingerprint === lastDetails && details.firstChild) return;
  lastDetails = fingerprint;
  const open = new Set(details.querySelectorAll('details[open] > summary'));
  const expanded = new Set([...open].map(summary => summary.textContent));
  details.replaceChildren();
  if (!node) return;
  const heading = document.createElement('h2');
  heading.textContent = node.state ? node.label : node.path;
  details.append(heading);
  if (node.capture) showCapture(details, node.capture);
  const warnings = (node.diagnostics ?? []).filter(item =>
    item.code !== node.capture?.reason.code || item.message !== node.capture.reason.message);
  if (warnings.length) details.append(disclosure('Предупреждения анализа кода',
    warnings.map(item => paragraph(item.message, 'diagnostic'))));
  if (node.requests?.length) details.append(disclosure('Запросы экрана', node.requests.map(request =>
    paragraph(request.method + ' ' + request.path + ' → ' + (request.status || '…')))));
  for (const summary of details.querySelectorAll('summary')) {
    if (expanded.has(summary.textContent)) summary.parentElement.open = true;
  }
  showEdges(details, edges, graph, id);
}
