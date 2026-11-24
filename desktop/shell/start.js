import { createEditor } from './editor.js';
import { connectGraph } from './graph.js';
import { connectDivider } from './layout.js';
import { connectPreviewSlot } from './preview-slot.js';
import { showNode } from './selection.js';

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
let disposeEditor;
const refreshBounds = connectPreviewSlot(api, byId('preview-slot'), () => state?.generation);
const map = connectGraph(byId('graph'), open);
connectDivider(divider, workbench, refreshBounds);

const perform = async action => {
  try { await action(); }
  catch (error) { status.textContent = error.message; }
};

async function open(id, variantId) {
  const revision = ++selection;
  disposeEditor?.();
  disposeEditor = undefined;
  selected = id;
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
    disposeEditor = createEditor(byId('editor'), api, state.generation, result, open, variantId);
    return result;
  } catch (error) {
    if (selection === revision) previewError.textContent = error.message;
  }
}

function clearSelection() {
  selection++;
  disposeEditor?.();
  disposeEditor = undefined;
  selected = undefined;
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
  clearSelection();
  await api.rebuild(state.generation);
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
    if (selected) showNode(details, next.graph, selected);
    refreshBounds();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    setTimeout(refresh, 155);
  }
}
void refresh();
