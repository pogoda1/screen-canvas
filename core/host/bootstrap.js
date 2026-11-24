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
  const visible = element => element.getClientRects().length > 0 && !element.closest('[hidden],[aria-hidden="true"]');
  const content = () => Array.from(document.body?.querySelectorAll('h1,h2,p,button,a,input,img,canvas,video,div,span') ?? [])
    .filter(element => visible(element) && (element.matches('input,img,canvas,video') ||
      (!element.children.length && element.textContent.trim())));
  const domReady = () => content().length > 0;
  let renderError;
  addEventListener('error', event => {
    if (event instanceof ErrorEvent) renderError = { path: location.pathname, message: event.message || 'Uncaught renderer error' };
  });
  addEventListener('unhandledrejection', event => {
    renderError = { path: location.pathname, message: event.reason?.message || 'Unhandled renderer rejection' };
  });

  function mounted(hint) {
    if (hint?.tag && /^[a-z][a-z0-9-]*$/.test(hint.tag)) {
      return Array.from(document.querySelectorAll(hint.tag)).some(element =>
        visible(element) && element.textContent.replace(/\s+/g, ' ').trim() === hint.text);
    }
    if (!hint?.component) return false;
    return content().some(element => {
      const key = Object.keys(element).find(property => property.startsWith('__reactFiber$'));
      for (let fiber = element[key]; fiber; fiber = fiber.return) {
        if (fiber.type?.name === hint.component || fiber.type?.displayName === hint.component) return true;
      }
      return false;
    });
  }
  const hook = async (name, input) => {
    let result = input;
    for (const binding of bindings) {
      if (binding[name]) result = (await binding[name](result)) ?? result;
    }
    return result;
  };

  async function status(hint) {
    const error = document.querySelector('[data-screen-canvas-error],vite-error-overlay');
    const failure = error?.textContent.trim().slice(0, 240) || (error && 'The application rendered an error screen') || (renderError?.path === location.pathname ? renderError.message : undefined);
    const loading = Boolean(document.querySelector('[data-screen-canvas-loading]'));
    const ready = !failure && !loading && Boolean(await hook('ready', domReady()));
    return { ready, ...(failure ? { failure } : {}), loading, nodeId: await hook('identify'),
      mounted: Boolean(ready && mounted(hint)), applied: revision };
  }
  Object.defineProperty(globalThis, '__screenCanvasStatus', { value: status });

  async function loop() {
    while (running && !(await status()).ready) await delay(30);
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
          await send('snapshot', { requestId: command.requestId, scenario: snapshot, pathname: location.pathname, nodeId: await hook('identify') });
        } catch (error) {
          await send('snapshot', { requestId: command.requestId, error: error?.message || 'Could not read preview' });
        }
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
