import { BrowserWindow } from 'electron';
import { setTimeout } from 'node:timers/promises';
import { identifyNode } from '../../core/graph-evidence.mjs';
import { previewPolicy } from '../session-policy.mjs';

export async function createCapture(worker, nodeId, role, signal) {
  signal.throwIfAborted();
  const preview = await worker.call('open', { nodeId, ...(role ? { mode: role } : {}) });
  if (signal.aborted) {
    await worker.call('close', { id: preview.id }).catch(() => {});
    signal.throwIfAborted();
  }
  const policy = previewPolicy(preview.origin);
  const window = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false,
    webPreferences: { ...policy.preferences, offscreen: true, paintWhenInitiallyHidden: true } });
  const { webContents: contents } = window;
  policy.attach(contents);
  let closed;
  const close = () => closed ??= (async () => {
    signal.removeEventListener('abort', close);
    if (!window.isDestroyed()) window.destroy();
    await Promise.allSettled([worker.call('close', { id: preview.id }), policy.dispose()]);
  })();
  signal.addEventListener('abort', close, { once: true });
  const errors = [];
  contents.on('render-process-gone', (_event, detail) => errors.push('Renderer stopped: ' + detail.reason));
  contents.on('console-message', (event, level, message) => {
    const error = event.level === 'error' || level === 3;
    const text = event.message ?? message;
    if (error && typeof text === 'string') errors.push(text.slice(0, 250));
  });
  const navigation = contents.loadURL(preview.origin + preview.path).catch(error => {
    if (!signal.aborted && error.errno !== -3) errors.push(error.message);
  });
  return {
    contents, navigation, close, errors,
    requests: () => worker.call('requests', { id: preview.id }).catch(() => [])
  };
}

export async function awaitScreen(capture, graph, signal, { expected, timeout = 2600 } = {}) {
  const deadline = Date.now() + timeout;
  let actual;
  let last;
  let firstObserved = 0;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (capture.contents.isDestroyed()) break;
    let status;
    try {
      status = await Promise.race([
        capture.contents.executeJavaScript('globalThis.__screenCanvasStatus?.()'),
        setTimeout(300, undefined, { signal })
      ]);
    }
    catch { }
    if (status?.ready) {
      const url = capture.contents.getURL();
      actual = url && identifyNode(graph, new URL(url).pathname, status.nodeId);
      if (actual && actual === expected) return { id: actual, ready: true };
      if (last !== actual || !firstObserved) {
        firstObserved = Date.now();
        last = actual;
      }
      if (!expected && Date.now() - firstObserved > 100) return { id: actual, ready: true };
      if (actual && Date.now() - firstObserved > 350) return { id: actual, ready: true };
    }
    await setTimeout(40, undefined, { signal });
  }
  return { id: actual, ready: false };
}

export async function snapshot(capture, signal) {
  signal.throwIfAborted();
  const bounds = { x: 0, y: 0, width: 390, height: 844 };
  const image = await capture.contents.capturePage(bounds);
  if (image.isEmpty()) throw new Error('Chromium did not return a screen image');
  return 'data:image/png;base64,' + image.toPNG().toString('base64');
}
