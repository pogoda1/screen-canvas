import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packager } from '@electron/packager';
import { buildDesktop } from './build-desktop.mjs';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on Apple Silicon macOS');
const out = path.join(repo, 'out');
const release = path.join(out, 'release');
const staging = path.join(out, 'staging');
const versions = JSON.parse(await readFile(path.join(repo, 'package.json')));
const { app: input, worker } = await buildDesktop(staging);
const [target] = await packager({
  dir: input,
  out: path.join(staging, 'mac'),
  name: 'Screen Canvas',
  executableName: 'Screen Canvas',
  appBundleId: 'app.screen-canvas.desktop',
  platform: 'darwin',
  arch: 'arm64',
  electronVersion: versions.devDependencies.electron,
  electronZipDir: process.env.SCREEN_CANVAS_ELECTRON_ZIP_DIR,
  asar: true,
  extraResource: worker,
  overwrite: true
});
const app = path.join(target, 'Screen Canvas.app');
const executable = path.join(app, 'Contents', 'MacOS', 'Screen Canvas');
const machine = await exec('/usr/bin/file', [executable]);
if (!machine.stdout.includes('arm64')) throw new Error('Expected an arm64 executable');
await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const tempZip = path.join(staging, 'Screen-Canvas-darwin-arm64.zip');
await exec('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, tempZip]);
const digest = createHash('sha256');
for await (const chunk of createReadStream(tempZip)) digest.update(chunk);
await mkdir(release, { recursive: true });
const installed = path.join(release, 'Screen Canvas.app');
const zip = path.join(release, 'Screen-Canvas-darwin-arm64.zip');
await rm(installed, { force: true, recursive: true });
await rename(app, installed);
await rename(tempZip, zip);
console.log(JSON.stringify({ app: installed, zip, sha256: digest.digest('hex'), arch: 'arm64' }, null, 2));
