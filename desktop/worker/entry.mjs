import { readFile } from 'node:fs/promises';
import { assertJson, assertScenario, matchesStamp } from '../../core/contracts.mjs';
import { identifyNode } from '../../core/graph-evidence.mjs';
import { scanProject } from '../../core/discovery/project.mjs';
import { makeScenario, scenarioUrl } from '../../core/data/scenario.mjs';
import { discoverTypeSources } from '../../core/data/typescript.mjs';
import { openApiOperations } from '../../core/data/openapi.mjs';
import { resolveNodeSchema } from '../../core/data/bindings.mjs';
import { validatePatch, validateValue } from '../../core/data/validate.mjs';
import { createVariantStore } from '../../core/variants.mjs';
import { detectProject, projectPath } from '../../core/host/detect.mjs';
import { startVite } from '../../core/host/vite.mjs';
import { openSession } from '../../core/host/sessions.mjs';

export function attachWorker(port, { root = process.cwd(), bootstrapFile } = {}) {
  let generation;
  let project;
  let host;
  let graph;
  let schemas = new Map();
  let variants;
  let starting;
  let disposed = false;
  let graphRevision = 0;
  let stopping;
  let openings = 0;
  const sessions = new Map();

  const requireNode = id => {
    const node = graph?.nodes.find(item => item.id === id);
    if (!node) throw new Error('Screen is absent from the current graph');
    return node;
  };
  const requireSession = id => {
    const session = sessions.get(id);
    if (!session) throw new Error('Preview session is closed');
    return session;
  };

  async function scan() {
    const revision = ++graphRevision;
    const analysis = await scanProject(project.root, project.tsconfig);
    const extraNodes = typeof project.adapter.nodes === 'function' ? await project.adapter.nodes() : project.adapter.nodes;
    const actions = typeof project.adapter.actions === 'function' ? await project.adapter.actions() : project.adapter.actions;
    const nodes = [...analysis.nodes, ...(extraNodes ?? [])];
    const edges = [...analysis.edges, ...(actions ?? []).map(action => ({ ...action, action: 'adapter', evidence: { status: 'static' } }))];
    const filename = project.adapter.openapi ?? 'openapi.json';
    const openapi = await projectPath(project.root, filename, !project.adapter.openapi);
    const operations = openapi ? openApiOperations(JSON.parse(await readFile(openapi, 'utf8')), filename) : new Map();
    const nextSchemas = new Map();
    for (const node of nodes) {
      const sources = discoverTypeSources(analysis, project.root, node.id, project.adapter.transports);
      const explicit = await project.adapter.schema?.(node);
      nextSchemas.set(node.id, resolveNodeSchema(sources, operations, project.adapter.bindings, explicit) ?? null);
    }
    const next = assertJson({ nodes, edges, diagnostics: analysis.diagnostics });
    if (disposed || revision !== graphRevision) throw new Error('Scan superseded');
    schemas = nextSchemas;
    graph = next;
    return graph;
  }

  async function start(nextGeneration) {
    generation = nextGeneration;
    project = await detectProject(root);
    if (disposed) return;
    host = await startVite(project);
    if (disposed) return;
    variants = await createVariantStore(project.root, id => schemas.get(id));
    return scan();
  }

  async function makeSession({ nodeId, mode, variantId, timeout }) {
    const node = requireNode(nodeId);
    let scenario;
    if (variantId) {
      const entry = await variants.read(variantId);
      if (entry.status !== 'ready' || entry.value.scenario.nodeId !== nodeId) throw new Error('Variant cannot open on this screen');
      scenario = entry.value.scenario;
    } else {
      const input = await project.adapter.scenario?.(node, mode) ?? {};
      scenario = makeScenario(node, {
        schema: schemas.get(nodeId), fixture: input.data, params: input.params,
        seed: input.seed, draft: input.draft, mode: input.mode ?? mode, entities: input.entities
      });
    }
    const session = await openSession({ project, host, generation, scenario, timeout, bootstrapFile });
    if (disposed) {
      await session.close();
      throw new Error('Project closed');
    }
    session.saving = new Map();
    sessions.set(session.id, session);
    return { id: session.id, origin: session.origin, path: scenarioUrl(node, scenario), scenario,
      schema: schemas.get(nodeId) };
  }

  async function shutdown() {
    if (!stopping) {
      disposed = true;
      stopping = (async () => {
        const closing = [...sessions.values()].map(session => session.close());
        sessions.clear();
        await Promise.allSettled(closing);
        await starting?.catch(() => {});
        await host?.close();
      })();
    }
    return stopping;
  }

  async function command(message) {
    const { operation, args = {} } = message;
    if (operation === 'shutdown') return shutdown();
    if (disposed) throw new Error('Project closed');
    if (operation === 'start' && !starting) {
      starting = start(message.generation);
      return starting;
    }
    if (message.generation !== generation || !starting) throw new Error('Project generation expired');
    await starting;
    if (disposed) throw new Error('Project closed');
    if (operation === 'graph') return graph;
    if (operation === 'scan') return scan();
    if (operation === 'variants') return variants.list();
    if (operation === 'open') {
      if (sessions.size + openings >= 3) throw new Error('Preview limit reached');
      openings++;
      try { return await makeSession(args); }
      finally { openings--; }
    }
    if (operation === 'close' && !sessions.has(args.id)) return;
    const session = requireSession(args.id);
    if (operation === 'close') {
      sessions.delete(args.id);
      return session.close();
    }
    if (operation === 'invalidate') return session.protocol.invalidate(args.before);
    if (operation === 'read') return (await readCurrent(session)).scenario;
    if (operation === 'cancel-save') return session.saving.get(args.requestId)?.abort(new Error('Save cancelled'));
    if (operation === 'requests') return session.requests;
    if (operation === 'loading') return session.setLoading(args.value === true);
    if (operation === 'patch') {
      const current = session.protocol.scenario;
      const schema = schemas.get(current.nodeId);
      if (!schema) throw new Error('Screen has no editable fields');
      const result = validatePatch(schema, current.data, args.edits);
      if (result.errors.length) return { errors: result.errors };
      const scenario = { ...current, data: result.value };
      const revision = session.protocol.setScenario(scenario);
      const reload = args.edits.some(edit => schema.fields?.[edit.path[0]]?.binding?.kind === 'api');
      return { scenario, revision, reload, errors: [] };
    }
    if (operation === 'save') {
      const cancellation = new AbortController();
      const requestId = args.requestId ?? 'save';
      if (session.saving.has(requestId)) throw new Error('Save is already pending');
      session.saving.set(requestId, cancellation);
      try {
        const { scenario, stamp } = await readCurrent(session, cancellation.signal);
        const accept = () => {
          cancellation.signal.throwIfAborted();
          if (disposed || sessions.get(args.id) !== session || !matchesStamp(stamp, session.protocol.stamp())) {
            throw new Error('Preview changed before the save completed');
          }
        };
        accept();
        const input = { scenario, name: args.name, accept };
        return await (args.variantId ? variants.update({ ...input, id: args.variantId, revision: args.revision }) :
          variants.create(input));
      } finally {
        session.saving.delete(requestId);
      }
    }
    throw new Error('Unknown worker operation');
  }

  async function readCurrent(session, signal) {
    const { scenario: snapshot, pathname, nodeId, stamp } = await session.protocol.read(signal);
    const observed = typeof pathname === 'string' && pathname.startsWith('/') ?
      identifyNode(graph, pathname, nodeId) : snapshot.nodeId;
    if (!observed) throw new Error('The current page does not identify a known screen');
    const node = requireNode(observed);
    const scenario = observed === snapshot.nodeId ? snapshot : makeScenario(node, {
      schema: schemas.get(observed), seed: snapshot.seed, mode: snapshot.mode,
      params: inferParams(node.path, pathname)
    });
    const schema = schemas.get(scenario.nodeId);
    if (schema && validateValue(schema, scenario.data, '$', true).length) {
      throw new Error('Preview state does not match the current schema');
    }
    return { scenario, stamp };
  }

  port.on('message', async message => {
    const envelope = { id: message?.id, generation: message?.generation };
    try {
      assertJson(message);
      const value = await command(message);
      port.send(assertJson({ ...envelope, value: value ?? null }));
    } catch (error) {
      port.send({ ...envelope, error: { code: typeof error.code === 'string' ? error.code : 'project-error',
        message: error instanceof Error ? error.message : 'Project operation failed' } });
    }
    if (message?.operation === 'shutdown') port.exit();
  });
  port.on('disconnect', () => { void shutdown().finally(port.exit); });
}

function inferParams(pattern, pathname) {
  const segments = pathname.split('/');
  return Object.fromEntries(pattern.split('/').flatMap((part, index) => {
    if (!part.startsWith(':') || !segments[index]) return [];
    return [[part.slice(1).replace(/\?$/, ''), decodeURIComponent(segments[index])]];
  }));
}

if (process.parentPort) {
  const parent = process.parentPort;
  attachWorker({
    on(event, listener) {
      if (event === 'message') parent.on('message', ({ data }) => listener(data));
      else parent.on('close', listener);
    },
    send: payload => parent.postMessage(payload),
    exit: () => setImmediate(() => process.exit(0))
  }, { bootstrapFile: process.argv[2] });
}
