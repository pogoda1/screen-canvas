import { isDeepStrictEqual } from 'node:util';
import { assertJson, isRecord } from '../contracts.mjs';

export function validateValue(schema, value, path = '$', allowUnknown = false) {
  const errors = [];
  const add = (code, message) => errors.push({ code, path, message });
  if (value === undefined) {
    if (!schema.optional && schema.kind !== 'unknown') add('required', 'A value is required');
  } else if (value === null) {
    if (!schema.nullable) add('null', 'Null is not allowed');
  } else if (schema.enum && !schema.enum.some(member => isDeepStrictEqual(member, value))) {
    add('enum', 'Select a permitted value');
  } else if (schema.kind === 'object' && isRecord(value)) {
    for (const [name, child] of Object.entries(schema.fields ?? {})) {
      errors.push(...validateValue(child, Object.hasOwn(value, name) ? value[name] : undefined, path + '.' + name, allowUnknown));
    }
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(schema.fields ?? {}, name)) errors.push({
        code: 'unknown-field', path: path + '.' + name, message: 'The field is not in the current schema'
      });
    }
  } else if (schema.kind === 'array' && Array.isArray(value)) {
    if (value.length < schema.minItems || value.length > schema.maxItems) add('size', 'List length is out of bounds');
    if (schema.items) value.forEach((item, index) => errors.push(...validateValue(schema.items, item, path + '[' + index + ']', allowUnknown)));
  } else if (schema.kind === 'string' && typeof value === 'string') {
    if (value.length < schema.minLength || value.length > schema.maxLength) add('length', 'Text length is out of bounds');
  } else if (['number', 'integer'].includes(schema.kind) && Number.isFinite(value) &&
      (schema.kind !== 'integer' || Number.isInteger(value))) {
    if (value < schema.min || value > schema.max) add('range', 'Number is out of bounds');
  } else if (!(schema.kind === 'boolean' && typeof value === 'boolean') && !(schema.kind === 'unknown' && allowUnknown)) {
    add('type', 'Expected ' + schema.kind);
  }
  return errors;
}

export function validatePatch(schema, previous, edits) {
  const candidate = structuredClone(previous);
  const errors = [];
  for (const { path, value, remove } of edits) {
    let item = candidate;
    let field = schema;
    let bound = field.binding;
    const display = '$' + (Array.isArray(path) ? path.map(key => typeof key === 'number' ? '[' + key + ']' : '.' + key).join('') : '');
    if (!Array.isArray(path) || !path.length) {
      errors.push({ code: 'path', path: display, message: 'Select a field' });
      continue;
    }
    for (const key of path.slice(0, -1)) {
      field = lookup(field, key);
      item = item && Object.hasOwn(item, key) ? item[key] : undefined;
      bound = field?.binding ?? bound;
    }
    const key = path.at(-1);
    field = lookup(field, key);
    if (!item || typeof item !== 'object' || (Array.isArray(item) && key > item.length) || !field || field.kind === 'unknown' || !(field.binding ?? bound)) {
      errors.push({ code: 'read-only', path: display, message: 'The field has no editable binding' });
      continue;
    }
    const fieldErrors = remove && Array.isArray(item) ? [] : validateValue(field, remove ? undefined : value, display);
    if (fieldErrors.length) {
      errors.push(...fieldErrors);
      continue;
    }
    if (!remove) {
      try { assertJson(value); } catch {
        errors.push({ code: 'json', path: display, message: 'Expected a JSON value' });
        continue;
      }
      Object.defineProperty(item, key, { value: structuredClone(value), writable: true, configurable: true, enumerable: true });
    } else if (Array.isArray(item)) item.splice(key, 1);
    else delete item[key];
  }
  if (!errors.length) errors.push(...validateValue(schema, candidate, '$', true));
  return errors.length ? { errors } : { value: candidate, errors };
}

function lookup(field, key) {
  if (field?.kind === 'array' && Number.isSafeInteger(key) && key >= 0) return field.items;
  if (field?.kind === 'object' && typeof key === 'string' && Object.hasOwn(field.fields ?? {}, key)) return field.fields[key];
}
