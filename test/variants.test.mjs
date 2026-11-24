import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createVariantStore } from '../core/variants.mjs';

const scenario = { version: 1, seed: 1, nodeId: 'route:/', mode: 'default', params: {}, data: { name: 'A' } };
const moduleUrl = new URL('../core/variants.mjs', import.meta.url).href;

test('saves by technical ID and serializes compare-and-update', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-variants-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let schema = null;
  const store = await createVariantStore(root, () => schema);
  const first = await store.create({ name: ' Снимок / №1 ', scenario });
  assert.equal(first.name, 'Снимок / №1');
  await assert.rejects(store.create({ name: first.name, scenario }), { code: 'name-conflict' });
  await assert.rejects(store.create({ name: 'private', scenario: { ...scenario, data: { token: 'secret' } } }),
    { code: 'private-data' });
  const otherStore = await createVariantStore(root, () => null);
  const [one, two] = await Promise.allSettled([
    store.update(first), otherStore.update(first)
  ]);
  assert.deepEqual([one.status, two.status].sort(), ['fulfilled', 'rejected']);

  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createVariantStore } from ${JSON.stringify(moduleUrl)};
    const store = await createVariantStore(process.argv[1], () => null);
    process.stdout.write(JSON.stringify(await store.read(process.argv[2])));
  `, root, first.id]);
  assert.equal(JSON.parse(stdout).value.revision, 2);

  const file = path.join(root, 'screen-canvas/scenarios', first.id + '.json');
  const original = await readFile(file);
  schema = { kind: 'object', fields: { name: { kind: 'number' } } };
  assert.equal((await store.read(first.id)).status, 'incompatible');
  schema = undefined;
  assert.equal((await store.read(first.id)).status, 'orphaned');
  assert.deepEqual(await readFile(file), original);
  await writeFile(file, '{');
  assert.equal((await store.list())[0].status, 'corrupt');
});

test('rejects a symlinked variant directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-variants-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'elsewhere'));
  await symlink('elsewhere', path.join(root, 'screen-canvas'));
  const store = await createVariantStore(root, () => null);
  await assert.rejects(store.create({ name: 'Variant', scenario }), { code: 'unsafe-path' });
});


test('an interrupted writer keeps the previous bytes and releases the lock', { timeout: 12_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-lock-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createVariantStore(root, () => null);
  const first = await store.create({ name: 'Existing', scenario });
  const filename = path.join(root, 'screen-canvas/scenarios', first.id + '.json');
  const previous = await readFile(filename);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createVariantStore } from ${JSON.stringify(moduleUrl)};
    import { writeSync } from 'node:fs';
    const store = await createVariantStore(process.argv[1], () => null);
    const { value } = await store.read(process.argv[2]);
    await store.update({ ...value, scenario: { ...value.scenario, data: { name: 'Interrupted' } },
      accept() {
        writeSync(1, 'Holding lock');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      } });
  `, root, first.id], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  const [signal] = await once(child.stdout, 'data');
  assert.equal(signal.toString(), 'Holding lock');
  await assert.rejects(store.update(first), { code: 'busy' });
  assert.deepEqual(await readFile(filename), previous);
  child.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  assert.deepEqual(await readFile(filename), previous);
  assert.equal((await store.update(first)).revision, 2);
});
