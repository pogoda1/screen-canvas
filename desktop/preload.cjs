const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (command, generation) => {
  const reply = await ipcRenderer.invoke('canvas:command', { command, ...(generation === undefined ? {} : { generation }) });
  if (reply.error) throw new Error(reply.error.message);
  return reply.value;
};

contextBridge.exposeInMainWorld('screenCanvas', Object.freeze({
  state: () => invoke('state'),
  choose: () => invoke('choose'),
  retry: generation => invoke('retry', generation),
  close: generation => invoke('close', generation),
}));
