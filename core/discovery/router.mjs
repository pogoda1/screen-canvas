import path from 'node:path';
import { declaration, visit } from './project.mjs';
import { attr, extractActions, literal, normalizeRoute, opening, routeMatches, routerImport, value } from './actions.mjs';

function sourceLocation(root, node) {
  const file = node.getSourceFile();
  return path.relative(root, file.fileName) + ':' + (file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
}

function localComponents(ts, syntax, sources, seen) {
  const components = [];
  const { checker } = sources.get(syntax.getSourceFile().fileName) ?? {};
  if (!checker || seen.has(syntax)) return components;
  seen.add(syntax);
  visit(ts, syntax, node => {
    if (!opening(ts, node)) return;
    const def = declaration(ts, checker, node.tagName);
    if (!def || !sources.has(def.getSourceFile().fileName)) return;
    components.push(def);
    if (!ts.isVariableDeclaration(def) || !def.initializer) return;
    visit(ts, def.initializer, call => {
      if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
      const mod = call.arguments[0] && checker.getSymbolAtLocation(call.arguments[0]);
      const exported = mod && checker.getExportsOfModule(mod);
      const file = mod?.declarations?.find(ts.isSourceFile);
      if (!file || !sources.has(file.fileName)) return;
      const member = exported.find(symbol => symbol.name === 'default');
      if (member) {
        const resolved = member.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(member) : member;
        const target = resolved.valueDeclaration ?? resolved.declarations?.[0];
        if (target) components.push(target);
      }
    });
  });
  return components.flatMap(component => seen.has(component) ? [] :
    [component, ...localComponents(ts, component, sources, seen)]);
}

export function discoverRoutes(ts, root, sources) {
  const records = [];
  const routeElements = new Map();
  const diagnostics = [];
  for (const { file, checker } of sources.values()) {
    visit(ts, file, syntax => {
      if (!opening(ts, syntax) || !routerImport(ts, checker, syntax.tagName, 'Route')) return;
      let parent;
      let inRoutes = false;
      for (let cursor = syntax.parent; cursor; cursor = cursor.parent) {
        if (!ts.isJsxElement(cursor) || cursor.openingElement === syntax) continue;
        if (routerImport(ts, checker, cursor.openingElement.tagName, 'Routes')) {
          inRoutes = true;
          break;
        }
        parent ??= routeElements.get(cursor.openingElement);
      }
      if (!inRoutes) return;
      const routeAttr = attr(ts, syntax, 'path');
      const segment = literal(ts, checker, value(ts, routeAttr?.initializer));
      const source = sourceLocation(root, syntax);
      if (routeAttr && segment === undefined) {
        diagnostics.push({ code: 'route-path', message: 'Route path is not statically defined', path: source });
        return;
      }
      const routePath = normalizeRoute(parent?.path ?? '/', segment ?? '', true);
      const index = Boolean(attr(ts, syntax, 'index'));
      const prefix = 'route:' + routePath;
      const id = index ? prefix + '#index' : segment === undefined ? prefix + '#layout:' + source : prefix;
      const node = { id, path: routePath, label: index ? 'Index' : segment ?? 'Layout', source, diagnostics: [] };
      if (index) node.index = true;
      if (parent) node.parentId = parent.id;
      if (records.some(record => record.node.id === id)) {
        node.id += '#' + source;
        node.diagnostics.push({ code: 'duplicate-route', message: 'Several route declarations match this path' });
      }
      const element = value(ts, attr(ts, syntax, 'element')?.initializer);
      if (element && (opening(ts, element) || ts.isJsxElement(element))) {
        node.component = (element.openingElement ?? element).tagName.getText();
      }
      routeElements.set(syntax, node);
      records.push({ node, element });
    });
  }

  const owners = new Map();
  for (const record of records) {
    const { node, element } = record;
    record.components = element ? [element, ...localComponents(ts, element, sources, new Set())] : [];
    for (const component of new Set(record.components)) {
      if (!owners.has(component)) owners.set(component, new Set());
      owners.get(component).add(node.id);
    }
  }

  const edges = [];
  for (const { node, components } of records) {
    const knownActions = new Set();
    for (const component of components) {
      const { checker } = sources.get(component.getSourceFile().fileName);
      for (const action of extractActions(ts, checker, component)) {
        if (knownActions.has(action.node)) continue;
        knownActions.add(action.node);
        const source = sourceLocation(root, action.node);
        if (owners.get(component).size > 1 || action.to === undefined) {
          node.diagnostics.push({ code: 'action-ambiguous', message: 'Cannot determine action ownership or destination', path: source });
          continue;
        }
        const route = normalizeRoute(node.path, action.to);
        const external = !route.startsWith('/') || route.startsWith('//');
        const candidates = external ? [] : records.map(record => record.node)
          .filter(target => routeMatches(target.path, route))
          .sort((a, b) => rank(b, route) - rank(a, route));
        const target = external ? route : candidates[0]?.id;
        if (!target || (candidates[1] && rank(candidates[0], route) === rank(candidates[1], route))) {
          node.diagnostics.push({ code: 'action-target', message: 'No unique route matches ' + route, path: source });
          continue;
        }
        const edge = { id: node.id + '@' + source + ':' + action.node.getStart(),
          source: node.id, target, label: action.label || action.to, action: action.action,
          evidence: { status: 'static' } };
        if (action.condition) edge.condition = action.condition;
        edges.push(edge);
      }
    }
  }
  return { nodes: records.map(record => record.node), edges, diagnostics, routeRecords: records };
}

function rank(node, target) {
  return (node.path === target && !node.path.includes('*') ? 1000 : 0) +
    node.path.split('/').reduce((score, part) => score + (part === '*' ? -10 : part.startsWith(':') ? 1 : 10), 0) +
    (node.index ? 0.5 : 0);
}
