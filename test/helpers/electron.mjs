import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

export async function launchCanvas(t, options = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'screen-canvas-profile-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
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
