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

let lastDetails;
export function showNode(details, graph, id) {
  const node = graph?.nodes.find(candidate => candidate.id === id);
  const edges = graph?.edges.filter(edge => edge.source === id) ?? [];
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
