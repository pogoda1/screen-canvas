import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { projectPath } from './detect.mjs';

export async function startVite(project) {
  const { root, vitePath, adapter, dev } = project;
  const previous = new Map();
  for (const [key, value] of Object.entries(adapter.env ?? {})) {
    if (!/^[A-Z_][A-Z_\d]*$/.test(key) || typeof value !== 'string') throw new Error('Invalid preview environment');
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let host;
  let transform;
  try {
    if (adapter.createHost) host = await adapter.createHost({ root, adapter });
    else {
      const { createServer } = await import(pathToFileURL(vitePath));
      transform = createRequire(vitePath)('esbuild');
      host = await createServer({
        root,
        mode: dev.mode,
        configFile: dev.configFile ? await projectPath(root, dev.configFile) : undefined,
        server: { middlewareMode: true, host: '127.0.0.1', hmr: false, ws: false, open: false, proxy: {} },
        plugins: [{
          name: 'screen-canvas-host',
          enforce: 'post',
          transform(source, id) {
            if (!id.endsWith('/vite/dist/client/client.mjs')) return;
            // Vite still imports this module for CSS helpers with server.hmr disabled.
            return source.replace('socket = setupWebSocket(socketProtocol, socketHost, fallback);', 'socket = undefined;');
          },
          config(config) {
            config.server = { ...config.server, middlewareMode: true, host: '127.0.0.1',
              hmr: false, ws: false, open: false, proxy: undefined, watch: null };
          }
        }]
      });
    }
    await adapter.configure?.({ load: specifier => host.ssrLoadModule(specifier) });
    return {
      transformIndexHtml: host.transformIndexHtml.bind(host),
      middleware: host.middlewares ?? host.middleware,
      invalidate: () => host.moduleGraph?.invalidateAll(),
      async close() {
        try { await host.close(); }
        finally {
          await transform?.stop();
          restore();
        }
      }
    };
  } catch (error) {
    try { await host?.close(); }
    finally { await transform?.stop(); restore(); }
    throw error;
  }
}
