import { nodeLayout } from './layout.js';

export const evidenceLabels = {
  static: 'Из кода',
  confirmed: 'Подтверждено',
  unverified: 'Проверить не удалось'
};

export function connectGraph(viewport, onSelect) {
  const stage = viewport.querySelector('#graph-stage');
  const ink = stage.querySelector('canvas');
  const cards = stage.querySelector('#cards');
  const labels = stage.querySelector('#edge-labels');
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

  function draw() {
    if (!layout) return;
    const context = ink.getContext('2d');
    context.clearRect(0, 0, ink.width, ink.height);
    labels.replaceChildren();
    const offsets = new Map();
    for (const edge of graph.edges) {
      const from = layout.positions.get(edge.source);
      const to = layout.positions.get(edge.target);
      if (!from || !to) continue;
      const pair = edge.source + '→' + edge.target;
      const index = offsets.get(pair) ?? 0;
      offsets.set(pair, index + 1);
      const active = !selected || edge.source === selected || edge.target === selected;
      const start = { x: from.x + 190, y: from.y + 47 + 8 * (index % 6) };
      const end = { x: to.x - 1, y: to.y + 45 + 8 * (index % 6) };
      const bend = Math.min(160, Math.max(35, Math.abs(end.x - start.x) / 2));
      const rail = from.y === to.y && to.x <= from.x ? Math.max(9, from.y - 24 - index * 12) : undefined;
      context.beginPath();
      context.moveTo(start.x, start.y);
      if (rail === undefined) {
        context.bezierCurveTo(start.x + bend, start.y, end.x - bend, end.y, end.x, end.y);
      } else {
        context.bezierCurveTo(start.x + bend, start.y, start.x + bend, rail, start.x + 18, rail);
        context.lineTo(end.x - 18, rail);
        context.bezierCurveTo(end.x - bend, rail, end.x - bend, end.y, end.x, end.y);
      }
      const status = edge.evidence.status;
      context.globalAlpha = active ? 1 : .25;
      context.strokeStyle = status === 'confirmed' ? '#70d6c8' : status === 'unverified' ? '#d4a467' : '#6f8094';
      context.lineWidth = active ? 1.5 : 1;
      context.setLineDash(status === 'confirmed' ? [] : [4, 4]);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      context.moveTo(end.x - 6, end.y - 3);
      context.lineTo(end.x, end.y);
      context.lineTo(end.x - 6, end.y + 3);
      context.stroke();
      if (!active) continue;
      const label = document.createElement('span');
      label.className = 'edge-label ' + status;
      label.textContent = edge.condition || edge.label;
      label.title = [edge.label, edge.condition, evidenceLabels[status], edge.evidence.reason].filter(Boolean).join(' · ');
      label.style.left = (start.x + end.x) / 2 + 'px';
      label.style.top = (rail ?? (start.y + end.y) / 2) - 11 + 'px';
      labels.append(label);
    }
    context.globalAlpha = 1;
  }

  function update(next) {
    graph = next;
    const signature = next.nodes.map(node => node.id + ':' + (node.group ?? '')).join('\n') + JSON.stringify([...collapsed]);
    if (signature !== topology) {
      topology = signature;
      layout = nodeLayout(next.nodes, collapsed);
      const focused = document.activeElement?.dataset?.node;
      stage.style.width = layout.width + 'px';
      stage.style.height = layout.height + 'px';
      ink.width = layout.width;
      ink.height = layout.height;
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
      const valid = node.screenshot?.startsWith('data:image/png;base64,');
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
        picture.textContent = node.diagnostics?.at(-1)?.message ?? 'Ожидает проверки';
      }
      caption.textContent = node.screenshot ? 'Снимок готов' : node.diagnostics?.length ? 'Есть диагностика' : 'Из кода';
    }
    draw();
  }

  return {
    update,
    reset,
    select(id) {
      selected = id;
      for (const [key, { button }] of buttons) button.setAttribute('aria-pressed', String(key === id));
      draw();
    }
  };
}
