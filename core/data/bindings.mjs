import { isDeepStrictEqual } from 'node:util';

export function mergeSchemas(first, second, path = '$') {
  if (!first || !second) return first ?? second;
  const sources = [...first.sources, ...second.sources];
  const conflict = () => ({ kind: 'unknown', sources, diagnostics: [
    { code: 'schema-conflict', message: 'Sources disagree about the field', path }
  ] });
  const compatible = first.kind === second.kind ||
    [first.kind, second.kind].every(kind => kind === 'number' || kind === 'integer');
  if (!compatible) return conflict();
  const kind = first.kind === 'integer' ? 'integer' : second.kind;
  const result = { ...first, ...second, kind, sources,
    optional: Boolean(first.optional && second.optional), nullable: Boolean(first.nullable && second.nullable) };
  if (first.enum && second.enum) {
    result.enum = first.enum.filter(value => second.enum.some(other => isDeepStrictEqual(value, other)));
    if (!result.enum.length) return conflict();
  }
  for (const [lower, upper] of [['min', 'max'], ['minLength', 'maxLength'], ['minItems', 'maxItems']]) {
    const minima = [first[lower], second[lower]].filter(Number.isFinite);
    const maxima = [first[upper], second[upper]].filter(Number.isFinite);
    if (minima.length) result[lower] = Math.max(...minima);
    if (maxima.length) result[upper] = Math.min(...maxima);
    if (result[lower] > result[upper]) return conflict();
  }
  if (kind === 'object') {
    const names = new Set([...Object.keys(first.fields ?? {}), ...Object.keys(second.fields ?? {})]);
    result.fields = Object.fromEntries([...names].map(name => [
      name, mergeSchemas(first.fields?.[name], second.fields?.[name], path + '.' + name)
    ]));
  }
  if (kind === 'array') result.items = mergeSchemas(first.items, second.items, path + '[]');
  return result;
}

export function bindSchema(field, bindings, path = '$') {
  const binding = bindings[path] ?? field.binding;
  const result = { ...field };
  if (binding && field.kind !== 'unknown') result.binding = binding;
  if (field.fields) result.fields = Object.fromEntries(Object.entries(field.fields).map(([key, value]) =>
    [key, bindSchema(value, bindings, path + '.' + key)]));
  if (field.items) result.items = bindSchema(field.items, bindings, path + '[]');
  return result;
}

export function resolveNodeSchema({ props, requests }, operations, bindings = {}, explicit) {
  const fields = new Map();
  for (const propSchema of props) {
    if (propSchema.kind !== 'object') continue;
    for (const [name, schema] of Object.entries(propSchema.fields)) {
      fields.set(name, mergeSchemas(fields.get(name), schema, '$.' + name));
    }
  }
  for (const request of requests) {
    const template = request.method + ' ' + request.path;
    const fromApi = operations.get(template);
    const schema = mergeSchemas(request.schema, fromApi, '$.' + template);
    if (!schema) continue;
    fields.set(template, mergeSchemas(fields.get(template), {
      ...schema, binding: { kind: 'api', key: template }
    }, '$.' + template));
  }
  if (!fields.size) return explicit && bindSchema(explicit, bindings);
  const discovered = { kind: 'object', sources: [], fields: Object.fromEntries(fields) };
  return bindSchema(mergeSchemas(discovered, explicit), bindings);
}
