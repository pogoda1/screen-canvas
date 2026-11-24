export function nodeLayout(nodes, collapsed) {
  const groups = new Map();
  for (const node of nodes) {
    const key = node.group ?? (node.state ? node.path : '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const positions = new Map();
  const labels = [];
  const rowHeight = 462;
  let row = 0;
  let columns = 1;
  for (const [name, items] of groups) {
    if (name) labels.push({ name, y: row * rowHeight + 8, firstId: items[0].id });
    if (collapsed.has(name)) {
      row += 0.22;
      continue;
    }
    items.forEach((node, index) => {
      const col = index % 4;
      columns = Math.max(columns, col + 1);
      positions.set(node.id, { x: 31 + col * 244, y: 44 + (row + Math.floor(index / 4)) * rowHeight });
    });
    row += Math.ceil(items.length / 4);
  }
  return { positions, labels, width: 64 + columns * 244, height: Math.ceil(60 + row * rowHeight) };
}

export function connectDivider(divider, workbench, onResize) {
  let start;
  const update = value => {
    const max = workbench.clientWidth - 324;
    const width = Math.min(Math.max(286, max), Math.max(286, value));
    workbench.style.setProperty('--map-width', width + 'px');
    divider.setAttribute('aria-valuenow', String(Math.round(width)));
    onResize();
  };
  divider.addEventListener('pointerdown', event => {
    start = { x: event.clientX, width: divider.offsetLeft - workbench.offsetLeft };
    divider.setPointerCapture(event.pointerId);
  });
  divider.addEventListener('pointermove', event => {
    if (start) update(start.width + event.clientX - start.x);
  });
  for (const event of ['pointerup', 'lostpointercapture']) divider.addEventListener(event, () => { start = undefined; });
  divider.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    update(divider.offsetLeft - workbench.offsetLeft + (event.key === 'ArrowRight' ? 24 : -24));
  });
}
