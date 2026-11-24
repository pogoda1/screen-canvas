import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import test from 'node:test';
import { preparePackagedLaunch } from '../test/packaged/launcher.mjs';
import { runBasic, runCatalog } from '../test/transfer.mjs';
import { hashFile } from '../test/prepare-transfer.mjs';
import { launchCanvas, pick } from '../test/helpers/electron.mjs';

const { values } = parseArgs({
  options: {
    app: { type: 'string' }, project: { type: 'string' }, artifact: { type: 'string' },
    'deny-root': { type: 'string', multiple: true }, scenario: { type: 'string' }
  }
});
if (!values.app || !values.project) throw new Error('Pass --app and --project');
const scenario = values.scenario ?? (values.artifact ? 'catalog' : 'basic');

test('reopened application runs from its packaged resources', { timeout: 100_000 }, async t => {
  const { options, executable, project, trace } = await preparePackagedLaunch(
    t, values.app, values.project, values['deny-root']);
  let digest;
  if (values.artifact) {
    digest = await hashFile(await realpath(values.artifact));
    const vendor = path.join(project, 'vendor');
    const archives = (await readdir(vendor)).filter(name => name.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    assert.equal(await hashFile(path.join(vendor, archives[0])), digest);
    const installed = await realpath(path.join(project, 'node_modules', 'react-screen-canvas'));
    assert.ok(installed.startsWith(project + path.sep));
    const lock = JSON.parse(await readFile(path.join(project, 'package-lock.json'), 'utf8'));
    const sdk = lock.packages['node_modules/react-screen-canvas'];
    assert.equal(sdk.resolved, 'file:vendor/' + archives[0]);
    const integrity = createHash('sha512').update(await readFile(path.join(vendor, archives[0]))).digest('base64');
    assert.equal(sdk.integrity, 'sha512-' + integrity);
  }

  if (scenario === 'basic') await runBasic(t, project, options);
  else if (scenario === 'catalog') await runCatalog(t, project, options, true);
  else if (scenario === 'routes') {
    const { electron, shell } = await launchCanvas(t, options);
    await pick(electron, shell, project);
    await shell.getByText('Маршруты найдены', { exact: false }).waitFor({ timeout: 30_000 });
    const { graph } = await shell.evaluate(() => screenCanvas.state());
    console.log('ROUTES=' + JSON.stringify(graph.nodes.map(node => node.path)));
    await electron.close();
  } else throw new Error('Choose scenario basic, catalog or routes');

  const control = trace ? (await readFile(trace, 'utf8')).trim() : undefined;
  if (control) assert.equal(control, 'deny-controls=' + values['deny-root'].length + ' allow-project=1');
  console.log(JSON.stringify({ executable, cwd: options.cwd, project, digest, control }));
});
