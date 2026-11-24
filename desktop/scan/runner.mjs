import { setTimeout } from 'node:timers/promises';
import { routeMatches } from '../../core/discovery/actions.mjs';
import { captureEvidence, captureExpectation, edgeEvidence, localRequests, observedRedirect, requestFailure } from '../../core/graph-evidence.mjs';
import { awaitScreen, CAPTURE_JOB_MS, captureControlFrame, createCapture, captureScreen } from './capture.mjs';
import { matchControl } from './anchor.mjs';
import { runAction } from './actions.mjs';

async function settleRequests(capture, signal) {
  if (!capture) return [];
  const deadline = Date.now() + 1500;
  let records = await capture.requests();
  while (!signal.aborted && !requestFailure(records) && records.some(request => request.status === 0) &&
      Date.now() < deadline) {
    try { await setTimeout(50, undefined, { signal }); }
    catch { break; }
    const latest = await capture.requests();
    // An expired capture may already have closed the worker session.
    if (!latest.length) break;
    records = latest;
  }
  return records;
}

export async function crawlGraph(worker, graph, signal, update) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const jobs = [
    ...graph.nodes.map(node => ({ node })),
    ...graph.edges.map(edge => ({ edge }))
  ];
  let cursor = 0;
  let completed = 0;
  async function run() {
    while (!signal.aborted && cursor < jobs.length) {
      const job = jobs[cursor++];
      if (job.node) await captureNode(job.node);
      else await observeEdge(job.edge);
      if (!signal.aborted) update(++completed, jobs.length);
    }
  }

  async function captureNode(node) {
    let capture;
    let observed;
    let screenshot;
    let expected = { target: node.id, path: node.path, sourcePath: node.path };
    const jobSignal = AbortSignal.any([signal, AbortSignal.timeout(CAPTURE_JOB_MS)]);
    try {
      capture = await createCapture(worker, node.id, node.role, jobSignal);
      expected = { ...captureExpectation(graph, node, capture.mode, capture.initialPath),
        sourcePath: capture.initialPath };
      const transition = expected.target !== node.id || expected.path !== capture.initialPath;
      if (transition) {
        observed = await awaitScreen(capture, graph, jobSignal, {
          expected: expected.target, timeout: 4000, forCapture: true, waitForNavigation: true
        });
      } else {
        ({ observed, screenshot } = await captureScreen(capture, graph, jobSignal, node.id));
        const redirect = observedRedirect(graph, node, observed);
        if (redirect) expected = { ...redirect, sourcePath: capture.initialPath };
      }
    } catch {
      const url = capture && !capture.contents.isDestroyed() ? capture.contents.getURL() : undefined;
      observed = { pathname: url ? new URL(url).pathname : undefined, ready: false, diagnostic: {
        code: capture ? 'frame-not-observed' : 'navigation-timeout',
        message: capture ? 'The capture job ended before a frame was verified' : 'The preview document could not be opened'
      } };
    } finally {
      if (!signal.aborted) {
        const records = await settleRequests(capture, jobSignal);
        if (!signal.aborted) {
          node.requests = localRequests(records);
          if (jobSignal.aborted) screenshot = undefined;
          node.capture = captureEvidence(node, expected, observed, screenshot, records, capture?.errors ?? []);
          if (node.capture.outcome === 'captured' || node.capture.outcome === 'special-state') node.screenshot = screenshot;
          else node.diagnostics.push(node.capture.reason);
        }
      }
      await capture?.close();
    }
  }

  async function observeEdge(edge) {
    let capture;
    let observed;
    let actualPath;
    let initialPath;
    let after;
    let origin;
    let reason;
    let redirects;
    let jobSignal;
    try {
      const target = nodes.get(edge.target);
      if (!target) throw new Error('External destination');
      const timeout = edge.action === 'adapter' ? 6500 : 2600;
      jobSignal = AbortSignal.any([signal, AbortSignal.timeout(2 * timeout + 6500)]);
      capture = await createCapture(worker, edge.source, edge.role, jobSignal);
      redirects = edge.action === 'redirect' || edge.steps?.every(step => step.type === 'redirect');
      initialPath = capture.initialPath;
      if (!redirects) {
        const source = await awaitScreen(capture, graph, jobSignal, { expected: edge.source, timeout, waitForNavigation: true });
        if (source.id !== edge.source || !source.ready) throw new Error(source.diagnostic?.message ?? 'The source screen was not observed');
        initialPath = source.pathname;
        const screenshot = nodes.get(edge.source)?.screenshot;
        const observeControl = screenshot && (async hit => {
          const ready = await awaitScreen(capture, graph, jobSignal, {
            expected: edge.source, timeout: 1300, forCapture: true
          });
          if (!ready.ready || ready.id !== edge.source || ready.pathname !== initialPath ||
              ready.documentVersion !== source.documentVersion) return;
          const frame = await captureControlFrame(capture, jobSignal).catch(() => undefined);
          const point = matchControl(frame, screenshot, hit);
          if (point) return () => { origin = point; };
        });
        await runAction(capture, edge, target, jobSignal, {
          observeControl,
          beforeInput: async () => { after = await capture.cursor(); }
        });
      }
      observed = await awaitScreen(capture, graph, jobSignal, { expected: edge.target, from: edge.source, timeout, waitForNavigation: redirects });
      const url = capture.contents.isDestroyed() ? undefined : capture.contents.getURL();
      if (url) actualPath = new URL(url).pathname;
      if (edge.expectedPath && actualPath && !routeMatches(edge.expectedPath, actualPath)) {
        reason = 'Expected ' + edge.expectedPath + ', observed ' + actualPath;
      } else if (observed.ready && observed.id === edge.target && (edge.expectRequests || edge.expectSnapshot)) {
        reason = await capture.verify(after ?? 0, edge);
      }
      if (edge.action === 'redirect' && !edge.direct && observed.id === edge.target && !reason) {
        reason = 'The destination was observed, but the automatic branch was not proved';
      }
      if (!observed.ready) reason = observed.diagnostic?.message ?? 'Target did not become ready';
    } catch (error) { reason = error.message; }
    finally {
      if (!signal.aborted) {
        const records = redirects ? await settleRequests(capture, jobSignal) : await capture?.requests() ?? [];
        const requests = localRequests(records);
        // The action is proved by its declared exchanges and observed target.
        // Other responses remain evidence and still block a source thumbnail.
        const moved = Boolean(actualPath && (actualPath !== initialPath || observed?.id && observed.id !== edge.source));
        const actionFailure = after === undefined ? undefined :
          requestFailure(records.filter(record => record.sequence > after));
        if (actionFailure && !moved) reason = 'The request failed and the screen did not change';
        const evidence = edgeEvidence(edge, observed?.id, requests, reason, actualPath);
        if (moved) {
          evidence.transitionObserved = true;
          const failure = redirects && requestFailure(records);
          const pending = redirects && records.some(request => request.status === 0);
          evidence.targetReady = Boolean(observed?.ready && !failure && !pending);
          if (failure) evidence.targetReason = failure.message;
          else if (pending) evidence.targetReason = 'A local request did not finish within the capture budget';
          else if (observed?.diagnostic) evidence.targetReason = observed.diagnostic.message;
        }
        if (actionFailure) evidence.actionFailure = actionFailure;
        if (origin && (moved || evidence.status === 'confirmed')) evidence.origin = origin;
        edge.evidence = evidence;
      }
      await capture?.close();
    }
  }

  update(0, jobs.length);
  await Promise.all([run(), run()]);
}
