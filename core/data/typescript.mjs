import path from 'node:path';
import { visit } from '../discovery/project.mjs';
import { literal } from '../discovery/actions.mjs';

export function typeSchema(ts, checker, type, source, location, seen = new Set()) {
  const { TypeFlags: flags } = ts;
  const { isArrayType, isTupleType } = checker;
  const base = { sources: [{ kind: 'typescript', path: source }] };
  const unknown = code => ({ ...base, kind: 'unknown', diagnostics: [
    { code, message: checker.typeToString(type), path: source }
  ] });
  if (seen.has(type)) return unknown('recursive-type');
  const children = new Set(seen).add(type);
  const walk = (other, name = source) => typeSchema(ts, checker, other, name, location, children);
  if (type.isUnion()) {
    const optional = type.types.some(member => member.flags & flags.Undefined);
    const nullable = type.types.some(member => member.flags & flags.Null);
    const members = type.types.filter(member => !(member.flags & (flags.Null | flags.Undefined)));
    const leaves = members.map(member => walk(member));
    if (leaves.length === 1) return { ...leaves[0], optional, nullable };
    const kind = leaves[0]?.kind;
    if (leaves.length && leaves.every(member => member.kind === kind && member.enum)) {
      return { ...base, kind, optional, nullable,
        ...(kind === 'boolean' && leaves.length === 2 ? {} : { enum: leaves.flatMap(member => member.enum) }) };
    }
    return unknown('unsupported-union');
  }
  if (type.flags & flags.StringLike) return { ...base, kind: 'string', ...(type.isLiteral() ? { enum: [type.value] } : {}) };
  if (type.flags & flags.NumberLike) return { ...base, kind: 'number', ...(type.isLiteral() ? { enum: [type.value] } : {}) };
  if (type.flags & flags.BooleanLike) return { ...base, kind: 'boolean',
    ...(type.flags & flags.BooleanLiteral ? { enum: [checker.typeToString(type) === 'true'] } : {}) };
  if (isArrayType(type)) return { ...base, kind: 'array', items: walk(checker.getTypeArguments(type)[0], source + '[]') };
  if (type.flags & flags.Object && !isTupleType(type) &&
      !type.getCallSignatures().length && !type.getStringIndexType() &&
      (!type.symbol || !type.symbol.declarations?.some(def => def.getSourceFile().hasNoDefaultLib))) {
    const entries = type.getProperties().map(property => {
      const name = property.getName();
      const child = walk(checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? location), source + '.' + name);
      if (property.flags & ts.SymbolFlags.Optional) child.optional = true;
      return [name, child];
    });
    return { ...base, kind: 'object', fields: Object.fromEntries(entries) };
  }
  return unknown('unsupported-type');
}

export function discoverTypeSources(scan, root, nodeId, transports = []) {
  const { ts, routeRecords, sources } = scan;
  const route = routeRecords.find(entry => entry.node.id === nodeId);
  const model = { props: [], requests: [] };
  if (!route) return model;
  for (const definition of route.components.slice(1)) {
    const { checker } = sources.get(definition.getSourceFile().fileName);
    const from = path.relative(root, definition.getSourceFile().fileName);
    const component = ts.isVariableDeclaration(definition) ? definition.initializer : definition;
    const parameter = component?.parameters?.[0];
    if (parameter) model.props.push(typeSchema(ts, checker, checker.getTypeAtLocation(parameter), from, parameter));
  }
  const processed = new Set();
  for (const definition of route.components) {
    const { checker } = sources.get(definition.getSourceFile().fileName);
    const from = path.relative(root, definition.getSourceFile().fileName);
    visit(ts, definition, call => {
      if (!ts.isCallExpression(call) || processed.has(call)) return;
      processed.add(call);
      const name = call.expression.getText();
      const binding = transports.find(item => item.call === name);
      if (name !== 'fetch' && !binding) return;
      const requestPath = binding?.path ?? literal(ts, checker, call.arguments[0]);
      if (!requestPath) return;
      const method = binding?.method ?? 'GET';
      const result = binding && checker.getTypeAtLocation(call);
      const awaited = result && (checker.getAwaitedType(result) ?? result);
      model.requests.push({ method, path: requestPath, source: from,
        ...(awaited ? { schema: typeSchema(ts, checker, awaited, from + '#' + name, call) } : {}) });
    });
  }
  return model;
}
