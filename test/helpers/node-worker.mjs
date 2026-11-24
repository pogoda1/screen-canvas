import { attachWorker } from '../../desktop/worker/entry.mjs';
attachWorker({
  on: process.on.bind(process),
  send(value) { if (process.connected) process.send(value); },
  exit: () => setImmediate(() => process.exit(0))
});
