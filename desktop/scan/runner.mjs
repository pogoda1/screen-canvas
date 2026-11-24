import { setTimeout } from 'node:timers/promises';
import { routeMatches } from '../../core/discovery/actions.mjs';
import { captureEvidence, captureExpectation, edgeEvidence, localRequests, observedRedirect, requestFailure } from '../../core/graph-evidence.mjs';
import { awaitScreen, CAPTURE_JOB_MS, captureControlFrame, createCapture, captureScreen, currentFrameMatches, refreshScreen } from './capture.mjs';
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

function sameScreenIdentity(left, right) {
  return left.url === right.url && left.documentVersion === right.documentVersion &&
    left.navigationVersion === right.navigationVersion && left.id === right.id &&
    left.status?.documentId === right.status?.documentId;
}

async function verifySnapshotEffect(capture, graph, signal, after, expectSnapshot, original, deadline) {
  let observed = original;
  let reason = 'The expected observed UI answer or role did not match';
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    observed = await refreshScreen(capture, graph, signal, false);
    if (!sameScreenIdentity(original, observed) || observed.status?.failure) break;
    const budget = deadline - Date.now();
    if (observed.ready && budget > 0) {
      reason = await capture.verify(after, { expectSnapshot }, budget);
      if (!reason) {
        observed = await refreshScreen(capture, graph, signal, false);
        if (observed.ready && sameScreenIdentity(original, observed) && Date.now() <= deadline) {
          signal.throwIfAborted();
          return { observed, reason };
        }
        reason = 'The UI effect could not be verified on the same ready screen within the observation budget';
        if (!sameScreenIdentity(original, observed)) break;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await setTimeout(Math.min(40, remaining), undefined, { signal });
  }
  return { observed, reason };
}

export async function crawlGraph(worker, graph, signal, update) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const frames = new Map();
  const total = graph.nodes.length + graph.edges.length;
  let completed = 0;
  async function phase(items, visit) {
    let cursor = 0;
    async function run() {
      while (!signal.aborted && cursor < items.length) {
        await visit(items[cursor++]);
        if (!signal.aborted) update(++completed, total);
      }
    }
    await Promise.all([run(), run()]);
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
          if (node.capture.outcome === 'captured' || node.capture.outcome === 'special-state') {
            node.screenshot = screenshot;
            frames.set(node.id, { key: capture.frameKey, path: observed.pathname });
          } else node.diagnostics.push(node.capture.reason);
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
    let startedNavigation;
    let differentSnapshot;
    let snapshotVerified;
    const self = edge.source === edge.target;
    let after;
    let origin;
    let originReason;
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
        const sourceFrame = frames.get(edge.source);
        const screenshot = nodes.get(edge.source)?.screenshot;
        const sameScenario = sourceFrame?.key === capture.frameKey && sourceFrame.path === source.pathname;
        originReason = sourceFrame && !sameScenario ? 'different-scenario' : 'control-not-in-frame';
        const observeControl = sameScenario && screenshot && (async measure => {
          const ready = await awaitScreen(capture, graph, jobSignal, {
            expected: edge.source, timeout: 1600, forCapture: true
          });
          if (!ready.ready || ready.id !== edge.source || ready.pathname !== source.pathname ||
              ready.documentVersion !== source.documentVersion) return;
          const captured = await captureControlFrame(capture, jobSignal, measure).catch(() => undefined);
          if (captured && await currentFrameMatches(capture, graph, jobSignal, ready)) {
            return hit => { origin = matchControl(captured.frame, screenshot, captured.hit, hit); };
          }
        });
        await runAction(capture, edge, target, jobSignal, {
          observeControl,
          beforeInput: async () => {
            if (self && edge.expectSnapshot) {
              differentSnapshot = Boolean(await capture.verify(0, { expectSnapshot: edge.expectSnapshot }));
            }
            after = await capture.cursor();
            startedNavigation = capture.navigationVersion;
          }
        });
      }
      const deadline = Date.now() + timeout;
      const afterNavigation = self && !edge.expectRequests?.length && !differentSnapshot ? startedNavigation : undefined;
      const expect = { expected: edge.target, from: edge.source, timeout, afterNavigation };
      observed = await awaitScreen(capture, graph, jobSignal, { ...expect, waitForNavigation: redirects });
      // Requests can outlast the first ready sample, including on the same URL.
      // If the document or step changes while settling, observe its requests too.
      let changed;
      do {
        const settled = await settleRequests(capture, jobSignal);
        records = settled.records;
        if (jobSignal.aborted) break;
        const current = await refreshScreen(capture, graph, jobSignal, settled.waited);
        changed = !sameScreenIdentity(current, observed);
        observed = changed && !current.ready && !current.status?.failure ?
          await awaitScreen(capture, graph, jobSignal, expect) : current;
      } while (changed && !jobSignal.aborted);
      if (jobSignal.aborted) observed = { ...observed, ready: false };
      if (edge.expectRequests && !jobSignal.aborted) {
        const failure = await capture.verify(after ?? 0, { expectRequests: edge.expectRequests });
        requestCheck = failure ? 'unverified' : 'verified';
        reason = failure;
      }
      if (edge.expectedPath && observed.pathname && !routeMatches(edge.expectedPath, observed.pathname)) {
        reason = 'Expected ' + edge.expectedPath + ', observed ' + observed.pathname;
      } else if (observed.ready && observed.id === edge.target && edge.expectSnapshot && !reason && !jobSignal.aborted) {
        if (self && differentSnapshot) {
          ({ observed, reason } = await verifySnapshotEffect(capture, graph, jobSignal, after ?? 0,
            edge.expectSnapshot, observed, deadline));
        } else {
          reason = await capture.verify(after ?? 0, { expectSnapshot: edge.expectSnapshot });
        }
        snapshotVerified = !reason;
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
        const navigated = startedNavigation !== undefined && observed?.navigationVersion > startedNavigation;
        const effect = Boolean(self && (requestCheck === 'verified' && edge.expectRequests?.length ||
          differentSnapshot && snapshotVerified));
        const moved = Boolean(actualPath && (actualPath !== initialPath || observed?.id && observed.id !== edge.source ||
          self && navigated));
        if (self && !moved && !effect) reason = 'No repeated navigation or declared effect was observed';
        const afterAction = after === undefined ? [] : entries.filter(record => record.sequence > after);
        const relevant = record => !edge.expectRequests?.length ||
          edge.expectRequests.some(expected => record.method === expected.method && record.path === expected.path);
        const actionFailure = requestFailure(afterAction.filter(relevant));
        const targetReads = moved && !observed?.ready && !redirects ? afterAction.filter(record =>
          (record.method === 'GET' || record.method === 'HEAD') && !relevant(record) && record.status >= 500) : [];
        const targetFailure = requestFailure(targetReads);
        const backgroundFailure = requestFailure(afterAction.filter(record =>
          !relevant(record) && !targetReads.includes(record)));
        const actionPending = afterAction.some(record => relevant(record) && record.status === 0);
        const backgroundPending = afterAction.some(record => !relevant(record) && record.status === 0);
        if (actionFailure && !moved && !reason) reason = 'The request failed and the screen did not change';
        if (actionPending) reason ??= 'A local action request did not finish within the observation budget';
        const evidence = edgeEvidence(edge, observed?.id, requests, reason, actualPath);
        if (moved) {
          evidence.transitionObserved = true;
          const failure = redirects && requestFailure(entries);
          const pending = redirects && entries.some(request => request.status === 0);
          evidence.targetReady = Boolean(observed?.ready && !failure && !pending);
          if (failure) evidence.targetReason = failure.message;
          else if (targetFailure) evidence.targetReason = targetFailure.message;
          else if (pending) evidence.targetReason = 'A local request did not finish within the capture budget';
          else if (observed?.diagnostic) evidence.targetReason = observed.diagnostic.message;
        }
        if (requestCheck) evidence.requestCheck = requestCheck;
        if (effect && !moved) evidence.actionEffect = true;
        if (actionFailure) evidence.actionFailure = actionFailure;
        if (backgroundFailure) evidence.backgroundFailure = backgroundFailure;
        if (actionPending) evidence.actionPending = true;
        if (backgroundPending) evidence.backgroundPending = true;
        if (moved || evidence.status === 'confirmed') {
          if (origin) evidence.origin = origin;
          else evidence.originReason = originReason ?? 'automatic';
        }
        edge.evidence = evidence;
      }
      await capture?.close();
    }
  }

  update(0, total);
  await phase(graph.nodes, captureNode);
  await phase(graph.edges, observeEdge);
}
