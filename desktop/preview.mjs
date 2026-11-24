import { WebContentsView } from 'electron';
import { clampBounds } from './bounds.mjs';
import { previewPolicy } from './session-policy.mjs';

export class PreviewController {
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  revision = 0;

  constructor(getWindow) {
    this.getWindow = getWindow;
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

    const policy = previewPolicy(session.origin);
    const view = new WebContentsView({ webPreferences: policy.preferences });
    policy.attach(view.webContents);
    this.current = { ...session, nodeId, worker, view, policy, window, sequence };
    view.webContents.on('did-start-navigation', (event, url, inPlace, isMainFrame) => {
      if (!(event.isMainFrame ?? isMainFrame) || (event.isSameDocument ?? inPlace)) return;
      void worker.call('invalidate', { id: session.id, before: Date.now() }).catch(() => {});
    });
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
    const result = await worker.call(operation, { ...args, id });
    if (current !== this.current) throw new Error('Preview selection expired');
    if (operation === 'patch' && result.reload) {
      await worker.call('invalidate', { id });
      current.view.webContents.reload();
    }
    return result;
  }
}
