import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = fileURLToPath(new URL('../', import.meta.url));

export async function buildDesktop(output = path.join(repo, 'out', 'staging')) {
  const app = path.join(output, 'app');
  const worker = path.join(output, 'worker');
  await rm(output, { force: true, recursive: true });
  await Promise.all([mkdir(app, { recursive: true }), mkdir(worker, { recursive: true })]);
  const desktop = path.join(repo, 'desktop');
  const shell = await readdir(path.join(desktop, 'shell'));
  for (const file of shell) {
    if (!['.js', '.css', '.html'].includes(path.extname(file))) throw new Error('Unrecognized renderer input: ' + file);
  }
  await build({
    absWorkingDir: repo,
    entryPoints: ['desktop/main.mjs', 'desktop/worker/entry.mjs'],
    outdir: output,
    outbase: 'desktop',
    entryNames: '[dir]/[name]',
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    target: 'node24',
    format: 'esm',
    bundle: true,
    external: ['electron'],
    legalComments: 'none'
  });
  await mkdir(path.join(app, 'desktop'));
  await Promise.all([
    cp(path.join(output, 'main.mjs'), path.join(app, 'desktop', 'main.mjs')),
    cp(path.join(desktop, 'preload.cjs'), path.join(app, 'desktop', 'preload.cjs')),
    cp(path.join(desktop, 'shell'), path.join(app, 'desktop', 'shell'), { recursive: true }),
    cp(path.join(repo, 'core', 'host', 'bootstrap.js'), path.join(worker, 'bootstrap.js')),
    writeFile(path.join(app, 'package.json'), JSON.stringify({
      name: 'screen-canvas-desktop', productName: 'Screen Canvas', version: '0.1.0', main: 'desktop/main.mjs'
    }, null, 2) + '\n')
  ]);
  await rm(path.join(output, 'main.mjs'));
  return { app, worker };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(await buildDesktop());
}
