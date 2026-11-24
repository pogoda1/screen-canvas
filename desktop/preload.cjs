const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (command, generation, args) => {
  const reply = await ipcRenderer.invoke('canvas:command', { command, ...(generation === undefined ? {} : { generation }), ...(args === undefined ? {} : { args }) });
  if (reply.error) throw new Error(reply.error.message);
  return reply.value;
};

contextBridge.exposeInMainWorld('screenCanvas', Object.freeze({
  state: () => invoke('state'),
  choose: () => invoke('choose'),
  retry: generation => invoke('retry', generation),
  close: generation => invoke('close', generation),
  open: (generation, nodeId, variantId) => invoke('open', generation, { nodeId, ...(variantId ? { variantId } : {}) }),
  bounds: (generation, rect) => invoke('bounds', generation, rect),
  patch: (generation, id, edits) => invoke('patch', generation, { id, edits }),
  read: (generation, id) => invoke('read', generation, { id }),
  requests: (generation, id) => invoke('requests', generation, { id }),
  loading: (generation, id, value) => invoke('loading', generation, { id, value }),
  rebuild: generation => invoke('rebuild', generation),
  cancelScan: generation => invoke('cancel-scan', generation),
  variants: generation => invoke('variants', generation),
  save: (generation, id, name, update) => invoke('save', generation, { id, name, ...(update ? { variantId: update.id, revision: update.revision } : {}) }),

}));
