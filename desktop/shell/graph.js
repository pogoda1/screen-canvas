import { nodeLayout } from './layout.js';

export const evidenceLabels = {
  static: 'Из кода',
  confirmed: 'Подтверждено',
  unverified: 'Проверить не удалось'
};

export const captureLabels = {
  captured: 'Снимок готов',
  'special-state': 'Отдельное состояние',
  transition: 'Переход подтверждён',
  'different-screen': 'Другой экран',
  blocked: 'Снимок недоступен'
};

export const transitionLabels = {
  verified: 'Переход подтверждён',
  'observed-url': 'Путь наблюдался, цель не готова',
  unexpected: 'Незаявленное назначение'
};

export function connectGraph(viewport, onSelect) {
  const stage = viewport.querySelector('#graph-stage');
  const cards = stage.querySelector('#cards');
  const buttons = new Map();
  const collapsed = new Set();
  let graph;
  let layout;
  let selected;
  let scale = 1;
  let x = 0;
  let y = 0;
  let drag;
  let topology;

  function transform() {
    stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    document.querySelector('#zoom-value').textContent = Math.round(scale * 100) + '%';
  }
  const reset = () => { scale = 1; x = 0; y = 0; transform(); };
  const zoom = (ratio, pointX = viewport.clientWidth / 2, pointY = viewport.clientHeight / 2) => {
    const next = Math.min(1.8, Math.max(.35, scale * ratio));
    x = pointX - (pointX - x) * next / scale;
    y = pointY - (pointY - y) * next / scale;
    scale = next;
    transform();
  };
  document.querySelector('#zoom-in').addEventListener('click', () => zoom(1.15));
  document.querySelector('#zoom-out').addEventListener('click', () => zoom(1 / 1.15));
  document.querySelector('#zoom-value').addEventListener('click', reset);
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = viewport.getBoundingClientRect();
      zoom(Math.exp(-event.deltaY / 300), event.clientX - rect.left, event.clientY - rect.top);
    } else { x -= event.deltaX; y -= event.deltaY; transform(); }
  }, { passive: false });
  viewport.addEventListener('pointerdown', event => {
    if (event.target.closest('button, summary') || event.button !== 0) return;
    drag = { x: event.clientX - x, y: event.clientY - y };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('panning');
  });
  viewport.addEventListener('pointermove', event => {
    if (!drag) return;
    x = event.clientX - drag.x;
    y = event.clientY - drag.y;
    transform();
  });
  for (const event of ['pointerup', 'lostpointercapture']) viewport.addEventListener(event, () => {
    drag = undefined;
    viewport.classList.remove('panning');
  });
  viewport.addEventListener('keydown', event => {
    if (event.target === viewport && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
      event.preventDefault();
      x += event.key === 'ArrowLeft' ? 72 : event.key === 'ArrowRight' ? -72 : 0;
      y += event.key === 'ArrowUp' ? 72 : event.key === 'ArrowDown' ? -72 : 0;
      transform();
    }
  });

  function update(next) {
    graph = next;
    const signature = next.nodes.map(node => node.id + ':' + (node.group ?? '')).join('\n') + JSON.stringify([...collapsed]);
    if (signature !== topology) {
      topology = signature;
      layout = nodeLayout(next.nodes, collapsed);
      const focused = document.activeElement?.dataset?.node;
      stage.style.width = layout.width + 'px';
      stage.style.height = layout.height + 'px';
      cards.replaceChildren();
      buttons.clear();
      for (const group of layout.labels) {
        const heading = document.createElement('button');
        heading.className = 'group-heading';
        heading.textContent = group.name;
        heading.style.top = group.y + 'px';
        heading.setAttribute('aria-expanded', String(!collapsed.has(group.name)));
        heading.addEventListener('click', () => {
          if (collapsed.has(group.name)) collapsed.delete(group.name);
          else collapsed.add(group.name);
          update(graph);
          [...cards.querySelectorAll('.group-heading')].find(button => button.textContent === group.name)?.focus();
        });
        cards.append(heading);
      }
      for (const node of next.nodes) {
        const button = document.createElement('button');
        button.className = 'node';
        button.dataset.node = node.id;
        const position = layout.positions.get(node.id);
        if (!position) continue;
        const { x, y } = position;
        button.style.left = x + 'px';
        button.style.top = y + 'px';
        const title = document.createElement('strong');
        title.textContent = node.state ? node.label : node.path + (node.index ? ' · index' : '');
        button.setAttribute('aria-label', title.textContent);
        const picture = document.createElement('div');
        picture.className = 'node-image';
        const caption = document.createElement('small');
        button.append(title, picture, caption);
        button.addEventListener('click', () => onSelect(node.id));
        cards.append(button);
        buttons.set(node.id, { button, picture, caption });
      }
      if (focused) buttons.get(focused)?.button.focus({ preventScroll: true });
    }
    for (const node of next.nodes) {
      const card = buttons.get(node.id);
      if (!card) continue;
      const { button, picture, caption } = card;
      button.setAttribute('aria-pressed', String(selected === node.id));
      const report = node.capture;
      const valid = node.screenshot?.startsWith('data:image/png;base64,');
      const status = captureLabels[report?.outcome];
      const destination = report?.transition && report.actualPath;
      button.title = [status, report?.state, destination, report?.reason.message].filter(Boolean).join(' · ');
      button.setAttribute('aria-description', button.title);
      if (valid && picture.dataset.src !== node.screenshot) {
        picture.dataset.src = node.screenshot;
        const img = document.createElement('img');
        img.src = node.screenshot;
        img.alt = '';
        img.loading = 'lazy';
        picture.replaceChildren(img);
      }
      if (!valid) {
        picture.dataset.src = '';
        const summary = report?.transition === 'verified' ? report.actualPath : report?.reason.message;
        picture.textContent = summary ?? 'Ожидает проверки';
      }
      caption.textContent = [transitionLabels[report?.transition] ?? status ?? 'Из кода',
        report?.state, report?.transition !== 'verified' && destination].filter(Boolean).join(' · ');
    }
  }

  return {
    update,
    reset,
    select(id) {
      selected = id;
      for (const [key, { button }] of buttons) button.setAttribute('aria-pressed', String(key === id));
    }
  };
}
