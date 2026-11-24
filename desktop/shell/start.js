import { connectPreviewSlot } from './preview-slot.js';

const api = window.screenCanvas;
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const close = document.querySelector('#close');
const routes = document.querySelector('#routes');
const statusText = {
  idle: 'Выберите папку локального React-проекта',
  starting: 'Запускаем проект',
  scanning: 'Ищем маршруты',
  ready: 'Маршруты найдены',
  error: 'Не удалось открыть проект'
};
let state;
const refreshBounds = connectPreviewSlot(api, document.querySelector('#preview-slot'), () => state?.generation);
const perform = async action => {
  try { await action(); }
  catch (error) { status.textContent = error.message; }
};
document.querySelector('#choose').addEventListener('click', () => perform(() => api.choose()));
retry.addEventListener('click', () => perform(() => api.retry(state.generation)));
close.addEventListener('click', () => perform(() => api.close(state.generation)));

async function refresh() {
  try {
    const next = await api.state();
    if (state?.generation === next.generation && state.status === next.status &&
        state.progress?.completed === next.progress?.completed) return;
    state = next;
    refreshBounds();
    status.textContent = [next.name, statusText[next.status], next.error].filter(Boolean).join(' · ');
    retry.hidden = next.status !== 'error';
    close.hidden = next.status === 'idle';
    routes.replaceChildren(...(next.graph?.nodes ?? []).map(node => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = node.path;
      button.addEventListener('click', () => perform(() => api.open(next.generation, node.id)));
      item.append(button);
      return item;
    }));
  } finally {
    setTimeout(refresh, 160);
  }
}
void refresh();
