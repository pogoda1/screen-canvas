import { setTimeout } from 'node:timers/promises';
import { routeMatches } from '../../core/discovery/actions.mjs';

const buttons = 'button, [role=button], input[type=submit]';

export async function runAction(capture, edge, target, signal) {
  if (edge.action === 'redirect' || edge.steps?.every(step => step.type === 'redirect')) return;
  const { contents } = capture;
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
    return click(contents, query);
  }
  if (!Array.isArray(edge.steps) || edge.steps.length > 12) throw new Error('Invalid action steps');
  for (const step of edge.steps) {
    signal.throwIfAborted();
    if (step.type === 'redirect') continue;
    if (typeof step.selector !== 'string' || step.selector.length > 512) throw new Error('Invalid local action selector');
    const query = 'document.querySelector(' + JSON.stringify(step.selector) + ')';
    if (step.type === 'click') await click(contents, query);
    else if (step.type === 'fill' && typeof step.value === 'string' && step.value.length <= 500) {
      await contents.executeJavaScript(`(() => {
        const input = ${query};
        if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw Error('Text input is missing');
        input.focus();
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(step.value)});
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      })()`);
    } else if (step.type === 'press' && ['Tab', 'Enter', 'Space', 'Escape', 'ArrowDown', 'ArrowUp'].includes(step.key)) {
      await contents.executeJavaScript(query + '?.focus()');
      contents.sendInputEvent({ type: 'keyDown', keyCode: step.key });
      if (step.key === 'Enter') contents.sendInputEvent({ type: 'char', keyCode: '\r' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: step.key });
    } else throw new Error('Unsupported local action');
    await setTimeout(45, undefined, { signal });
  }
}

async function click(contents, query) {
  const point = await contents.executeJavaScript(`(() => {
    const target = ${query};
    if (!target || target.disabled || !target.getClientRects().length) return null;
    target.scrollIntoView({ block: 'center' });
    const box = target.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  if (!point) throw new Error('The action control is unavailable');
  contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
