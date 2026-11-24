import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function makeHost(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'screen-canvas-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaults = {
    'package.json': JSON.stringify({ name: 'canvas-host', type: 'module', scripts: { dev: 'vite --host' } }),
    'index.html': '<!doctype html><html><head><title>Test host</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    'tsconfig.json': '{"include":["src"],"compilerOptions":{"allowJs":true,"jsx":"react-jsx","moduleResolution":"bundler","module":"ESNext"}}',
    'src/main.jsx': `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
      createRoot(document.getElementById('root')).render(<BrowserRouter><Routes>
        <Route path="/" element={<main><h1>Home screen</h1><Link to="/next">Next screen</Link></main>}/>
        <Route path="/next" element={<h1>Next screen</h1>}/>
      </Routes></BrowserRouter>);
    `
  };
  for (const [filename, content] of Object.entries({ ...defaults, ...files })) {
    if (content === null) continue;
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), content);
  }
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(root, 'node_modules'), 'dir');
  return root;
}
