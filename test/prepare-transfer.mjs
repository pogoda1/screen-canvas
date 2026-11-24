import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, parseArgs } from 'node:util';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
export const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');

async function copyFixture(project, fixture) {
  const out = path.resolve(project);
  const parent = await realpath(path.dirname(out));
  const canonical = path.join(parent, path.basename(out));
  if (canonical === path.normalize(repo).replace(/\/$/, '') || canonical.startsWith(repo)) {
    throw new Error('Choose a new directory outside the source repository');
  }
  await mkdir(canonical);
  await cp(path.join(repo, 'fixtures', fixture), canonical, {
    recursive: true,
    filter: source => !source.split(path.sep).some(name => name === 'node_modules' || name === '.DS_Store')
  });
  return canonical;
}

export async function prepareBasic(out) {
  const project = await copyFixture(out, 'screen-canvas-basic');
  await exec('npm', ['ci'], { cwd: project });
  return project;
}

export async function prepareTransfer(out, artifact) {
  const project = await copyFixture(out, 'screen-canvas-catalog');
  const stage = await mkdtemp(path.join(os.tmpdir(), 'screen-canvas-pack-'));
  try {
    let archive;
    if (artifact) archive = await realpath(artifact);
    else {
      const { stdout } = await exec('npm', ['pack', './packages/runtime', '--pack-destination', stage, '--json'], { cwd: repo });
      archive = path.join(stage, JSON.parse(stdout)[0].filename);
    }
    const directory = path.join(project, 'vendor');
    await mkdir(directory);
    const copied = path.join(directory, path.basename(archive));
    const digest = await hashFile(archive);
    await copyFile(archive, copied);
    assert.equal(await hashFile(copied), digest);
    await exec('npm', ['ci'], { cwd: project });
    await exec('npm', ['install', '-D', './vendor/' + path.basename(copied)], { cwd: project });
    const installed = await realpath(path.join(project, 'node_modules/react-screen-canvas'));
    assert.ok(installed.startsWith(project + path.sep));
    const validation = await exec(process.execPath, ['--input-type=module', '-e', `
      import { defineAdapter } from 'react-screen-canvas';
      import { registerBrowserBindings } from 'react-screen-canvas/browser';
      if (typeof defineAdapter !== 'function' || typeof registerBrowserBindings !== 'function') process.exit(1);
      console.log(import.meta.resolve('react-screen-canvas/browser'));
    `], { cwd: project });
    assert.ok(fileURLToPath(validation.stdout.trim()).startsWith(installed + path.sep));
    return { project, artifact: copied, digest, installed };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, artifact: { type: 'string' }, basic: { type: 'boolean' } } });
  if (!values.out) throw new Error('Pass --out with a new directory outside the source repository');
  console.log(JSON.stringify(values.basic ? { project: await prepareBasic(values.out) } :
    await prepareTransfer(values.out, values.artifact), null, 2));
}
