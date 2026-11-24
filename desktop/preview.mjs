import { WebContentsView } from 'electron';
import { clampBounds } from './bounds.mjs';
import { previewPolicy } from './session-policy.mjs';

export class PreviewController {
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  revision = 0;

  constructor(getWindow, onNavigate) {
    this.getWindow = getWindow;
    this.onNavigate = onNavigate;
  }

  resize(bounds = this.bounds) {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    const rect = clampBounds(bounds, window.getContentBounds());
    this.bounds = bounds;
    this.current?.view.setBounds(rect);
    this.current?.view.setVisible(rect.width > 0 && rect.height > 0);
  }

  async closeCurrent() {
    const previous = this.current;
    if (!previous) return;
    this.current = undefined;
    this.description = undefined;
    const { view, policy, worker, id, window } = previous;
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    await Promise.allSettled([worker.call('close', { id }), policy.dispose()]);
  }

  close() {
    this.revision++;
    return this.closeCurrent();
  }

  open(worker, nodeId, variantId) {
    const sequence = ++this.revision;
    const closing = this.closeCurrent();
    const older = this.opening;
    this.opening = Promise.allSettled([closing, older]).then(() =>
      this.openCurrent(worker, nodeId, variantId, sequence));
    return this.opening;
  }

  async openCurrent(worker, nodeId, variantId, sequence) {
    if (sequence !== this.revision) throw new Error('Preview selection was superseded');
    const session = await worker.call('open', { nodeId, ...(variantId ? { variantId } : {}) });
    const window = this.getWindow();
    if (!window || window.isDestroyed() || sequence !== this.revision) {
      await worker.call('close', { id: session.id }).catch(() => {});
      throw new Error('Preview selection was superseded');
    }

    const policy = previewPolicy(session.origin, session.navigationKey);
    const view = new WebContentsView({ webPreferences: policy.preferences });
    policy.attach(view.webContents);
    this.current = { ...session, nodeId, worker, view, policy, window, sequence };
    view.webContents.on('did-start-navigation', (event, url, inPlace, isMainFrame) => {
      if (!(event.isMainFrame ?? isMainFrame) || (event.isSameDocument ?? inPlace) ||
          new URL(event.url ?? url).origin !== session.origin) return;
      void worker.call('invalidate', { id: session.id, before: Date.now() }).catch(() => {});
    });
    const preview = this.current;
    const followNavigation = (_event, url, isMainFrame = true) => {
      if (!isMainFrame || new URL(url).pathname === new URL(preview.origin + preview.path).pathname) return;
      const follow = async () => {
        const description = await worker.call('describe', { id: preview.id });
        if (this.current !== preview || view.webContents.getURL() !== url) return;
        preview.path = new URL(url).pathname;
        preview.schema = description.schema;
        this.description = description;
        this.onNavigate();
      };
      preview.navigation = (preview.navigation ?? Promise.resolve()).catch(() => {}).then(follow);
      preview.navigation.catch(() => {});
    };
    view.webContents.on('did-navigate-in-page', followNavigation);
    view.webContents.on('did-navigate', (event, url) => followNavigation(event, url));
    view.webContents.once('render-process-gone', () => {
      if (this.current?.sequence === sequence) void this.close();
    });
    window.contentView.addChildView(view);
    this.resize();
    try { await view.webContents.loadURL(session.origin + session.path); }
    catch (error) {
      if (this.current?.sequence !== sequence) throw new Error('Preview selection was superseded');
      if (error.errno !== -3) {
        await this.closeCurrent();
        throw error;
      }
    }
    if (this.current?.sequence !== sequence) throw new Error('Preview selection was superseded');
    return { nodeId, id: session.id, scenario: session.scenario, schema: session.schema };
  }

  async dispatch(worker, id, operation, args) {
    const current = this.current;
    if (!current || current.worker !== worker || current.id !== id) throw new Error('Preview selection expired');
    if (operation === 'patch' || operation === 'save') await current.navigation;
    const result = await worker.call(operation, { ...args, id });
    if (current !== this.current) throw new Error('Preview selection expired');
    const needsReload = operation === 'patch' && result.reload ||
      operation === 'loading' && args.value && Object.values(current.schema?.fields ?? {})
        .some(field => field.binding?.kind === 'api');
    if (needsReload) {
      await worker.call('invalidate', { id });
      if (current === this.current) current.view.webContents.reload();
    }
    return result;
  }
}
