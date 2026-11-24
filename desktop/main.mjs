import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, utilityProcess } from 'electron';
import { assertJson } from '../core/contracts.mjs';
import { crawlGraph } from './scan/runner.mjs';
import { PreviewController } from './preview.mjs';
import { ProjectController } from './project-controller.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const shellUrl = 'app://canvas/index.html';
const shellFiles = new Set(['index.html', 'start.js', 'preview-slot.js', 'styles.css', 'graph.js', 'layout.js', 'selection.js', 'editor.js', 'variants.js', 'dom.js']);
const channel = 'canvas:command';
let window;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function launchWorker(root) {
  const workerPath = app.isPackaged ? path.join(process.resourcesPath, 'worker', 'entry.mjs') : path.join(directory, 'worker', 'entry.mjs');
  const bootstrap = app.isPackaged ? path.join(process.resourcesPath, 'worker', 'bootstrap.js')
    : path.join(directory, '../core/host/bootstrap.js');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['HOME', 'PATH', 'TMPDIR', 'LANG'].includes(key) || key.startsWith('VITE_')));
  return utilityProcess.fork(workerPath, [bootstrap], { cwd: root, env, serviceName: 'Screen Canvas Project' });
}

let crawling;
let shellVersion = 0;
const preview = new PreviewController(() => window, () => { shellVersion++; });
const controller = new ProjectController(launchWorker, state => {
  shellVersion++;
  if (state.status !== 'ready') {
    crawling?.abort.abort();
    crawling = undefined;
    void preview.close();
  } else if (!crawling) startCrawl();
});

function startCrawl() {
  const current = controller.state;
  const graph = structuredClone(current.graph);
  for (const node of graph.nodes) node.diagnostics ??= [];
  const abort = new AbortController();
  const operation = { abort };
  crawling = operation;
  operation.done = crawlGraph(controller.current, graph, abort.signal, (completed, total) => {
    if (crawling === operation && !abort.signal.aborted) {
      shellVersion++;
      controller.state = { ...current, graph, progress: { completed, total } };
    }
  }).catch(error => {
    if (crawling === operation && !abort.signal.aborted) {
      shellVersion++;
      controller.state = { ...controller.state, scanError: error.message };
    }
  });
}

async function rebuild(worker) {
  const operation = crawling;
  operation?.abort.abort();
  await Promise.allSettled([operation?.done, preview.close()]);
  if (worker !== controller.current) throw new Error('Project generation expired');
  await controller.retry();
}

function trusted(event) {
  const contents = window?.webContents;
  return contents && !contents.isDestroyed() && event.sender === contents &&
    event.senderFrame === contents.mainFrame && event.senderFrame?.url === shellUrl &&
    contents.getURL() === shellUrl;
}

ipcMain.handle(channel, async (event, payload) => {
  if (!trusted(event)) throw new Error('Canvas command refused');
  try {
    assertJson(payload);
    const { command, generation, args } = payload;
    if (command === 'state') return {
      value: args?.version === shellVersion ? null : { ...controller.state, version: shellVersion, live: preview.description }
    };
    if (command === 'choose') {
      const { canceled, filePaths } = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
      if (!canceled && filePaths.length === 1 && trusted(event)) void controller.choose(filePaths[0]).catch(error => {
        controller.publish('error', { error: error.message });
      });
      return { value: null };
    }
    if (!Number.isSafeInteger(generation) || controller.generation !== generation) throw new Error('Project generation expired');
    if (command === 'retry') {
      void controller.retry();
      return { value: null };
    }
    if (command === 'close') {
      await controller.close();
      return { value: null };
    }
    if (command === 'bounds') {
      preview.resize(args);
      return { value: null };
    }
    const worker = controller.current;
    if (!worker || controller.state.status !== 'ready') throw new Error('Project is not ready');
    if (command === 'open') {
      if (!validId(args?.nodeId) || (args.variantId !== undefined && !validId(args.variantId))) throw new Error('Invalid screen');
      return { value: await preview.open(worker, args.nodeId, args.variantId) };
    }
    if (command === 'rebuild') {
      await rebuild(worker);
      return { value: null };
    }
    if (command === 'cancel-scan') {
      crawling?.abort.abort();
      shellVersion++;
      controller.state = { ...controller.state, scanCancelled: true };
      return { value: null };
    }
    if (command === 'variants') return { value: await worker.call('variants') };
    if (['patch', 'read', 'requests', 'save', 'loading', 'cancel-save'].includes(command)) {
      validatePreviewCommand(command, args);
      return { value: await preview.dispatch(worker, args.id, command, args) ?? null };
    }
    throw new Error('Unknown canvas command');
  } catch (error) {
    return { error: { code: typeof error.code === 'string' ? error.code : 'desktop-error', message: error.message } };
  }
});

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function validatePreviewCommand(command, args) {
  if (!validId(args?.id)) throw new Error('Invalid preview session');
  if (command === 'patch' && (!Array.isArray(args.edits) || args.edits.length > 100 ||
      JSON.stringify(args.edits).length > 1_048_576 || args.edits.some(edit =>
        !Array.isArray(edit?.path) || edit.path.length > 32 ||
        !edit.path.every(key => typeof key === 'string' || Number.isSafeInteger(key))))) throw new Error('Invalid field edit');
  if (command === 'loading' && typeof args.value !== 'boolean') throw new Error('Invalid loading value');
  if ((command === 'save' || command === 'cancel-save') && args.requestId !== undefined && !validId(args.requestId)) {
    throw new Error('Invalid save request');
  }
  if (command === 'save' && (!validId(args.name) || (args.variantId !== undefined &&
      (!validId(args.variantId) || !Number.isSafeInteger(args.revision))))) throw new Error('Invalid variant');
}

function registerShell() {
  protocol.handle('app', request => {
    const target = new URL(request.url);
    const name = target.pathname.slice(1);
    if (request.method !== 'GET' || target.hostname !== 'canvas' || target.port || target.username ||
        target.password || target.search || target.hash || !shellFiles.has(name)) {
      return new Response('Missing canvas resource', { status: 404 });
    }
    return net.fetch(new URL('./shell/' + name, import.meta.url).href);
  });
}

function createWindow() {
  window = new BrowserWindow({ width: 1320, height: 920, minWidth: 810, minHeight: 520,
    title: 'Screen Canvas',
    webPreferences: {
      preload: path.join(directory, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    contents.on(name, event => event.preventDefault());
  }
  const restoreShell = (_event, url, isMainFrame = true) => {
    if (isMainFrame && url !== shellUrl) void contents.loadURL(shellUrl).catch(() => {});
  };
  contents.on('did-navigate', (event, url) => restoreShell(event, url));
  contents.on('did-navigate-in-page', restoreShell);
  window.on('resize', () => preview.resize());
  window.on('closed', () => { window = undefined; });
  return window.loadURL(shellUrl);
}

let quitting = false;
let stopped = false;
app.on('before-quit', event => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void controller.close().finally(() => {
    stopped = true;
    app.quit();
  });
});
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  registerShell();
  return createWindow();
}).catch(error => {
  console.error('Screen Canvas:', error.message);
  app.quit();
});
