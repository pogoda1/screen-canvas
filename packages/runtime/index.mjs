export function defineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError('Expected a project adapter object');
  }
  return adapter;
}
