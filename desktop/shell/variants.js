import { button, element } from './dom.js';

const variantStatus = {
  incompatible: 'Несовместимый вариант',
  orphaned: 'Экран отсутствует',
  corrupt: 'JSON повреждён'
};

export function createVariants(api, generation, preview, open, initialId, flush) {
  const node = element('section', undefined, 'variants');
  const heading = element('h3', 'Варианты');
  const name = document.createElement('input');
  name.placeholder = 'Имя варианта';
  name.setAttribute('aria-label', 'Имя варианта');
  const list = element('ul', undefined, 'variant-list');
  const status = element('p', undefined, 'variant-status');
  status.setAttribute('role', 'status');
  const create = button('Сохранить', () => save());
  const update = button('Обновить выбранный', () => save(active));
  update.hidden = true;
  const cancel = button('Отменить сохранение', cancelSave);
  cancel.hidden = true;
  let active;
  let request;
  let closed = false;
  node.append(heading, name, create, update, cancel, status, list);
  void refresh(initialId);

  async function refresh(selected) {
    try {
      const entries = await api.variants(generation);
      if (closed) return;
      list.replaceChildren();
      for (const entry of entries) {
        const item = element('li');
        const display = entry.value?.name ?? entry.id;
        if (entry.status === 'ready') {
          item.append(button(display, () => open(entry.value.scenario.nodeId, entry.id)));
          if (selected === entry.id && entry.value.scenario.nodeId === preview.nodeId &&
              JSON.stringify(entry.value.scenario.params) === JSON.stringify(preview.scenario.params)) {
            active = entry.value;
            name.value = active.name;
            update.hidden = false;
          }
        } else {
          const details = entry.errors?.map(error => error.message).join(' · ');
          item.append(element('small', [display, variantStatus[entry.status], details].filter(Boolean).join(' · ')));
        }
        list.append(item);
      }
    } catch (error) {
      if (!closed) status.textContent = error.message;
    }
  }

  function setPending(value) {
    create.disabled = value;
    update.disabled = value;
    cancel.hidden = !value;
  }

  async function save(updateTarget) {
    if (request) return;
    const current = { id: crypto.randomUUID(), sent: false };
    request = current;
    const label = name.value.trim();
    if (!label) {
      request = undefined;
      status.textContent = 'Введите имя варианта';
      name.focus();
      return;
    }
    setPending(true);
    status.textContent = 'Ждём актуальное состояние экрана…';
    try {
      const valid = await flush();
      if (request !== current || closed) return;
      if (!valid) throw new Error('Исправьте значения полей перед сохранением');
      current.sent = true;
      const saved = await api.save(generation, preview.id, label, updateTarget && {
        id: updateTarget.id, revision: updateTarget.revision
      }, current.id);
      if (request !== current || closed) return;
      status.textContent = 'Вариант сохранён';
      await refresh(saved.id);
    } catch (error) {
      if (request === current && !closed) status.textContent = error.message;
    } finally {
      if (request === current) {
        request = undefined;
        setPending(false);
      }
    }
  }

  function cancelSave() {
    if (!request) return;
    if (request.sent) void api.cancelSave(generation, preview.id, request.id).catch(() => {});
    request = undefined;
    setPending(false);
    status.textContent = 'Сохранение отменено';
  }

  return {
    node,
    follow(next) {
      preview = next;
      active = undefined;
      update.hidden = true;
    },
    close() { closed = true; cancelSave(); }
  };
}
