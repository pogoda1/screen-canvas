const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (command, generation, args) => {
  const reply = await ipcRenderer.invoke('canvas:command', { command, ...(generation === undefined ? {} : { generation }), ...(args === undefined ? {} : { args }) });
  if (reply.error) throw new Error(reply.error.message);
  return reply.value;
};

contextBridge.exposeInMainWorld('screenCanvas', Object.freeze({
  state: version => invoke('state', undefined, version === undefined ? undefined : { version }),
  choose: () => invoke('choose'),
  retry: generation => invoke('retry', generation),
  close: generation => invoke('close', generation),
  open: (generation, nodeId, variantId) => invoke('open', generation, { nodeId, ...(variantId ? { variantId } : {}) }),
  bounds: (generation, rect) => invoke('bounds', generation, rect),
  patch: (generation, id, edits, screen) => invoke('patch', generation, { id, edits, ...(screen ? { screen } : {}) }),
  read: (generation, id) => invoke('read', generation, { id }),
  requests: (generation, id) => invoke('requests', generation, { id }),
  loading: (generation, id, value) => invoke('loading', generation, { id, value }),
  rebuild: generation => invoke('rebuild', generation),
  cancelScan: generation => invoke('cancel-scan', generation),
  variants: generation => invoke('variants', generation),
  save: (generation, id, name, update, requestId) => invoke('save', generation, {
    id, name, ...(requestId ? { requestId } : {}), ...(update ? { variantId: update.id, revision: update.revision } : {})
  }),
  cancelSave: (generation, id, requestId) => invoke('cancel-save', generation, { id, requestId }),

}));
