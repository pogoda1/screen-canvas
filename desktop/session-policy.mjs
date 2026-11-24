import { randomUUID } from 'node:crypto';
import { session } from 'electron';

export function previewPolicy(origin) {
  const partition = 'screen-canvas-' + randomUUID();
  const isolate = session.fromPartition(partition, { cache: false });
  const isLocal = url => {
    try { return new URL(url).origin === origin; }
    catch { return false; }
  };
  isolate.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !isLocal(details.url) && !(details.resourceType !== 'mainFrame' &&
      details.resourceType !== 'subFrame' && /^(?:data:|blob:)/.test(details.url))
  }));
  isolate.setPermissionCheckHandler(() => false);
  isolate.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolate.setDevicePermissionHandler(() => false);
  const denyDownload = event => event.preventDefault();
  isolate.on('will-download', denyDownload);
  return {
    preferences: {
      partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, backgroundThrottling: false
    },
    attach(contents) {
      contents.once('destroyed', () => {
        isolate.webRequest.onBeforeRequest(null);
        isolate.setPermissionCheckHandler(null);
        isolate.setPermissionRequestHandler(null);
        isolate.setDevicePermissionHandler(null);
        isolate.removeListener('will-download', denyDownload);
      });
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
        contents.on(event, (navigation, url) => {
          if (!isLocal(navigation.url ?? url)) navigation.preventDefault();
        });
      }
    },
    async dispose() {
      await isolate.clearStorageData();
    }
  };
}
