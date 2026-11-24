import { button, element } from './dom.js';
import { createVariants } from './variants.js';

export function createEditor(root, api, generation, preview, open, variantId) {
  let data = structuredClone(preview.scenario.data);
  let disposed = false;
  let timer;
  let inFlight;
  let queued = new Map();
  let errors = [];
  let loading = false;
  let dirtyStructure = false;
  const notices = new Map();
  const heading = element('h3', 'Данные экрана');
  const fields = element('div', undefined, 'fields');
  const status = element('p', undefined, 'editor-status');
  status.setAttribute('role', 'status');
  const hold = button('Удерживать запросы', async () => {
    try {
      await api.loading(generation, preview.id, !loading);
      loading = !loading;
      hold.textContent = loading ? 'Отпустить запросы' : 'Удерживать запросы';
      hold.setAttribute('aria-pressed', String(loading));
    } catch (error) { status.textContent = error.message; }
  });
  hold.setAttribute('aria-pressed', 'false');
  const variants = createVariants(api, generation, preview, open, variantId, flush);
  root.replaceChildren(heading, fields, status, hold, variants.node);
  render();

  function queue(path, value, remove, structural = false) {
    const edit = remove ? { path, remove: true } : { path, value };
    queued.set(JSON.stringify(path), edit);
    dirtyStructure ||= structural;
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 115);
  }

  async function flush() {
    clearTimeout(timer);
    if (disposed) return false;
    inFlight ??= sendEdits().finally(() => { inFlight = undefined; });
    await inFlight;
    if (queued.size && !disposed) return flush();
    return !disposed && !errors.length;
  }

  async function sendEdits() {
    while (queued.size && !disposed) {
      const edits = [...queued.values()];
      const redraw = dirtyStructure;
      dirtyStructure = false;
      queued = new Map();
      status.textContent = 'Применяем…';
      try {
        const result = await api.patch(generation, preview.id, edits);
        if (disposed) return;
        errors = result.errors;
        if (!errors.length) {
          data = result.scenario.data;
          if (redraw && !queued.size) render();
        }
        status.textContent = errors.length ? 'Проверьте отмеченные поля' : '';
      } catch (error) {
        errors = [{ path: '$', message: error.message }];
        status.textContent = error.message;
      }
      for (const [path, message] of notices) {
        message.textContent = errors.filter(error => error.path === path).map(error => error.message).join(' · ');
      }
    }
  }

  function render() {
    notices.clear();
    fields.replaceChildren();
    const schema = preview.schema;
    if (schema?.fields && Object.keys(schema.fields).length) {
      for (const [key, child] of Object.entries(schema.fields)) fields.append(renderField(child, [key], key, data[key], schema.binding));
    } else fields.append(element('p', 'Для экрана не найдены поля', 'read-only'));
  }

  function renderField(schema, path, label, value, inherited) {
    const wrapper = element('div', undefined, 'field');
    const binding = schema.readOnlyReason ? undefined : schema.binding ?? inherited;
    const name = element('label', label);
    const title = element('div', undefined, 'field-title');
    title.append(name);
    wrapper.append(title);
    const description = schema.sources.map(source => source.kind + ' · ' + source.path).join('\n');
    if (description) name.title = description;
    const fieldPath = '$' + path.map(key => Number.isInteger(key) ? '[' + key + ']' : '.' + key).join('');
    const message = element('small', undefined, 'field-error');
    message.setAttribute('aria-live', 'polite');
    notices.set(fieldPath, message);

    if (schema.optional && binding) title.append(button(value === undefined ? 'Добавить' : 'Убрать', () =>
      queue(path, defaultValue(schema), value !== undefined, true)));
    if (schema.nullable && binding && value !== undefined) title.append(button(value === null ? 'Задать' : 'Null', () =>
      queue(path, value === null ? defaultValue(schema) : null, false, true)));

    if (value === undefined || value === null || schema.kind === 'unknown') {
      wrapper.append(element('small', schema.diagnostics?.[0]?.message ??
        (value === null ? 'null' : value === undefined ? 'Значение отсутствует' : String(value)), 'read-only'));
    } else if (schema.kind === 'object') {
      for (const [key, child] of Object.entries(schema.fields ?? {})) {
        wrapper.append(renderField(child, [...path, key], key, value[key], binding));
      }
    } else if (schema.kind === 'array') {
      value.forEach((item, index) => {
        const row = renderField(schema.items, [...path, index], String(index + 1), item, binding);
        if (binding) row.firstChild.append(button('Удалить', () => queue([...path, index], undefined, true, true)));
        wrapper.append(row);
      });
      if (binding) wrapper.append(button('Добавить элемент', () =>
        queue([...path, value.length], defaultValue(schema.items), false, true)));
    } else {
      const input = document.createElement(schema.enum ? 'select' : 'input');
      input.setAttribute('aria-label', label);
      input.disabled = !binding;
      if (schema.enum) {
        schema.enum.forEach((option, index) => {
          const choice = element('option', String(option));
          choice.value = String(index);
          input.append(choice);
        });
        input.value = String(schema.enum.findIndex(option => Object.is(option, value)));
        input.addEventListener('change', () => queue(path, schema.enum[Number(input.value)]));
      } else if (schema.kind === 'boolean') {
        input.type = 'checkbox';
        input.checked = value;
        input.addEventListener('change', () => queue(path, input.checked));
      } else {
        input.type = schema.kind === 'string' ? 'text' : 'number';
        if (schema.kind === 'number') input.step = 'any';
        input.value = String(value);
        if (schema.maxLength !== undefined) input.setAttribute('aria-description', 'Максимум ' + schema.maxLength + ' символов');
        input.addEventListener('input', () => queue(path, input.type === 'number' ?
          (Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null) : input.value));
      }
      name.append(input);
    }
    if (schema.readOnlyReason) wrapper.append(element('small', schema.readOnlyReason, 'read-only'));
    wrapper.append(message);
    return wrapper;
  }

  return () => {
    disposed = true;
    clearTimeout(timer);
    variants.close();
    root.replaceChildren();
  };
}

function defaultValue(schema) {
  if (schema.enum?.length) return schema.enum[0];
  if (schema.kind === 'string') return 'x'.repeat(schema.minLength ?? 0);
  if (schema.kind === 'boolean') return false;
  if (schema.kind === 'number' || schema.kind === 'integer') return Math.min(schema.max ?? Infinity, Math.max(schema.min ?? -Infinity, 0));
  if (schema.kind === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => defaultValue(schema.items));
  if (schema.kind === 'object') return Object.fromEntries(Object.entries(schema.fields ?? {})
    .filter(([, field]) => !field.optional && field.kind !== 'unknown').map(([key, field]) => [key, defaultValue(field)]));
  return null;
}
