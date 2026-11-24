import { routeMatches } from '../../core/discovery/actions.mjs';
import { captureEvidence, captureExpectation, edgeEvidence, localRequests } from '../../core/graph-evidence.mjs';
import { awaitScreen, CAPTURE_JOB_MS, createCapture, captureScreen } from './capture.mjs';
import { runAction } from './actions.mjs';

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
      }
    } catch {
      const url = capture && !capture.contents.isDestroyed() ? capture.contents.getURL() : undefined;
      observed = { pathname: url ? new URL(url).pathname : undefined, ready: false, diagnostic: {
        code: capture ? 'frame-not-observed' : 'navigation-timeout',
        message: capture ? 'The capture job ended before a frame was verified' : 'The preview document could not be opened'
      } };
    } finally {
      if (!signal.aborted) {
        node.requests = localRequests(await capture?.requests() ?? []);
        node.capture = captureEvidence(node, expected, observed, screenshot, node.requests, capture?.errors ?? []);
        if (node.capture.outcome === 'captured' || node.capture.outcome === 'special-state') node.screenshot = screenshot;
        else node.diagnostics.push(node.capture.reason);
      }
      await capture?.close();
    }
  }

  async function observeEdge(edge) {
    let capture;
    let actual;
    let actualPath;
    let after = 0;
    let reason;
    try {
      const target = nodes.get(edge.target);
      if (!target) throw new Error('External destination');
      const timeout = edge.action === 'adapter' ? 6500 : 2600;
      const jobSignal = AbortSignal.any([signal, AbortSignal.timeout(2 * timeout + 6500)]);
      capture = await createCapture(worker, edge.source, edge.role, jobSignal);
      const redirects = edge.action === 'redirect' || edge.steps?.every(step => step.type === 'redirect');
      if (!redirects) {
        const source = await awaitScreen(capture, graph, jobSignal, { expected: edge.source, timeout, waitForNavigation: true });
        if (source.id !== edge.source || !source.ready) throw new Error(source.diagnostic?.message ?? 'The source screen was not observed');
        after = await capture.cursor();
        await runAction(capture, edge, target, jobSignal);
      }
      const observed = await awaitScreen(capture, graph, jobSignal, { expected: edge.target, from: edge.source, timeout, waitForNavigation: redirects });
      actual = observed.id;
      const url = capture.contents.isDestroyed() ? undefined : capture.contents.getURL();
      if (url) actualPath = new URL(url).pathname;
      if (edge.expectedPath && actualPath && !routeMatches(edge.expectedPath, actualPath)) {
        reason = 'Expected ' + edge.expectedPath + ', observed ' + actualPath;
      } else if (observed.ready && actual === edge.target && (edge.expectRequests || edge.expectSnapshot)) {
        reason = await capture.verify(after, edge);
      }
      if (!observed.ready) reason = observed.diagnostic?.message ?? 'Target did not become ready';
    } catch (error) { reason = error.message; }
    finally {
      if (!signal.aborted) {
        const requests = localRequests(await capture?.requests() ?? []);
        // The action is proved by its declared exchanges and observed target.
        // Other responses remain evidence and still block a source thumbnail.
        edge.evidence = edgeEvidence(edge, actual, requests, reason, actualPath);
      }
      await capture?.close();
    }
  }

  update(0, jobs.length);
  await Promise.all([run(), run()]);
}
