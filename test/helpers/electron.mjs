import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { _electron } from 'playwright';

export async function launchCanvas(t, options = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'screen-canvas-profile-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  if (process.env.SCREEN_CANVAS_APP && !options.executablePath) {
    const app = await realpath(process.env.SCREEN_CANVAS_APP);
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'screen-canvas-regression-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    options = { cwd, ...options, executablePath: path.join(app, 'Contents', 'MacOS', 'Screen Canvas') };
  }
  const entry = fileURLToPath(new URL('../../desktop/main.mjs', import.meta.url));
  const electron = await _electron.launch({
    args: [...(options.executablePath ? [] : [entry]), '--user-data-dir=' + userData],
    chromiumSandbox: true,
    ...options
  });
  t.after(() => electron.close().catch(() => {}));
  const shell = await electron.firstWindow();
  shell.setDefaultTimeout(12_000);
  return { electron, shell };
}

export async function pick(electron, shell, folder) {
  await electron.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: directory === null, filePaths: directory === null ? [] : [directory] });
  }, folder);
  await shell.getByRole('button', { name: 'Открыть проект' }).click();
}

export async function guestEval(electron, expression) {
  return electron.evaluate(({ BrowserWindow }, code) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('app://canvas/'));
    const guest = window?.contentView.children.map(view => view.webContents)
      .find(contents => contents?.getURL().startsWith('http://127.0.0.1:'));
    if (!guest) throw new Error('No live preview');
    return guest.executeJavaScript(code);
  }, expression);
}

export async function waitGuest(electron, expression, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await guestEval(electron, expression);
      if (result) return result;
    } catch {}
    await setTimeout(40);
  }
  throw new Error('Live preview did not satisfy ' + expression);
}

export async function waitGraph(shell, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await shell.evaluate(() => screenCanvas.state());
    if (state.error || state.scanError) throw new Error(state.error ?? state.scanError);
    if (state.progress?.total > 0 && state.progress.total === state.progress.completed) return state.graph;
    await setTimeout(100);
  }
  throw new Error('The graph scan did not finish');
}
