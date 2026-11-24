import { routeMatches } from '../../core/discovery/actions.mjs';
import { edgeEvidence } from '../../core/graph-evidence.mjs';
import { awaitScreen, createCapture, snapshot } from './capture.mjs';
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
    try {
      capture = await createCapture(worker, node.id, node.role, signal);
      const observed = await awaitScreen(capture, graph, signal, { expected: node.id });
      node.requests = await capture.requests();
      const failure = node.requests.find(request => request.status >= 500);
      if (failure) {
        node.diagnostics.push({ code: 'mock-response', message: failure.method + ' ' + failure.path + ' → ' + failure.status });
      }
      if (observed.diagnostic) node.diagnostics.push(observed.diagnostic);
      else if (observed.id !== node.id || !observed.ready) {
        const reason = failure ? 'A required mock failed' : observed.id ? 'Rendered ' + observed.id :
          capture.errors.length ? capture.errors.at(-1) : 'No matching content became ready';
        node.diagnostics.push({ code: observed.id ? 'different-screen' : 'not-ready', message: reason });
      } else if (!failure) node.screenshot = await snapshot(capture, signal);
    } catch (error) {
      if (!signal.aborted) node.diagnostics.push({ code: 'capture', message: error.message });
    } finally { await capture?.close(); }
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
      capture = await createCapture(worker, edge.source, edge.role, signal);
      const timeout = edge.action === 'adapter' ? 6500 : 2600;
      const redirects = edge.action === 'redirect' || edge.steps?.every(step => step.type === 'redirect');
      if (!redirects) {
        const source = await awaitScreen(capture, graph, signal, { expected: edge.source, timeout });
        if (source.id !== edge.source || !source.ready) throw new Error(source.diagnostic?.message ?? 'The source screen was not observed');
        after = await capture.cursor();
        await runAction(capture, edge, target, signal);
      }
      const observed = await awaitScreen(capture, graph, signal, { expected: edge.target, timeout });
      actual = observed.id;
      const url = capture.contents.getURL();
      if (url) actualPath = new URL(url).pathname;
      if (edge.expectedPath && actualPath && !routeMatches(edge.expectedPath, actualPath)) {
        reason = 'Expected ' + edge.expectedPath + ', observed ' + actualPath;
      } else if (observed.ready && actual === edge.target && (edge.expectRequests || edge.expectSnapshot)) {
        reason = await capture.verify(after, edge);
      }
      if (!observed.ready) reason = observed.diagnostic?.message ?? 'Target did not become ready';
    } catch (error) { reason = error.message; }
    finally {
      if (!signal.aborted) edge.evidence = edgeEvidence(edge, actual, await capture?.requests() ?? [], reason, actualPath);
      await capture?.close();
    }
  }

  update(0, jobs.length);
  await Promise.all([run(), run()]);
}
