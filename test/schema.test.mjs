import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { typeSchema } from '../core/data/typescript.mjs';
import { openApiOperations } from '../core/data/openapi.mjs';
import { bindSchema, mergeSchemas } from '../core/data/bindings.mjs';

test('combines compiler-derived props with JSON-schema limits and source paths', () => {
  const file = path.resolve('virtual.ts');
  const options = { strict: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, ...args) => name === file ?
    ts.createSourceFile(file, 'interface Props { name: string; flag?: boolean; next?: Props }', ts.ScriptTarget.Latest, true) :
    getSourceFile(name, ...args);
  const program = ts.createProgram([file], options, host);
  const checker = program.getTypeChecker();
  const node = program.getSourceFile(file).statements[0];
  const props = typeSchema(ts, checker, checker.getTypeAtLocation(node), 'virtual.ts', node);
  assert.equal(props.fields.flag.optional, true);
  assert.equal(props.fields.next.diagnostics[0].code, 'recursive-type');
  const operations = openApiOperations({
    paths: { '/api/{id}': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } } } } } },
    components: { schemas: { Product: { type: 'object', required: ['name'], properties: {
      name: { type: 'string', maxLength: 5 }
    } } } }
  });
  const combined = bindSchema(mergeSchemas(props, operations.get('GET /api/:id')), {
    '$.name': { kind: 'api', key: 'product' }
  });
  assert.equal(combined.fields.name.maxLength, 5);
  assert.deepEqual(combined.fields.name.sources.map(item => item.kind), ['typescript', 'openapi']);
  assert.equal(combined.fields.flag.binding, undefined);
  assert.equal(mergeSchemas(props.fields.flag, combined.fields.name).diagnostics[0].code, 'schema-conflict');
});
