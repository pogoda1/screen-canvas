import { defineAdapter } from 'react-screen-canvas';

const request = 'GET /api/products/:id';
const record = { id: 'field-notes', title: 'Field Notes', stock: 0, tags: ['Paper'] };

export default defineAdapter({
  browser: '/src/canvas-browser.ts',
  bindings: { '$.eyebrow': { kind: 'state', key: 'catalog:caption' } },
  scenario(node) {
    if (!node.path.includes(':id')) return {};
    return {
      data: { eyebrow: 'Field supplies', [request]: record },
      entities: [{ param: 'id', field: [request, 'id'] }]
    };
  },
  createMocks() {
    return ({ method, path, scenario }) => {
      if (method !== 'GET' || !path.startsWith('/api/products/')) return undefined;
      const id = decodeURIComponent(path.slice('/api/products/'.length));
      const product = scenario.data[request] ?? { ...record, id };
      return product.id === id ? { body: product } : { status: 404, body: { error: 'Unknown product ID' } };
    };
  }
});
