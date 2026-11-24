export const browserKey = Symbol.for('react-screen-canvas.browser');

export function registerBrowserBindings(bindings) {
  const bridge = globalThis[browserKey];
  if (!bridge) return () => {};
  return bridge.register(bindings);
}

export function getInitialScenario() {
  return globalThis[browserKey]?.initial;
}
