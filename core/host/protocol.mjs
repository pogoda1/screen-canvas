import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { assertScenario, matchesStamp } from '../contracts.mjs';

export class DocumentProtocol {
  constructor(generation, sessionId, scenario, timeout = 4500) {
    this.generation = generation;
    this.sessionId = sessionId;
    this.scenario = assertScenario(scenario);
    this.revision = 0;
    this.timeout = timeout;
    this.requests = new Map();
  }

  newDocument() {
    this.invalidate();
    this.document = { id: randomUUID(), token: randomUUID(), issued: Date.now(), ready: false, ack: -1, queue: [] };
    return { stamp: this.stamp(), token: this.document.token, initial: this.scenario };
  }

  stamp() {
    return { generation: this.generation, sessionId: this.sessionId,
      documentId: this.document?.id ?? '', revision: this.revision };
  }

  invalidate(before = Infinity) {
    if (this.document && this.document.issued > before) return;
    this.document?.poll?.(null);
    this.document = undefined;
    for (const pending of this.requests.values()) pending(null);
    this.requests.clear();
  }

  close() {
    this.closed = true;
    this.invalidate();
  }

  async waitForCurrent() {
    const deadline = Date.now() + this.timeout;
    while (!this.closed && Date.now() < deadline) {
      if (this.document?.ack === this.revision) return this.document;
      await setTimeout(20);
    }
    throw new Error(this.closed ? 'Preview closed' : 'Timed out waiting for the current preview document');
  }

  schedule(command) {
    const doc = this.document;
    if (doc.poll) doc.poll(command);
    else doc.queue.push(command);
  }

  sendApply() {
    this.schedule({ ...this.stamp(), type: 'apply', scenario: this.scenario });
  }

  setScenario(scenario) {
    this.scenario = assertScenario(scenario);
    this.revision++;
    if (this.document?.ready) this.sendApply();
    return this.revision;
  }

  async read() {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      const document = await this.waitForCurrent();
      if (this.document !== document || document.ack !== this.revision) continue;
      const id = randomUUID();
      const stamp = this.stamp();
      const snapshot = await new Promise(resolve => {
        const timer = setTimeoutCallback(() => finish(null), Math.max(1, deadline - Date.now()));
        const finish = result => {
          clearTimeout(timer);
          this.requests.delete(id);
          resolve(result);
        };
        this.requests.set(id, finish);
        this.schedule({ ...stamp, type: 'read', requestId: id });
      });
      if (snapshot && this.document === document && matchesStamp(stamp, this.stamp())) return snapshot;
    }
    throw new Error('Timed out reading state from the current preview document');
  }

  async handle(message, token) {
    const doc = this.document;
    if (!doc || token !== doc.token || message.generation !== this.generation ||
        message.sessionId !== this.sessionId || message.documentId !== doc.id) {
      return { status: 409, body: { error: 'Stale preview document' } };
    }
    if (message.type === 'ready' && !doc.ready) {
      doc.ready = true;
      this.sendApply();
    } else if (message.type === 'poll' && doc.ready && !doc.poll) {
      const command = doc.queue.shift() ?? await new Promise(resolve => {
        const clear = result => {
          clearTimeout(timer);
          doc.poll = undefined;
          resolve(result);
        };
        const timer = setTimeoutCallback(() => clear(null), 900);
        doc.poll = clear;
      });
      return { status: 200, body: command };
    } else if (message.type === 'ack' && doc.ready && matchesStamp(message, this.stamp())) {
      if (message.error) return { status: 422, body: { error: 'Preview could not apply the scenario' } };
      doc.ack = message.revision;
    } else if (message.type === 'snapshot' && doc.ack === this.revision && matchesStamp(message, this.stamp())) {
      const complete = this.requests.get(message.requestId);
      if (!complete) return { status: 409, body: { error: 'Unknown read request' } };
      if (message.error) return { status: 422, body: { error: 'Preview could not read state' } };
      complete(assertScenario(message.scenario));
    } else return { status: 409, body: { error: 'Unexpected preview message' } };
    return { status: 200, body: null };
  }
}

const setTimeoutCallback = globalThis.setTimeout;
