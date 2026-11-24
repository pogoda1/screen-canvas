export function assertJson(value) {
  const ancestors = new Set();
  function check(item, depth) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' ||
        Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || depth > 64 || ancestors.has(item)) {
      throw new TypeError('Expected finite, acyclic JSON');
    }
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Expected a plain JSON object');
    }
    ancestors.add(item);
    for (const child of Object.values(item)) check(child, depth + 1);
    ancestors.delete(item);
  }
  check(value, 0);
  return value;
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertScenario(value) {
  assertJson(value);
  if (!isRecord(value) || value.version !== 1 ||
      typeof value.nodeId !== 'string' || !value.nodeId ||
      !Number.isSafeInteger(value.seed) || !isRecord(value.params) ||
      !Object.values(value.params).every(param => typeof param === 'string') ||
      typeof value.mode !== 'string' || !value.mode || !isRecord(value.data) ||
      (value.draft !== undefined && !isRecord(value.draft))) {
    throw new TypeError('Invalid scenario');
  }
  return value;
}

export function matchesStamp(actual, expected) {
  return ['generation', 'sessionId', 'documentId', 'revision']
    .every(key => actual[key] === expected[key]);
}
