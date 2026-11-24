import { BrowserWindow } from 'electron';
import { setTimeout } from 'node:timers/promises';
import { addAbortListener } from 'node:events';
import { identifyNode } from '../../core/graph-evidence.mjs';
import { previewPolicy } from '../session-policy.mjs';

export async function createCapture(worker, nodeId, role, signal) {
  signal.throwIfAborted();
  const opening = worker.call('open', { nodeId, ...(role ? { mode: role } : {}) }, 5000);
  let preview;
  try { preview = await withBudget(opening, signal, 5000); }
  catch (error) {
    void opening.then(late => worker.call('close', { id: late.id }, 1000)).catch(() => {});
    throw error;
  }
  const policy = previewPolicy(preview.origin, preview.navigationKey);
  const window = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false,
    webPreferences: { ...policy.preferences, offscreen: true, paintWhenInitiallyHidden: true } });
  const { webContents: contents } = window;
  policy.attach(contents);
  let closed;
  const close = () => closed ??= (async () => {
    signal.removeEventListener('abort', close);
    if (!window.isDestroyed()) window.destroy();
    await Promise.allSettled([worker.call('close', { id: preview.id }, 1000), policy.dispose()]);
  })();
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  const errors = [];
  const capture = { contents, close, errors, documentVersion: 0 };
  contents.on('did-start-navigation', (event, _url, inPlace, mainFrame) => {
    if ((event.isMainFrame ?? mainFrame) && !(event.isSameDocument ?? inPlace)) capture.documentVersion++;
  });
  contents.on('render-process-gone', (_event, detail) => {
    capture.crash = 'Renderer stopped: ' + detail.reason;
  });
  contents.on('console-message', (event, level, message) => {
    const error = event.level === 'error' || level === 3;
    const text = event.message ?? message;
    if (error && typeof text === 'string') errors.push(text.slice(0, 250));
  });
  const navigation = contents.loadURL(preview.origin + preview.path).catch(error => {
    if (!signal.aborted && error.errno !== -3) errors.push(error.message);
  });
  return Object.assign(capture, {
    navigation,
    cursor: () => worker.call('cursor', { id: preview.id }),
    verify: (after, edge) => worker.call('verify', {
      id: preview.id, after, ...(edge.expectRequests ? { requests: edge.expectRequests } : {}),
      ...(edge.expectSnapshot ? { snapshot: edge.expectSnapshot } : {})
    }),
    requests: () => worker.call('requests', { id: preview.id }, 1000).catch(() => [])
  });
}

// Reserve separate time for the document, UI, and compositor. The runner
// also applies a hard limit, including time spent waiting for the host.
export const CAPTURE_JOB_MS = 10_000;
const NAVIGATION_MS = 5000;
const UI_MS = 4000;
const FRAME_MS = 850;

async function withBudget(operation, signal, ms) {
  const limit = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, ms))]);
  limit.throwIfAborted();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = addAbortListener(limit, () => reject(limit.reason));
  });
  try { return await Promise.race([operation, aborted]); }
  finally { listener[Symbol.dispose](); }
}

function currentLocation(capture) {
  const { contents, documentVersion } = capture;
  if (contents.isDestroyed()) return {};
  const url = contents.getURL();
  return { url, pathname: url ? new URL(url).pathname : undefined, documentVersion };
}

async function readScreen(capture, graph, signal, forCapture, remaining) {
  const location = currentLocation(capture);
  if (!location.pathname) return location;
  const candidateId = identifyNode(graph, location.pathname);
  const candidate = graph.nodes.find(node => node.id === candidateId);
  const status = await withBudget(capture.contents.executeJavaScript(
    `globalThis.__screenCanvasStatus?.(${Boolean(candidate?.index)}, ${forCapture})`
  ), signal, Math.min(350, remaining)).catch(() => undefined);
  const after = currentLocation(capture);
  if (after.url !== location.url || after.documentVersion !== location.documentVersion) return after;
  return { ...location, status, id: identifyNode(graph, location.pathname, status?.nodeId),
    unmounted: candidate?.index && status?.nodeId !== candidate.id && !status?.mounted };
}

function blocked(observation, forCapture) {
  const { status, unmounted } = observation;
  if (status?.failure) return { code: 'render-error', message: status.failure };
  if (status?.loading) return { code: 'loading-timeout', message: 'The route still displays a loading screen' };
  if (unmounted) return { code: 'index-unmounted', message: 'The index content was not observed in the shared layout' };
  if (forCapture && status?.ready && !status.captureReady) return {
    code: status.captureError ? 'capture-readiness-error' : 'capture-not-ready',
    message: status.captureError ? 'The captureReady hook failed' : 'The adapter has not confirmed that the screen can be captured'
  };
}

function healthy(capture) {
  return !capture.crash && !capture.contents.isDestroyed();
}

export async function awaitScreen(capture, graph, signal, { expected, from, timeout = 2600,
  forCapture = false, waitForNavigation = false } = {}) {
  if (waitForNavigation) {
    try { await withBudget(capture.navigation, signal, NAVIGATION_MS); }
    catch {
      return { ...currentLocation(capture), ready: false, diagnostic: {
        code: 'navigation-timeout', message: 'The preview document did not finish loading'
      } };
    }
  }
  const deadline = Date.now() + timeout;
  let last = { ready: false };
  let stableSince = Date.now();
  while (Date.now() < deadline && healthy(capture)) {
    signal.throwIfAborted();
    // Hidden offscreen views may stop producing frames between invalidations.
    // Keep UI animations moving while the capture-specific barrier is pending.
    if (forCapture) capture.contents.invalidate();
    const observation = await readScreen(capture, graph, signal, forCapture, deadline - Date.now());
    const { id, status, url, documentVersion } = observation;
    const diagnostic = blocked(observation, forCapture);
    if (id !== last.id || url !== last.url || documentVersion !== last.documentVersion ||
        status?.documentId !== last.status?.documentId || !last.ready) stableSince = Date.now();
    const ready = Boolean(status?.ready && !diagnostic);
    last = { ...observation, ready, diagnostic };
    if (status?.failure) return last;
    if (ready && (id && id === expected || !expected && Date.now() - stableSince > 100 ||
        id && id !== from && Date.now() - stableSince > 350)) return last;
    await setTimeout(40, undefined, { signal });
  }
  if (!healthy(capture)) return { ...last, ready: false, diagnostic: {
    code: 'renderer-stopped', message: capture.crash ?? 'The preview window closed'
  } };
  return { ...last, ready: false };
}

function sameScreen(expected, observation) {
  return expected.url === observation.url && expected.id === observation.id &&
    expected.documentVersion === observation.documentVersion &&
    expected.status?.documentId === observation.status?.documentId &&
    expected.status?.applied === observation.status?.applied &&
    observation.status?.ready && observation.status?.captureReady && !blocked(observation, true);
}

async function waitForPaint(contents, signal, budget) {
  let painted;
  const frame = new Promise(resolve => {
    painted = (_event, _dirty, image) => { if (!image.isEmpty()) resolve(); };
    contents.on('paint', painted);
  });
  try {
    contents.invalidate();
    await withBudget(frame, signal, budget);
  } finally {
    contents.removeListener('paint', painted);
  }
}

export async function captureScreen(capture, graph, signal, expected) {
  const deadline = Date.now() + NAVIGATION_MS + UI_MS + FRAME_MS;
  let observed = await awaitScreen(capture, graph, signal, {
    expected, timeout: UI_MS, forCapture: true, waitForNavigation: true
  });
  while (observed.ready && observed.id === expected && healthy(capture) && Date.now() < deadline) {
    try {
      await waitForPaint(capture.contents, signal, Math.min(FRAME_MS, deadline - Date.now()));
      const before = await readScreen(capture, graph, signal, true, deadline - Date.now());
      if (sameScreen(observed, before)) {
        const image = await withBudget(
          capture.contents.capturePage({ x: 0, y: 0, width: 390, height: 844 }),
          signal, Math.min(FRAME_MS, deadline - Date.now())
        );
        const after = await readScreen(capture, graph, signal, true, deadline - Date.now());
        if (sameScreen(before, after) && healthy(capture) && !image.isEmpty() && Date.now() <= deadline) {
          return { observed: { ...after, ready: true }, screenshot: 'data:image/png;base64,' + image.toPNG().toString('base64') };
        }
      }
    } catch {
      signal.throwIfAborted();
    }
    if (Date.now() >= deadline) break;
    const remaining = Math.min(UI_MS, deadline - Date.now());
    observed = await awaitScreen(capture, graph, signal, { expected, timeout: remaining, forCapture: true });
  }
  if (observed.ready && observed.id === expected) {
    observed = { ...observed, ready: false, diagnostic: {
      code: 'frame-not-observed', message: 'No stable rendered frame was observed'
    } };
  }
  return { observed };
}
