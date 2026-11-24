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
  const visible = element => element.getClientRects().length > 0 &&
    !element.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(element).visibility === 'visible';
  const loadingLabel = text => /^(?:loading|please wait)[\s.…]*$/i.test(text.trim());
  let renderError;
  addEventListener('error', event => {
    if (event instanceof ErrorEvent) renderError = { path: location.pathname, message: event.message || 'Uncaught renderer error' };
  });
  addEventListener('unhandledrejection', event => {
    renderError = { path: location.pathname, message: event.reason?.message || 'Unhandled renderer rejection' };
  });

  function belongsToIndex(element) {
    const key = Object.keys(element).find(property => property.startsWith('__reactFiber$'));
    for (let fiber = element[key]; fiber; fiber = fiber.return) {
      // React Router's nearest route provider describes the branch rendering this element.
      const context = fiber.memoizedProps?.value;
      if (Array.isArray(context?.matches) && typeof context.isDataRoute === 'boolean' &&
          Object.hasOwn(context, 'outlet')) return context.matches.at(-1)?.route?.index === true;
    }
    return false;
  }

  function inspectContent(index) {
    const body = document.body;
    if (!body) return { content: false, loading: false, mounted: false };
    const main = [...body.querySelectorAll('main,[role="main"]')].find(visible) ?? body;
    const explicitLoading = [...body.querySelectorAll('[data-screen-canvas-loading]')].some(visible);
    const indicator = '[aria-busy="true"],[role="status"],[role="progressbar"]';
    const isLoading = element => element.matches('[aria-busy="true"]') ||
      loadingLabel(element.getAttribute('aria-label') ?? element.textContent);
    let busy = Boolean(main.closest('[aria-busy="true"]')) ||
      [main, ...main.querySelectorAll(indicator)].some(element =>
        element.matches(indicator) && visible(element) && isLoading(element));
    let content = false;
    let mounted = false;
    const observe = element => {
      const region = element.closest(indicator);
      if (region && isLoading(region) || element.closest('[aria-busy="true"]')) return;
      content = true;
      if (index && !mounted) mounted = belongsToIndex(element);
    };
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const owner = text.parentElement;
      if (!text.textContent.trim() || owner.closest('script,style,noscript,template,[hidden],[aria-hidden="true"]') ||
          getComputedStyle(owner).visibility !== 'visible') continue;
      range.selectNodeContents(text);
      if (!range.getClientRects().length) continue;
      if (loadingLabel(text.textContent) && loadingLabel(owner.textContent)) busy = true;
      else observe(owner);
    }
    for (const element of main.querySelectorAll('input:not([type="hidden"]),textarea,select,img,svg,canvas,video')) {
      // A decorative image can accompany a loader without providing screen content.
      if (element.matches('img[alt]') && !element.getAttribute('alt').trim() ||
          element.matches('[role="presentation"],[role="none"]')) continue;
      if (visible(element)) observe(element);
    }
    return { content, loading: explicitLoading || (busy && !content), mounted };
  }
  const hook = async (name, input) => {
    let result = input;
    for (const binding of bindings) {
      if (binding[name]) result = (await binding[name](result)) ?? result;
    }
    return result;
  };

  async function status(index, forCapture = false) {
    const error = document.querySelector('[data-screen-canvas-error],vite-error-overlay');
    const failure = error?.textContent.trim().slice(0, 240) || (error && 'The application rendered an error screen') || (renderError?.path === location.pathname ? renderError.message : undefined);
    const { content, loading, mounted } = inspectContent(index);
    const ready = !failure && !loading && Boolean(await hook('ready', content));
    const nodeId = await hook('identify');
    const observed = { ready, ...(failure ? { failure } : {}), loading, nodeId,
      mounted: Boolean(ready && mounted), applied: revision, documentId: stamp.documentId };
    if (forCapture && ready) {
      try { observed.captureReady = Boolean(await hook('captureReady', true)); }
      catch { observed.captureError = true; }
    }
    return observed;
  }
  Object.defineProperty(globalThis, '__screenCanvasStatus', { value: status });
  if (browser) Object.defineProperty(globalThis, '__screenCanvasIdentity', {
    value: () => hook('identify')
  });

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
