(() => {
  const { stamp, token, initial, browser } = globalThis.__screenCanvasBoot;
  delete globalThis.__screenCanvasBoot;
  const bindings = new Set();
  let scenario = initial;
  let revision = stamp.revision;
  let running = true;
  const url = '/__screen_canvas/session';
  const bridge = {
    get initial() { return scenario; },
    register(binding) {
      bindings.add(binding);
      return () => bindings.delete(binding);
    }
  };
  Object.defineProperty(globalThis, Symbol.for('react-screen-canvas.browser'), { value: bridge });
  const send = (type, payload) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-screen-canvas-document': token },
    body: JSON.stringify({ ...stamp, revision, type, ...payload })
  });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const domReady = () => Boolean(document.body?.innerText.trim() || document.body?.querySelector('input, img, canvas, video'));
  const hook = async (name, input) => {
    let result = input;
    for (const binding of bindings) {
      if (binding[name]) result = (await binding[name](result)) ?? result;
    }
    return result;
  };

  Object.defineProperty(globalThis, '__screenCanvasStatus', {
    value: async () => ({
      ready: Boolean(await hook('ready', domReady())),
      nodeId: await hook('identify'),
      applied: revision
    })
  });

  async function loop() {
    while (running && !(await hook('ready', domReady()))) await delay(30);
    if (!running || !(await send('ready')).ok) return;
    while (running) {
      const response = await send('poll');
      if (!response.ok) return;
      const command = await response.json();
      if (!command) continue;
      revision = command.revision;
      if (command.type === 'apply') {
        scenario = command.scenario;
        try { await hook('apply', scenario); await send('ack'); }
        catch { await send('ack', { error: true }); }
      } else if (command.type === 'read') {
        try {
          const snapshot = await hook('read', scenario);
          await send('snapshot', { requestId: command.requestId, scenario: snapshot });
        } catch { await send('snapshot', { requestId: command.requestId, error: true }); }
      }
    }
  }

  globalThis.__screenCanvasStart = async entrypoints => {
    delete globalThis.__screenCanvasStart;
    try {
      if (browser) await import(browser);
      for (const entry of entrypoints) await entry();
      await loop();
    } catch (error) {
      if (running) console.error('Screen Canvas preview:', error);
    }
  };
  addEventListener('pagehide', () => { running = false; }, { once: true });
})();
