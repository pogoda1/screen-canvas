import { createEditor } from './editor.js';
import { connectGraph } from './graph.js';
import { connectDivider } from './layout.js';
import { connectPreviewSlot } from './preview-slot.js';
import { showNode } from './selection.js';

navigation.addEventListener('navigate', event => {
  if (event.destination.url !== 'app://canvas/index.html') event.preventDefault();
});

const api = window.screenCanvas;
const byId = id => document.getElementById(id);
const status = byId('status');
const retry = byId('retry');
const close = byId('close');
const rebuild = byId('rebuild');
const cancel = byId('cancel');
const live = byId('live');
const workbench = byId('workbench');
const divider = byId('divider');
const progress = byId('progress');
const progressLabel = byId('progress-label');
const details = byId('details');
const previewError = byId('preview-error');
const statusText = {
  idle: 'Выберите папку локального React-проекта',
  starting: 'Запускаем проект',
  scanning: 'Ищем маршруты',
  ready: 'Маршруты найдены',
  error: 'Не удалось открыть проект'
};
let state;
let selected;
let selection = 0;
let editor;
let activePreview;
let lastDescription;
let rebuilding;
let rebuildSelection;
let diagnosticSource;
const refreshBounds = connectPreviewSlot(api, byId('preview-slot'), () => state?.generation);
const map = connectGraph(byId('graph'), open);
connectDivider(divider, workbench, refreshBounds);

const perform = async action => {
  try { await action(); }
  catch (error) { status.textContent = error.message; }
};

async function open(id, variantId) {
  const revision = ++selection;
  editor?.close();
  editor = undefined;
  activePreview = undefined;
  selected = id;
  const card = state.graph.nodes.find(node => node.id === id);
  diagnosticSource = card?.capture?.transition ? id : undefined;
  map.select(id);
  showNode(details, state.graph, id);
  workbench.classList.add('has-preview');
  divider.hidden = false;
  live.hidden = false;
  previewError.textContent = '';
  refreshBounds();
  try {
    const result = await api.open(state.generation, id, variantId);
    if (selection !== revision) return;
    activePreview = result.id;
    lastDescription = descriptionFingerprint(result);
    editor = createEditor(byId('editor'), api, state.generation, result, open, variantId);
    return result;
  } catch (error) {
    if (selection === revision) previewError.textContent = error.message;
  }
}

function clearSelection() {
  selection++;
  editor?.close();
  editor = undefined;
  activePreview = undefined;
  selected = undefined;
  diagnosticSource = undefined;
  map.select(undefined);
  details.replaceChildren();
  live.hidden = true;
  divider.hidden = true;
  workbench.classList.remove('has-preview');
}

byId('choose').addEventListener('click', () => perform(() => api.choose()));
retry.addEventListener('click', () => perform(() => api.retry(state.generation)));
close.addEventListener('click', () => perform(() => api.close(state.generation)));
cancel.addEventListener('click', () => perform(() => api.cancelScan(state.generation)));
rebuild.addEventListener('click', () => perform(async () => {
  rebuilding = state.generation;
  rebuildSelection = diagnosticSource ?? selected;
  byId('graph').inert = true;
  rebuild.disabled = true;
  clearSelection();
  try { await api.rebuild(rebuilding); }
  catch (error) {
    byId('graph').inert = false;
    rebuild.disabled = false;
    rebuilding = undefined;
    rebuildSelection = undefined;
    throw error;
  }
}));

async function refresh() {
  try {
    const next = await api.state(state?.version);
    if (!next) return;
    if (state?.generation !== next.generation) {
      clearSelection();
      map.reset();
    }
    state = next;
    status.textContent = [next.name, statusText[next.status], next.error].filter(Boolean).join(' · ');
    retry.hidden = next.status !== 'error';
    close.hidden = next.status === 'idle';
    rebuild.hidden = next.status !== 'ready';
    if (rebuilding !== undefined && next.generation !== rebuilding && !['starting', 'scanning'].includes(next.status)) {
      byId('graph').inert = false;
      rebuild.disabled = false;
      rebuilding = undefined;
    }
    const { total, completed } = next.progress ?? {};
    const running = total > completed && !next.scanCancelled && !next.scanError;
    cancel.hidden = !running;
    progress.hidden = !running;
    if (running) {
      progress.max = total;
      progress.value = completed;
    }
    progressLabel.textContent = next.scanError ?? (next.scanCancelled ? 'Обход остановлен' :
      total ? `${completed} из ${total} проверок` : '');
    map.update(next.graph ?? { nodes: [], edges: [] });
    const description = next.live;
    const fingerprint = description && descriptionFingerprint(description);
    if (description && description.id === activePreview && fingerprint !== lastDescription) {
      lastDescription = fingerprint;
      selected = description.nodeId;
      map.select(diagnosticSource ?? selected);
      editor?.follow(description);
    }
    if (selected) showNode(details, next.graph, diagnosticSource ?? selected);
    if (rebuilding === undefined && rebuildSelection) {
      const id = rebuildSelection;
      rebuildSelection = undefined;
      if (next.graph?.nodes.some(node => node.id === id)) void open(id);
    }
    refreshBounds();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    setTimeout(refresh, 155);
  }
}
function descriptionFingerprint(description) {
  return JSON.stringify([description.id, description.nodeId, description.scenario.params]);
}
void refresh();
