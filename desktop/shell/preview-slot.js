export function connectPreviewSlot(api, slot, getGeneration) {
  function refresh() {
    const generation = getGeneration();
    if (generation === undefined) return;
    const { x, y, width, height } = slot.getBoundingClientRect();
    void api.bounds(generation, { x, y, width, height }).catch(() => {});
  }
  const size = new ResizeObserver(refresh);
  size.observe(slot);
  window.addEventListener('resize', refresh);
  return refresh;
}
