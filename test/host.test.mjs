import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { ProjectWorker } from '../desktop/project-controller.mjs';
import { makeHost } from './helpers/host-fixture.mjs';

test('isolates actual Vite worker listeners, fixtures and document revisions', { timeout: 20000 }, async t => {
  const control = createServer(socket => socket.end('owned by test'));
  control.listen(24678, '127.0.0.1');
  await once(control, 'listening');
  t.after(() => control.close());
  const root = await makeHost(t, {
    'vite.config.mjs': `export default { server: { proxy: { '/api': 'http://127.0.0.1:24678' } },
      plugins: [{ name: 'env-test', configResolved() {
        if (process.env.VITE_DEMO !== 'local') throw Error('Missing demo environment');
      } }] };`,
    'screen-canvas.config.mjs': `export default {
      env: { VITE_DEMO: 'local' },
      scenario: (node, mode) => ({ data: { label: mode ?? 'first' } }),
      createMocks(scenario) {
        let cursor = 0;
        return ({ path, search }) => {
          if (path === '/api/test') return { body: { label: scenario.data.label, cursor: ++cursor } };
          if (path === '/api/search') return { body: { search } };
          if (path === '/api/null') return { body: null };
        };
      }
    };`
  });
  const child = fork(new URL('./helpers/node-worker.mjs', import.meta.url), { cwd: root, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const exited = once(child, 'exit');
  let serial = 0;
  const pending = new Map();
  child.on('message', message => {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const invoke = (operation, args) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.value));
    child.send({ id, operation, generation: 5, ...(args ? { args } : {}) });
  });
  const graph = await invoke('start');
  assert.ok(graph.nodes.some(node => node.id === 'route:/'));
  const a = await invoke('open', { nodeId: 'route:/', mode: 'first', timeout: 350 });
  const b = await invoke('open', { nodeId: 'route:/', mode: 'second' });
  const listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
    .split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)).sort();
  assert.deepEqual(listeners, [new URL(a.origin).host, new URL(b.origin).host].sort());
  const api = async origin => (await fetch(origin + '/api/test')).json();
  assert.deepEqual(await api(a.origin), { label: 'first', cursor: 1 });
  assert.deepEqual(await api(b.origin), { label: 'second', cursor: 1 });
  assert.deepEqual(await api(a.origin), { label: 'first', cursor: 2 });
  const absent = await fetch(b.origin + '/api/unknown');
  assert.equal(absent.status, 501);
  assert.match((await absent.json()).error, /No local mock/);
  const explicitNull = await fetch(b.origin + '/api/null');
  assert.equal(explicitNull.status, 200);
  assert.equal(await explicitNull.text(), 'null');
  assert.deepEqual(await (await fetch(b.origin + '/api/search?q=a%26b&q=c')).json(), { search: '?q=a%26b&q=c' });

  async function document() {
    const page = await (await fetch(a.origin, { headers: { accept: 'text/html', 'x-screen-canvas-navigation': a.navigationKey } })).text();
    const { stamp, token, initial } = JSON.parse(/__screenCanvasBoot=(.*?);\(\(\)/s.exec(page)[1]);
    const send = (type, extra) => fetch(a.origin + '/__screen_canvas/session', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-screen-canvas-document': token },
      body: JSON.stringify({ ...stamp, type, ...extra })
    });
    return { stamp, send, initial };
  }
  async function ready(page) {
    assert.equal((await page.send('ready')).status, 200);
    assert.equal((await (await page.send('poll')).json()).type, 'apply');
    assert.equal((await page.send('ack')).status, 200);
  }
  const oldPage = await document();
  await ready(oldPage);
  const unrelated = await (await fetch(a.origin + '/fragment', { headers: { accept: 'text/html' } })).text();
  assert.ok(!unrelated.includes('__screenCanvasBoot='));
  const original = invoke('save', { id: a.id, name: 'Original' });
  const originalRead = await (await oldPage.send('poll')).json();
  await oldPage.send('snapshot', { requestId: originalRead.requestId, scenario: oldPage.initial });
  const file = await original;

  const nextPage = await document();
  assert.notEqual(nextPage.stamp.documentId, oldPage.stamp.documentId);
  const waiting = invoke('save', { id: a.id, name: 'Current', variantId: file.id, revision: file.revision });
  const rejected = assert.rejects(waiting, /Timed out/);
  assert.equal((await oldPage.send('snapshot', { requestId: originalRead.requestId, scenario: oldPage.initial })).status, 409);
  await rejected;
  assert.equal((await invoke('variants'))[0].value.revision, 1);

  const saved = invoke('save', { id: a.id, name: 'Current', variantId: file.id, revision: file.revision });
  await ready(nextPage);
  const read = await (await nextPage.send('poll')).json();
  assert.equal(read.type, 'read');
  await nextPage.send('snapshot', { requestId: read.requestId, scenario: { ...nextPage.initial, data: { label: 'reloaded' } } });
  assert.equal((await saved).scenario.data.label, 'reloaded');

  await invoke('loading', { id: b.id, value: true });
  const interrupted = assert.rejects(fetch(b.origin + '/api/test'));
  await setTimeout(25);
  await invoke('close', { id: b.id });
  await interrupted;
  await invoke('shutdown');
  assert.deepEqual(await exited, [0, null]);
  for (const { origin } of [a, b]) await assert.rejects(fetch(origin));
  assert.ok(control.listening);
});


test('expired opens release their slots without leaving late listeners', { timeout: 12_000 }, async t => {
  const root = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      async scenario(node) {
        if (node.path === '/') await new Promise(resolve => setTimeout(resolve, 400));
        return {};
      }
    };`
  });
  const child = fork(new URL('./helpers/node-worker.mjs', import.meta.url), {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });
  const worker = new ProjectWorker({
    on: child.on.bind(child), once: child.once.bind(child),
    postMessage: child.send.bind(child), kill: child.kill.bind(child)
  }, 12, () => {});
  t.after(() => worker.stop());
  await worker.call('start');
  const expired = Array.from({ length: 3 }, () =>
    assert.rejects(worker.call('open', { nodeId: 'route:/' }, 45), /Timed out/));
  await Promise.all(expired);
  const next = await worker.call('open', { nodeId: 'route:/next' });
  await setTimeout(500);
  const listening = execFileSync('/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
  assert.deepEqual(listening.split('\n').filter(line => line.startsWith('n')), ['n' + new URL(next.origin).host]);
  await worker.stop();
  await assert.rejects(fetch(next.origin));
});

test('sessions record verified document/route attribution and settlement order without guessing from Referer or latest HTML', { timeout: 15_000 }, async t => {
  const root = await makeHost(t, {
    'screen-canvas.config.mjs': `export default {
      createMocks: () => ({ path }) => path === '/api/items/1' || path === '/api/keepalive' || path === '/api/origin-only'
        ? { status: 501, body: {} } : { status: 200, body: { ok: true } }
    };`
  });
  const child = fork(new URL('./helpers/node-worker.mjs', import.meta.url), {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });
  const worker = new ProjectWorker({
    on: child.on.bind(child), once: child.once.bind(child),
    postMessage: child.send.bind(child), kill: child.kill.bind(child)
  }, 15, () => {});
  t.after(() => worker.stop());
  await worker.call('start');
  const session = await worker.call('open', { nodeId: 'route:/' });
  const loadDoc = async pathname => {
    const html = await (await fetch(session.origin + pathname, {
      headers: { accept: 'text/html', 'x-screen-canvas-navigation': session.navigationKey }
    })).text();
    return JSON.parse(/__screenCanvasBoot=(.*?);\(\(\)/s.exec(html)[1]);
  };
  const doc1 = await loadDoc('/items/1');
  // 1. Verified request on doc1 completed before doc2.
  await fetch(session.origin + '/api/items/1', {
    headers: {
      'x-screen-canvas-req-doc': doc1.observeToken,
      'x-screen-canvas-req-path': '/items/1',
      'x-screen-canvas-req-id': '1'
    }
  });
  await fetch(session.origin + '/__screen_canvas/observe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-screen-canvas-observe': doc1.observeToken },
    body: JSON.stringify({ requestId: '1', beforeNavigation: true })
  });
  // 2. Origin-only Referer WITHOUT observeToken must NOT guess sourcePath or documentId.
  await fetch(session.origin + '/api/origin-only', { headers: { referer: session.origin + '/' } });
  // 3. Full-page navigation loads doc2.
  const doc2 = await loadDoc('/items');
  assert.notEqual(doc1.stamp.documentId, doc2.stamp.documentId);
  // 4. Stale keepalive from doc1 arriving AFTER doc2 without observeToken must NOT get doc2's documentId.
  await fetch(session.origin + '/api/keepalive');
  // 5. Stale keepalive from doc1 arriving AFTER doc2 WITH doc1 observeToken keeps doc1 and marks settledBeforeNavigation=false.
  await fetch(session.origin + '/api/keepalive', {
    headers: {
      'x-screen-canvas-req-doc': doc1.observeToken,
      'x-screen-canvas-req-path': '/items/1',
      'x-screen-canvas-req-id': '2'
    }
  });
  // 6. Verified request on doc2 with origin-only Referer still records /items, NOT /.
  await fetch(session.origin + '/api/items', {
    headers: {
      referer: session.origin + '/',
      'x-screen-canvas-req-doc': doc2.observeToken,
      'x-screen-canvas-req-path': '/items',
      'x-screen-canvas-req-id': '1'
    }
  });
  const records = await worker.call('requests', { id: session.id });
  assert.equal(records.length, 5);
  assert.equal(records[0].sourcePath, '/items/1');
  assert.equal(records[0].documentId, doc1.stamp.documentId);
  assert.equal(records[0].initialDocument, true);
  assert.equal(records[0].settledBeforeNavigation, true);
  assert.equal(records[1].sourcePath, undefined);
  assert.equal(records[1].documentId, undefined);
  assert.equal(records[2].sourcePath, undefined);
  assert.equal(records[2].documentId, undefined);
  assert.equal(records[3].sourcePath, '/items/1');
  assert.equal(records[3].documentId, doc1.stamp.documentId);
  assert.equal(records[3].settledBeforeNavigation, false);
  assert.equal(records[4].sourcePath, '/items');
  assert.equal(records[4].documentId, doc2.stamp.documentId);
  assert.equal(records[4].initialDocument, false);
  await worker.stop();
});
