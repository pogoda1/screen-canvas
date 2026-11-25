import { setTimeout } from 'node:timers/promises';
import { routeMatches } from '../../core/discovery/actions.mjs';
import { interactiveSteps } from '../../core/graph-evidence.mjs';

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
  const interactive = interactiveSteps(edge);
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
  const find = async () => {
    const hit = await locate(false) ?? await locate(true);
    if (!hit) throw new Error('The action control is unavailable');
    return hit;
  };
  if (observeControl) await find();
  const accept = observeControl ? await observeControl(() => locate(false)) : undefined;
  await begin();
  let hit = await find();
  // Send pointer events to this capture's Chromium target. The renderer picks
  // the actual hit element and dispatches the event through its ancestor path.
  const debuggerSession = contents.debugger;
  debuggerSession.attach('1.3');
  try {
    const dispatch = (type, fields) => debuggerSession.sendCommand('Input.dispatchMouseEvent', {
      type, x: hit.x, y: hit.y, ...fields
    });
    await dispatch('mouseMoved');
    if (accept) {
      const current = await locate(false);
      if (!current) throw new Error('The action control is unavailable');
      hit = current;
    }
    await dispatch('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    await dispatch('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
    accept?.(hit);
  } finally {
    if (!contents.isDestroyed() && debuggerSession.isAttached()) debuggerSession.detach();
  }
}
