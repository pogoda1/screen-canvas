import { registerBrowserBindings } from 'react-screen-canvas/browser';

registerBrowserBindings({
  ready() {
    return Boolean(document.querySelector('h1, [role="alert"]'));
  },
  apply(scenario) {
    if (typeof scenario.data.eyebrow === 'string') {
      window.dispatchEvent(new CustomEvent('catalog:caption', { detail: scenario.data.eyebrow }));
    }
  }
});
