import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { scanProject } from '../core/discovery/project.mjs';

test('discovers nested, indexed and lazy routes across aliases and referenced configs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'), 'dir');
  await mkdir(path.join(root, 'src'));
  const files = {
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    'tsconfig.app.json': JSON.stringify({ include: ['src'], compilerOptions: {
      jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] }
    } }),
    'src/routes.tsx': `
      import { lazy } from 'react';
      import { Routes, Route as R, Navigate, Outlet, Link } from 'react-router-dom';
      import { Shared } from './shared';
      const Index = lazy(() => import('@/index'));
      const Layout = () => <Outlet />;
      const Wrapped = ({children}) => <section>{children}</section>;
      const First = () => <><Shared/><Link to="/else">Next</Link></>;
      const Second = () => <Shared/>;
      export const App = () => <Routes>
        <R path="/products" element={<Layout/>}>
          <R index element={<Wrapped><Index/></Wrapped>}/>
          <R path=":id" element={<First/>}/>
        </R>
        <R path="/old" element={<Navigate to="/products"/>}/>
        <R path="/else" element={<Second/>}/>
        <R path="*" element={<p>Missing</p>}/>
      </Routes>;
    `,
    'src/index.tsx': `
      import { Link, useNavigate } from 'react-router-dom';
      export default function Index() {
        const navigate = useNavigate();
        const id = 17;
        return <><Link to="17">Read</Link><button onClick={() => navigate(\`/products/\${id}\`)}>Open</button></>;
      }
    `,
    'src/shared.tsx': `
      import { Link } from 'react-router-dom';
      export const Shared = () => <Link to="/old">Shared action</Link>;
    `
  };
  await Promise.all(Object.entries(files).map(([name, body]) => writeFile(path.join(root, name), body)));
  const { nodes, edges } = await scanProject(root);
  assert.deepEqual(nodes.map(node => node.id), [
    'route:/products', 'route:/products#index', 'route:/products/:id', 'route:/old', 'route:/else', 'route:/*'
  ]);
  assert.equal(nodes[1].parentId, nodes[0].id);
  assert.deepEqual(edges.map(({ source, target, label }) => [source, target, label]), [
    ['route:/products#index', 'route:/products/:id', 'Read'],
    ['route:/products#index', 'route:/products/:id', 'Open'],
    ['route:/products/:id', 'route:/else', 'Next'],
    ['route:/old', 'route:/products#index', '/products']
  ]);
  assert.ok(nodes[2].diagnostics.some(diagnostic => diagnostic.code === 'action-ambiguous'));
});
