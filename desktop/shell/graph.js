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
  'source-error': 'Переход после ошибки источника',
  unexpected: 'Незаявленное назначение'
};

export function transitionLabel(report) {
  if (!report?.transition) return undefined;
  if (report.transition === 'observed-url') {
    if (report.unattributedFailure) return 'Путь наблюдался, источник ошибки не определён';
    if (report.lateSourceFailure && !report.sourceFailure) return 'Наблюдался переход; ответ источника пришёл после перехода';
    if (report.sourcePending && !report.sourceFailure) return 'Наблюдался переход; запрос источника не завершился';
  }
  return transitionLabels[report.transition];
}

export function observedTarget(edge) {
  const evidence = edge.evidence;
  if (evidence.status === 'static' || evidence.status === 'confirmed') return edge.target;
  if (evidence.transitionObserved && (edge.action !== 'redirect' || edge.direct)) return evidence.actualTarget;
}

export function connectionTarget(edge, nodes) {
  const target = observedTarget(edge);
  const node = nodes.get(target);
  if (!node) return;
  const path = edge.evidence.actualPath ?? edge.expectedPath;
  if (node.screenshot && (!path || path !== node.capture?.actualPath)) return;
  return target;
}

function connector(from, to, offset, originY, sameNode) {
  const y = originY ?? from.y + Math.min(from.height - 2, from.height / 2 + offset);
  const targetY = to.y + Math.min(to.height - 2, to.height / 2 + offset);
  if (sameNode) {
    const x = from.x + from.width + 1;
    const rail = x + 42 + offset;
    const endY = Math.abs(y - targetY) < 14 ? Math.min(y + 32, from.y + from.height - 2) : targetY;
    return { x, y, d: `M ${x} ${y} C ${rail} ${y - 30}, ${rail} ${endY + 30}, ${x} ${endY}` };
  }
  if (from.x === to.x) {
    const x = from.x + from.width + 1;
    const targetX = to.x + to.width + 1;
    const rail = Math.max(x, targetX) + 30 + offset;
    return { x, y, d: `M ${x} ${y} C ${rail} ${y}, ${rail} ${targetY}, ${targetX} ${targetY}` };
  }
  const leftToRight = from.x < to.x;
  const x = from.x + (leftToRight ? from.width + 1 : -1);
  const targetX = to.x + (leftToRight ? -1 : to.width + 1);
  const bend = Math.min(104, Math.abs(targetX - x) * .6) * (leftToRight ? 1 : -1);
  return { x, y, d: `M ${x} ${y} C ${x + bend} ${y}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}` };
}

export function connectGraph(viewport, onSelect) {
  const stage = viewport.querySelector('#graph-stage');
  const cards = stage.querySelector('#cards');
  const connections = stage.querySelector('#connections');
  const origins = stage.querySelector('#connection-origins');
  const segments = connections.querySelector('g');
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

  function bounds(id) {
    const position = layout.positions.get(id);
    const card = buttons.get(id);
    if (position && card) return {
      ...position, width: card.button.offsetWidth, height: card.button.offsetHeight,
      picture: card.button.dataset.frame === 'true' ? card.picture : undefined
    };
  }

  function svg(tag, attributes) {
    const element = document.createElementNS(connections.namespaceURI, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function drawConnections() {
    const drawn = [];
    const leaders = [];
    const counts = new Map();
    const nodes = new Map(graph?.nodes.map(node => [node.id, node]));
    if (selected && layout) for (const edge of graph.edges) {
      const target = connectionTarget(edge, nodes);
      if (!target || edge.source !== selected && target !== selected) continue;
      const from = bounds(edge.source);
      const to = bounds(target);
      if (!from || !to) continue;
      const pair = [edge.source, target].sort().join('\n');
      const count = counts.get(pair) ?? 0;
      counts.set(pair, count + 1);
      const { status, origin, actionFailure, sourceFailure, unattributedFailure, transitionObserved, targetReady } = edge.evidence;
      const appearance = actionFailure || sourceFailure || unattributedFailure || transitionObserved && !targetReady ? 'unverified' : status;
      const point = origin && from.picture && {
        x: from.x + from.picture.offsetLeft + origin.x * from.picture.offsetWidth,
        y: from.y + from.picture.offsetTop + origin.y * from.picture.offsetHeight
      };
      const port = connector(from, to, (count % 9) * 5, point?.y, edge.source === target);
      drawn.push(svg('path', {
        'data-edge-id': edge.id, 'data-target': target, 'data-status': appearance,
        'data-origin': point ? 'control' : 'screen',
        d: port.d, 'marker-end': 'url(#arrow-' + appearance + ')'
      }));
      if (point) {
        const mark = svg('g', { 'data-edge-id': edge.id, 'data-status': appearance });
        mark.append(svg('line', { x1: point.x, y1: point.y, x2: port.x, y2: port.y }),
          svg('circle', { cx: point.x, cy: point.y, r: 4.2 }));
        leaders.push(mark);
      }
    }
    segments.replaceChildren(...drawn);
    origins.replaceChildren(...leaders);
    connections.toggleAttribute('hidden', !drawn.length);
    origins.toggleAttribute('hidden', !leaders.length);
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
      for (const layer of [connections, origins]) {
        layer.setAttribute('width', String(layout.width));
        layer.setAttribute('height', String(layout.height));
      }
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
      button.dataset.frame = String(Boolean(valid));
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
      caption.hidden = Boolean(valid && !report?.state);
      caption.textContent = [transitionLabel(report) ?? status ?? 'Из кода',
        report?.state, report?.transition !== 'verified' && destination].filter(Boolean).join(' · ');
    }
    drawConnections();
  }

  return {
    update,
    reset,
    select(id) {
      selected = id;
      for (const [key, { button }] of buttons) button.setAttribute('aria-pressed', String(key === id));
      drawConnections();
    }
  };
}
