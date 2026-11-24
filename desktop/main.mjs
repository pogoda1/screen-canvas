import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, utilityProcess } from 'electron';
import { assertJson } from '../core/contracts.mjs';
import { ProjectController } from './project-controller.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const shellUrl = 'app://canvas/index.html';
const shellFiles = new Set(['index.html', 'start.js']);
const channel = 'canvas:command';
let window;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function launchWorker(root) {
  const workerPath = app.isPackaged ? path.join(process.resourcesPath, 'worker', 'entry.mjs') : path.join(directory, 'worker', 'entry.mjs');
  const bootstrap = app.isPackaged ? path.join(process.resourcesPath, 'worker', 'bootstrap.js')
    : path.join(directory, '../core/host/bootstrap.js');
  const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].flatMap(key =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return utilityProcess.fork(workerPath, [bootstrap], { cwd: root, env, serviceName: 'Screen Canvas Project' });
}

const controller = new ProjectController(launchWorker, () => {});

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
    const { command, generation } = payload;
    if (command === 'state') return { value: controller.state };
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
    throw new Error('Unknown canvas command');
  } catch (error) {
    return { error: { code: typeof error.code === 'string' ? error.code : 'desktop-error', message: error.message } };
  }
});

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
