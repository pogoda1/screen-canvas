import { setTimeout } from 'node:timers/promises';
import { routeMatches } from '../../core/discovery/actions.mjs';
import { captureEvidence, captureExpectation, edgeEvidence, localRequests, observedRedirect, requestFailure } from '../../core/graph-evidence.mjs';
import { awaitScreen, CAPTURE_JOB_MS, captureControlFrame, createCapture, captureScreen, currentFrameMatches } from './capture.mjs';
import { matchControl } from './anchor.mjs';
import { runAction } from './actions.mjs';

async function settleRequests(capture, signal) {
  if (!capture) return { records: [], waited: false };
  const deadline = Date.now() + 1500;
  let records = await capture.requests();
  let waited = false;
  while (!signal.aborted && records.some(request => request.status === 0) &&
      Date.now() < deadline) {
    waited = true;
    try { await setTimeout(50, undefined, { signal }); }
    catch { break; }
    const latest = await capture.requests();
    // An expired capture may already have closed the worker session.
    if (!latest.length) break;
    records = latest;
  }
  return { records, waited };
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
    let settled;
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
      }
      settled = await settleRequests(capture, jobSignal);
      while (screenshot && !jobSignal.aborted && !requestFailure(settled.records) &&
          !settled.records.some(request => request.status === 0)) {
        if (!settled.waited && await currentFrameMatches(capture, graph, jobSignal, observed)) break;
        screenshot = undefined;
        ({ observed, screenshot } = await captureScreen(capture, graph, jobSignal, node.id));
        settled = await settleRequests(capture, jobSignal);
      }
      const redirect = expected.inferRedirect && observedRedirect(graph, node, observed);
      if (redirect) expected = { ...redirect, sourcePath: capture.initialPath };
    } catch {
      screenshot = undefined;
      const url = capture && !capture.contents.isDestroyed() ? capture.contents.getURL() : undefined;
      observed = { pathname: url ? new URL(url).pathname : undefined, ready: false, diagnostic: {
        code: capture ? 'frame-not-observed' : 'navigation-timeout',
        message: capture ? 'The capture job ended before a frame was verified' : 'The preview document could not be opened'
      } };
    } finally {
      if (!signal.aborted) {
        const { records } = settled ?? await settleRequests(capture, jobSignal);
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
    let records;
    let requestCheck;
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
      ({ records } = await settleRequests(capture, jobSignal));
      if (!jobSignal.aborted && observed.url !== capture.contents.getURL()) {
        observed = await awaitScreen(capture, graph, jobSignal, { expected: edge.target, from: edge.source, timeout });
      }
      if (edge.expectRequests && !jobSignal.aborted) {
        const failure = await capture.verify(after ?? 0, { expectRequests: edge.expectRequests });
        requestCheck = failure ? 'unverified' : 'verified';
        reason = failure;
      }
      if (edge.expectedPath && observed.pathname && !routeMatches(edge.expectedPath, observed.pathname)) {
        reason = 'Expected ' + edge.expectedPath + ', observed ' + observed.pathname;
      } else if (observed.ready && observed.id === edge.target && edge.expectSnapshot && !reason && !jobSignal.aborted) {
        reason = await capture.verify(after ?? 0, { expectSnapshot: edge.expectSnapshot });
      }
      if (edge.action === 'redirect' && !edge.direct && observed.id === edge.target && !reason) {
        reason = 'The destination was observed, but the automatic branch was not proved';
      }
      if (!observed.ready) reason = observed.diagnostic?.message ?? 'Target did not become ready';
    } catch (error) { reason = error.message; }
    finally {
      if (!signal.aborted) {
        const entries = records ?? await capture?.requests() ?? [];
        const requests = localRequests(entries);
        const actualPath = observed?.pathname;
        // The action is proved by its declared exchanges and observed target.
        // Other responses remain evidence and still block a source thumbnail.
        const moved = Boolean(actualPath && (actualPath !== initialPath || observed?.id && observed.id !== edge.source));
        const afterAction = after === undefined ? [] : entries.filter(record => record.sequence > after);
        const relevant = record => !edge.expectRequests?.length ||
          edge.expectRequests.some(expected => record.method === expected.method && record.path === expected.path);
        const actionFailure = requestFailure(afterAction.filter(relevant));
        const backgroundFailure = requestFailure(afterAction.filter(record => !relevant(record)));
        const actionPending = afterAction.some(record => record.status === 0);
        if (actionFailure && !moved && !reason) reason = 'The request failed and the screen did not change';
        if (actionPending) reason ??= 'A local action request did not finish within the observation budget';
        const evidence = edgeEvidence(edge, observed?.id, requests, reason, actualPath);
        if (moved) {
          evidence.transitionObserved = true;
          const failure = redirects && requestFailure(entries);
          const pending = redirects && entries.some(request => request.status === 0);
          evidence.targetReady = Boolean(observed?.ready && !failure && !pending);
          if (failure) evidence.targetReason = failure.message;
          else if (pending) evidence.targetReason = 'A local request did not finish within the capture budget';
          else if (observed?.diagnostic) evidence.targetReason = observed.diagnostic.message;
        }
        if (requestCheck) evidence.requestCheck = requestCheck;
        if (actionFailure) evidence.actionFailure = actionFailure;
        if (backgroundFailure) evidence.backgroundFailure = backgroundFailure;
        if (actionPending) evidence.actionPending = true;
        if (origin && (moved || evidence.status === 'confirmed')) evidence.origin = origin;
        edge.evidence = evidence;
      }
      await capture?.close();
    }
  }

  update(0, jobs.length);
  await Promise.all([run(), run()]);
}
