export function clampBounds(rect, { width, height }) {
  const { x, y, width: requestedWidth, height: requestedHeight } = rect;
  if (![x, y, requestedWidth, requestedHeight].every(Number.isFinite) || requestedWidth < 0 || requestedHeight < 0) {
    throw new Error('Invalid preview bounds');
  }
  const clamp = (n, max) => Math.min(max, Math.max(0, Math.round(n)));
  const left = clamp(x, width);
  const top = clamp(y, height);
  return {
    x: left, y: top,
    width: Math.max(0, clamp(x + requestedWidth, width) - left),
    height: Math.max(0, clamp(y + requestedHeight, height) - top)
  };
}
