import assert from 'node:assert/strict';
import test from 'node:test';
import { makeScenario, scenarioUrl } from '../core/data/scenario.mjs';
import { validatePatch } from '../core/data/validate.mjs';

const field = (kind, extra) => ({ kind, sources: [], ...extra });
const schema = field('object', { fields: {
  id: field('string'),
  name: field('string', { maxLength: 10, binding: { kind: 'api', key: 'record' } }),
  count: field('number', { min: 0 }),
  active: field('boolean')
} });

test('uses a single stable ID and preserves false and zero from fixtures', () => {
  const node = { id: 'route:/things/:id', path: '/things/:id' };
  const options = { schema, seed: 2, fixture: { id: 'record-1', count: 0, active: false },
    entities: [{ param: 'id', field: ['id'] }] };
  const scenario = makeScenario(node, options);
  assert.deepEqual(scenario, makeScenario(node, options));
  assert.equal(scenarioUrl(node, scenario), '/things/record-1');
  assert.deepEqual(scenario.data, { id: 'record-1', name: 'Sample 2', count: 0, active: false });
  const edited = validatePatch(schema, scenario.data, [{ path: ['name'], value: 'Changed' }]);
  assert.equal(edited.value.name, 'Changed');
  assert.equal(validatePatch(schema, scenario.data, [
    { path: ['name'], value: 'Changed' }, { path: ['id'], value: 'Invalid' }
  ]).value, undefined);
  assert.equal(validatePatch(schema, scenario.data, [{ path: ['name'], value: 'Out of bounds' }]).errors[0].path, '$.name');
  assert.equal(scenario.data.name, 'Sample 2');
});

test('a linked ID is preserved when a bound parent object is patched', () => {
  const schema = field('object', { fields: {
    item: field('object', { binding: { kind: 'api', key: 'GET /api/items/:id' }, fields: {
      id: field('string', { readOnlyReason: 'Uses the route ID' }),
      name: field('string')
    } })
  } });
  const previous = { item: { id: 'one', name: 'Example' } };
  const direct = validatePatch(schema, previous, [{ path: ['item', 'id'], value: 'two' }]);
  assert.equal(direct.errors[0].code, 'read-only');
  const bypass = validatePatch(schema, previous, [{ path: ['item'], value: { id: 'two', name: 'Changed' } }]);
  assert.deepEqual(bypass.errors, [{ code: 'read-only', path: '$.item.id', message: 'Uses the route ID' }]);
  assert.ok(validatePatch(schema, previous, [{ path: ['item', 'name'], value: 'Changed' }]).value);
});
