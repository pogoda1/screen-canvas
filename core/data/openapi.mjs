const jsonType = 'application/json';

export function openApiOperations(document, filename = 'openapi.json') {
  function resolve(ref) {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
    return ref.slice(2).split('/').reduce((value, segment) => {
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
      return value && Object.hasOwn(value, key) ? value[key] : undefined;
    }, document);
  }

  function convert(schema, source, ancestors = new Set()) {
    const base = { sources: [{ kind: 'openapi', path: filename + '#' + source }] };
    const unknown = (code, message) => ({ ...base, kind: 'unknown', diagnostics: [{ code, message, path: source }] });
    if (!schema || typeof schema !== 'object') return unknown('unsupported-schema', 'Expected a JSON schema');
    if (schema.$ref) {
      if (ancestors.has(schema.$ref)) return unknown('recursive-ref', schema.$ref);
      const target = resolve(schema.$ref);
      if (!target) return unknown('unresolved-ref', schema.$ref);
      const result = convert(target, schema.$ref.slice(1), new Set(ancestors).add(schema.$ref));
      return { ...result, sources: [...base.sources, ...result.sources] };
    }
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(type => type !== 'null');
    const kind = types.length === 1 && types[0] || (schema.properties ? 'object' : undefined);
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(kind) ||
        schema.oneOf || schema.anyOf || schema.allOf) return unknown('unsupported-schema', 'Unsupported JSON schema shape');
    const field = { ...base, kind };
    if (schema.nullable || (Array.isArray(schema.type) && schema.type.includes('null'))) field.nullable = true;
    if (Array.isArray(schema.enum)) field.enum = schema.enum;
    if (kind === 'object') {
      field.fields = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => {
        const field = convert(child, source + '/properties/' + key, ancestors);
        if (!schema.required?.includes(key)) field.optional = true;
        return [key, field];
      }));
    } else if (kind === 'array') field.items = convert(schema.items, source + '/items', ancestors);
    for (const [from, to] of Object.entries({
      minimum: 'min', maximum: 'max', minLength: 'minLength', maxLength: 'maxLength',
      minItems: 'minItems', maxItems: 'maxItems'
    })) if (Number.isFinite(schema[from])) field[to] = schema[from];
    return field;
  }

  const operations = new Map();
  for (const [pathname, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'patch', 'put', 'delete', 'options', 'head'].includes(method)) continue;
      const response = Object.entries(operation.responses ?? {}).find(([status]) => /^2\d\d$/.test(status));
      const contents = response && (resolve(response[1].$ref) ?? response[1]).content;
      if (!contents?.[jsonType]?.schema) continue;
      const source = '/paths/' + pathname.replaceAll('~', '~0').replaceAll('/', '~1') +
        '/' + method + '/responses/' + response[0] + '/content/application~1json/schema';
      operations.set(method.toUpperCase() + ' ' + pathname.replaceAll(/\{([^}]+)\}/g, ':$1'), convert(contents[jsonType].schema, source));
    }
  }
  return operations;
}
