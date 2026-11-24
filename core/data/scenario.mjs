import { assertScenario } from '../contracts.mjs';
import { validateValue } from './validate.mjs';

export function makeScenario(node, { schema, fixture, seed = 1, params = {}, mode = 'default', entities = [], draft } = {}) {
  const data = schema ? generate(schema, fixture, seed) : structuredClone(fixture ?? {});
  const routeParams = Object.fromEntries([...node.path.matchAll(/:([\w]+)\??/g)]
    .map(([, name]) => [name, String(params[name] ?? name + '-' + Math.abs(seed))]));
  for (const { param, field, prefix = param } of entities) {
    const record = field.slice(0, -1).reduce((value, key) => value?.[key], data);
    const name = field.at(-1);
    const id = params[param] ?? (record && (typeof record[name] === 'string' || Number.isFinite(record[name]))
      ? record[name] : prefix + '-' + Math.abs(seed));
    routeParams[param] = String(id);
    if (record && Object.hasOwn(record, name)) record[name] = typeof record[name] === 'number' ? Number(id) : String(id);
  }
  if (schema) {
    const errors = validateValue(schema, data, '$', true);
    if (errors.length) throw new Error(errors.map(error => error.path + ' ' + error.message).join('; '));
  }
  return assertScenario({ version: 1, nodeId: node.id, seed, params: routeParams, mode, data,
    ...(draft ? { draft: structuredClone(draft) } : {}) });
}

function generate(schema, fixture, seed) {
  if (fixture === null && schema.nullable) return null;
  if (schema.optional && fixture === undefined) return undefined;
  if (schema.kind === 'object') {
    return Object.fromEntries(Object.entries(schema.fields ?? {}).flatMap(([name, child]) => {
      const value = generate(child, fixture && Object.hasOwn(fixture, name) ? fixture[name] : undefined, seed);
      return value === undefined ? [] : [[name, value]];
    }));
  }
  if (fixture !== undefined && !validateValue(schema, fixture, '$', true).length) return structuredClone(fixture);
  if (schema.optional || schema.kind === 'unknown') return undefined;
  if (schema.enum?.length) return structuredClone(schema.enum[Math.abs(seed) % schema.enum.length]);
  if (schema.kind === 'array') {
    const length = Math.min(schema.maxItems ?? Infinity, Math.max(schema.minItems ?? 0, Array.isArray(fixture) ? fixture.length : 0));
    return Array.from({ length }, (_, index) => generate(schema.items, fixture?.[index], seed + index));
  }
  if (schema.kind === 'string') {
    const text = 'Sample ' + Math.abs(seed);
    return text.padEnd(schema.minLength ?? 0, 'x').slice(0, schema.maxLength ?? Infinity);
  }
  if (schema.kind === 'number' || schema.kind === 'integer') {
    const min = schema.min ?? -Infinity;
    const max = schema.max ?? Infinity;
    return schema.kind === 'integer' ? Math.min(Math.floor(max), Math.max(Math.ceil(min), 0)) :
      Math.min(max, Math.max(min, 0));
  }
  if (schema.kind === 'boolean') return false;
}

export function scenarioUrl(node, scenario) {
  return node.path.replace(/:([\w]+)\??/g, (_, name) => encodeURIComponent(scenario.params[name] ?? name))
    .replace(/\*$/, 'missing');
}
