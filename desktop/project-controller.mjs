import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export class ProjectController {
  generation = 0;
  state = { status: 'idle', generation: 0 };
  selection = 0;

  constructor(fork, update) {
    this.fork = fork;
    this.update = update;
  }

  publish(status, extra = {}) {
    this.state = { status, generation: this.generation, ...extra };
    this.update(this.state);
  }

  async choose(directory, retry = false) {
    const selection = ++this.selection;
    const root = await realpath(directory);
    if (selection !== this.selection) return;
    if (!retry && this.current?.root === root) return;
    const generation = ++this.generation;
    const previous = this.current;
    this.current = undefined;
    this.root = root;
    this.publish('starting', { name: root.split('/').at(-1) });
    if (previous) this.stopping = previous.stop();
    await this.stopping;
    if (selection !== this.selection || this.generation !== generation) return;
    let worker;
    try {
      const name = root.split('/').at(-1);
      worker = new ProjectWorker(this.fork(root), generation, () => {
        if (this.current !== worker) return;
        this.current = undefined;
        this.publish('error', { name, error: 'Project worker exited. Retry to start a new preview.' });
      });
      worker.root = root;
      this.current = worker;
      this.publish('scanning', { name });
      const graph = await worker.call('start', undefined, 25_000);
      if (this.current === worker) this.publish('ready', { name, graph });
    } catch (error) {
      if (this.generation !== generation || (worker && this.current !== worker)) return;
      this.current = undefined;
      this.publish('error', { name: root.split('/').at(-1), error: error.message });
      if (worker) this.stopping = worker.stop();
      await this.stopping;
    }
  }

  async close() {
    this.selection++;
    this.generation++;
    const worker = this.current;
    this.current = undefined;
    this.root = undefined;
    this.publish('idle');
    if (worker) this.stopping = worker.stop();
    await this.stopping;
  }

  retry() {
    if (this.root) return this.choose(this.root, true);
  }
}

export class ProjectWorker {
  pending = new Map();
  serial = 0;
  exited = false;

  constructor(child, generation, onExit) {
    this.child = child;
    this.generation = generation;
    this.exit = new Promise(resolve => child.once('exit', () => {
      this.exited = true;
      for (const request of this.pending.values()) request.reject(new Error('Project worker exited'));
      resolve();
      onExit();
    }));
    child.on('message', message => {
      if (message?.generation !== generation) return;
      const request = this.pending.get(message.id);
      if (!request) {
        if (message.operation === 'open' && typeof message.value?.id === 'string') {
          this.call('close', { id: message.value.id }).catch(() => {});
        }
        return;
      }
      if (message.error) {
        request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      } else request.resolve(message.value);
    });
  }

  call(operation, args, timeout = 10_000) {
    if (this.exited) return Promise.reject(new Error('Project worker exited'));
    const id = ++this.serial;
    const envelope = { id, generation: this.generation, operation, ...(args ? { args } : {}) };
    return new Promise((resolve, reject) => {
      const finish = callback => value => {
        clearTimeout(timer);
        this.pending.delete(id);
        callback(value);
      };
      const onError = finish(reject);
      const timer = setTimeout(() => {
        onError(new Error('Timed out during ' + operation));
        if (operation === 'open' && !this.exited) {
          try {
            this.child.postMessage({ id: ++this.serial, generation: this.generation,
              operation: 'cancel-open', args: { requestId: id } });
          } catch {}
        }
      }, timeout);
      this.pending.set(id, { resolve: finish(resolve), reject: onError });
      try { this.child.postMessage(envelope); }
      catch (error) { onError(error); }
    });
  }

  stop() {
    this.stopping ??= this.stopOwnedWorker();
    return this.stopping;
  }

  async stopOwnedWorker() {
    if (this.exited) return;
    this.call('shutdown', undefined, 3000).catch(() => {});
    await Promise.race([this.exit, delay(3000, undefined, { ref: false })]);
    if (!this.exited) {
      this.child.kill();
      await Promise.race([this.exit, delay(1000, undefined, { ref: false })]);
    }
  }
}
