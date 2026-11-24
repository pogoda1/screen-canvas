import { setTimeout } from 'node:timers/promises';
import { routeMatches } from '../../core/discovery/actions.mjs';

const buttons = 'button, [role=button], input[type=submit]';

export async function runAction(capture, edge, target, signal, { observeControl, beforeInput } = {}) {
  if (edge.action === 'redirect' || edge.steps?.every(step => step.type === 'redirect')) return;
  const { contents } = capture;
  let started = false;
  const begin = async () => {
    if (started) return;
    started = true;
    await beforeInput?.();
  };
  if (!edge.steps) {
    const candidates = await contents.executeJavaScript(`Array.from(document.querySelectorAll(${
      JSON.stringify(edge.action === 'link' ? 'a[href]' : buttons)
    }), (element, index) => ({
      index, label: (element.textContent || element.value || '').trim(),
      path: element.pathname, local: element.origin === location.origin,
      visible: element.getClientRects().length > 0
    }))`);
    const matches = candidates.filter(item => item.visible && (
      edge.action === 'link' ? item.local && routeMatches(target.path, item.path) : item.label === edge.label
    ));
    const labelMatch = matches.filter(item => item.label === edge.label);
    const match = labelMatch.length === 1 ? labelMatch[0] : matches.length === 1 ? matches[0] : undefined;
    if (!match) throw new Error('No unique visible control matches this edge');
    const query = 'Array.from(document.querySelectorAll(' +
      JSON.stringify(edge.action === 'link' ? 'a[href]' : buttons) + '))[' + match.index + ']';
    return click(contents, query, begin, observeControl);
  }
  if (!Array.isArray(edge.steps) || edge.steps.length > 12) throw new Error('Invalid action steps');
  const interactive = edge.steps.filter(step => step.type !== 'redirect');
  for (const step of interactive) {
    signal.throwIfAborted();
    if (typeof step.selector !== 'string' || step.selector.length > 512) throw new Error('Invalid local action selector');
    const query = 'document.querySelector(' + JSON.stringify(step.selector) + ')';
    if (step.type === 'click') await click(contents, query, begin, interactive.length === 1 ? observeControl : undefined);
    else if (step.type === 'fill' && typeof step.value === 'string' && step.value.length <= 500) {
      await begin();
      await contents.executeJavaScript(`(() => {
        const input = ${query};
        if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw Error('Text input is missing');
        input.focus();
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(step.value)});
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      })()`);
    } else if (step.type === 'press' && ['Tab', 'Enter', 'Space', 'Escape', 'ArrowDown', 'ArrowUp'].includes(step.key)) {
      await begin();
      await contents.executeJavaScript(query + '?.focus()');
      contents.sendInputEvent({ type: 'keyDown', keyCode: step.key });
      if (step.key === 'Enter') contents.sendInputEvent({ type: 'char', keyCode: '\r' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: step.key });
    } else throw new Error('Unsupported local action');
    await setTimeout(45, undefined, { signal });
  }
}

async function click(contents, query, begin, observeControl) {
  const locate = scroll => contents.executeJavaScript(`(async () => {
    const target = ${query};
    if (!(target instanceof HTMLElement) || target.matches(':disabled,[aria-disabled="true"]') ||
        target.closest('[inert],[hidden],[aria-hidden="true"]')) return null;
    if (${scroll}) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    // Let Chromium publish a frame with the updated hit-test regions before
    // sending input to an offscreen surface.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const box of target.getClientRects()) {
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      if (target.contains(document.elementFromPoint(x, y))) {
        const visible = target.checkVisibility({ opacityProperty: true, visibilityProperty: true });
        return { x, y, box: { x: box.x, y: box.y, width: box.width, height: box.height },
          visible };
      }
    }
    return null;
  })()`);
  let hit = await locate(false) ?? await locate(true);
  if (!hit) throw new Error('The action control is unavailable');
  if (observeControl) {
    const accept = await observeControl();
    hit = await locate(false) ?? await locate(true);
    if (!hit) throw new Error('The action control is unavailable');
    if (hit.visible) accept?.(hit);
  }
  const point = { x: hit.x, y: hit.y };
  // Send pointer events to this capture's Chromium target. The renderer picks
  // the actual hit element and dispatches the event through its ancestor path.
  const debuggerSession = contents.debugger;
  await begin();
  debuggerSession.attach('1.3');
  try {
    const dispatch = (type, fields) => debuggerSession.sendCommand('Input.dispatchMouseEvent', { type, ...point, ...fields });
    await dispatch('mouseMoved');
    await dispatch('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    await dispatch('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    if (!contents.isDestroyed() && debuggerSession.isAttached()) debuggerSession.detach();
  }
}
