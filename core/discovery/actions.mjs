import path from 'node:path';
import { declaration, visit } from './project.mjs';

export const opening = (ts, node) =>
  ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
export const attr = (ts, node, name) => node.attributes.properties.find(
  prop => ts.isJsxAttribute(prop) && prop.name.getText() === name
);
export const value = (ts, node) => node && (ts.isJsxExpression(node) ? node.expression : node);

export function literal(ts, checker, node, seen = new Set()) {
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(({ expression, literal: tail }) => {
      const resolved = literal(ts, checker, expression, new Set(seen));
      const name = expression.getText().split('.').at(-1);
      return (resolved ?? (/^[\w]+$/.test(name) ? ':' + name : ':value')) + tail.text;
    }).join('');
  }
  if (ts.isParenthesizedExpression(node)) return literal(ts, checker, node.expression, seen);
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const def = declaration(ts, checker, node);
    if (def && ts.isVariableDeclaration(def) && (def.parent.flags & ts.NodeFlags.Const)) {
      return literal(ts, checker, def.initializer, seen);
    }
  }
}

export function routerImport(ts, checker, node, name) {
  const leaf = ts.isPropertyAccessExpression(node) ? node.expression : node;
  const symbol = checker.getSymbolAtLocation(leaf);
  if (!symbol) return leaf.getText() === name;
  return symbol.declarations?.some(def => {
    const imported = ts.isImportSpecifier(def) ? (def.propertyName ?? def.name).text
      : ts.isNamespaceImport(def) && ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
    for (let cursor = def; cursor; cursor = cursor.parent) {
      if (ts.isImportDeclaration(cursor)) {
        return cursor.moduleSpecifier.text === 'react-router-dom' && imported === name;
      }
    }
    return false;
  });
}

function actionContext(ts, node) {
  let condition;
  let label;
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (!condition && (ts.isConditionalExpression(cursor) || ts.isIfStatement(cursor))) {
      const positive = cursor.whenTrue ?? cursor.thenStatement;
      const inPositive = node.pos >= positive.pos && node.end <= positive.end;
      condition = inPositive ? cursor.expression?.getText() ?? cursor.condition.getText()
        : '!' + (cursor.expression?.getText() ?? cursor.condition.getText());
    }
    if (!label && ts.isJsxElement(cursor)) {
      label = cursor.children.filter(ts.isJsxText).map(text => text.getText().trim()).filter(Boolean).join(' ');
    }
  }
  return { condition, label };
}

export function extractActions(ts, checker, root) {
  const actions = [];
  visit(ts, root, node => {
    if (opening(ts, node)) {
      const name = ['Link', 'NavLink', 'Navigate'].find(candidate => routerImport(ts, checker, node.tagName, candidate));
      if (!name) return;
      const context = actionContext(ts, node);
      actions.push({ node, to: literal(ts, checker, value(ts, attr(ts, node, 'to')?.initializer)),
        action: name === 'Navigate' ? 'redirect' : 'link', ...context });
    } else if (ts.isCallExpression(node)) {
      const def = declaration(ts, checker, node.expression);
      if (!def || !ts.isVariableDeclaration(def) || !def.initializer || !ts.isCallExpression(def.initializer) ||
          !routerImport(ts, checker, def.initializer.expression, 'useNavigate')) return;
      actions.push({ node, to: literal(ts, checker, node.arguments[0]), action: 'navigate', ...actionContext(ts, node) });
    }
  });
  return actions;
}

export function normalizeRoute(base, to, declaration = false) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(to)) return to;
  const target = (declaration ? to : to.split(/[?#]/)[0]) || base;
  return path.posix.normalize(target.startsWith('/') ? target : path.posix.join(base, target))
    .replace(/\/$/, '') || '/';
}

export function routeMatches(pattern, target) {
  const clauses = pattern.split('/').slice(1).map(segment => {
    if (segment === '*') return '(?:/.*)?';
    if (segment.startsWith(':')) return segment.endsWith('?') ? '(?:/[^/]+)?' : '/[^/]+';
    const optional = segment.endsWith('?');
    const escaped = (optional ? segment.slice(0, -1) : segment).replace(/[^\w-]/g, '\\$&');
    return optional ? '(?:/' + escaped + ')?' : '/' + escaped;
  });
  return new RegExp('^' + clauses.join('') + '/?$', 'i').test(target);
}
