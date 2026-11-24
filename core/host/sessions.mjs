import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { assertJson } from '../contracts.mjs';
import { routeMatches } from '../discovery/actions.mjs';
import { DocumentProtocol } from './protocol.mjs';
import { projectPath } from './detect.mjs';

export async function openSession({ project, host, generation, scenario, timeout, bootstrapFile }) {
  const id = randomUUID();
  const protocol = new DocumentProtocol(generation, id, scenario, timeout);
  const mock = await project.adapter.createMocks?.(scenario);
  const indexFile = await projectPath(project.root, 'index.html');
  const bootstrap = await readFile(bootstrapFile ?? fileURLToPath(new URL('./bootstrap.js', import.meta.url)), 'utf8');
  const sockets = new Set();
  const requests = [];
  const responses = new Map();
  const exchanges = [];
  let serial = 0;
  const waiters = new Set();
  let loading = false;
  let disposed = false;
  let origin;
  const server = createServer((request, response) => {
    route(request, response).catch(error => json(response, Number.isInteger(error.status) ? error.status : 500, {
      error: error.expose ? error.message : 'Preview could not serve this request'
    }));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  origin = 'http://127.0.0.1:' + server.address().port;

  async function route(request, response) {
    if (disposed || request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)) return json(response, 403, { error: 'Origin refused' });
    const { pathname } = new URL(request.url, origin);
    if (pathname === '/__screen_canvas/session') {
      if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
        return json(response, 405, { error: 'Expected a session POST' });
      }
      const message = await body(request);
      const result = await protocol.handle(message, request.headers['x-screen-canvas-document']);
      return json(response, result.status, result.body);
    }
    if ((project.adapter.apiPrefixes ?? ['/api']).some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))) {
      const sequence = ++serial;
      const record = { method: request.method, path: pathname, status: 0 };
      if (requests.length >= 250) requests.shift();
      requests.push(record);
      if (loading) await new Promise(resolve => {
        const finish = () => { waiters.delete(finish); resolve(); };
        waiters.add(finish);
        response.once('close', finish);
      });
      if (disposed || response.destroyed) return;
      const current = protocol.scenario;
      const input = { method: request.method, path: pathname, scenario: current };
      if (request.method !== 'GET' && request.method !== 'HEAD') input.body = await body(request);
      try {
        const result = await mock?.(input) ?? generatedMock(input);
        record.status = result?.status ?? (result ? 200 : 501);
        if (result && record.status >= 200 && record.status < 300) {
          if (responses.size >= 250) responses.delete(responses.keys().next().value);
          responses.set(request.method + ' ' + pathname, result.body);
          if (exchanges.length >= 250) exchanges.shift();
          exchanges.push({ sequence, method: request.method, path: pathname, status: record.status,
            body: input.body, response: result.body });
        }
        return json(response, record.status, result?.body ?? { error: 'No local mock for ' + request.method + ' ' + pathname });
      } catch (error) {
        record.status = 500;
        return json(response, 500, { error: error.message });
      }
    }
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
      const page = await host.transformIndexHtml(request.url, await readFile(indexFile, 'utf8'));
      if (response.destroyed || disposed) return;
      const registration = protocol.newDocument();
      const html = inject(page, bootstrap, { ...registration, browser: project.adapter.browser ?? null });
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"
      });
      return response.end(html);
    }
    host.middleware(request, response, () => json(response, 404, { error: 'Resource not found' }));
  }

  return {
    id, origin, protocol, requests, responses, exchanges,
    cursor: () => serial,
    setLoading(value) {
      loading = value;
      if (!loading) for (const finish of waiters) finish();
    },
    async close() {
      if (disposed) return;
      disposed = true;
      protocol.close();
      for (const finish of waiters) finish();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

function generatedMock({ method, path, scenario }) {
  for (const [template, value] of Object.entries(scenario.data)) {
    const [verb, pattern] = template.split(' ');
    if (verb === method && pattern && routeMatches(pattern, path)) return { body: value };
  }
}

function inject(html, bootstrap, config) {
  const entrypoints = [];
  const page = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attributes, content) => {
    if (!/\btype=["']module["']/i.test(attributes)) return tag;
    const src = /\bsrc=["']([^"']+)["']/.exec(attributes);
    if (!src) return tag;
    entrypoints.push('()=>import(' + JSON.stringify(src[1]).replaceAll('<', '\\u003c') + ')');
    return '';
  });
  const data = JSON.stringify(config).replaceAll('<', '\\u003c');
  const script = '<script>globalThis.__screenCanvasBoot=' + data + ';' + bootstrap + '</script>';
  const start = '<script type="module">globalThis.__screenCanvasStart([' + entrypoints.join(',') + '])</script>';
  return page.replace(/<head\b[^>]*>/i, tag => tag + script).replace(/<\/body>/i, start + '</body>');
}

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw Object.assign(new Error('Request exceeds 1 MiB'), { status: 413, expose: true });
    chunks.push(chunk);
  }
  if (!size) return null;
  try { return assertJson(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400, expose: true }); }
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
