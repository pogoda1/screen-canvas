import path from 'node:path';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { discoverRoutes } from './router.mjs';

export function visit(ts, node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(ts, child, callback));
}

export function declaration(ts, checker, node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

export async function scanProject(root, tsconfig = 'tsconfig.json') {
  const canonical = await realpath(root);
  const require = createRequire(path.join(canonical, 'package.json'));
  const ts = require('typescript');
  const configs = new Set();
  const sources = new Map();
  const programs = [];
  function collect(filename) {
    if (configs.has(filename)) return;
    configs.add(filename);
    const config = ts.getParsedCommandLineOfConfigFile(filename, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
      }
    });
    const errors = config.errors.filter(error => error.code !== 18003);
    if (errors.length) throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, ' '));
    for (const ref of config.projectReferences ?? []) collect(ts.resolveProjectReferencePath(ref));
    const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
    programs.push(program);
    for (const file of program.getSourceFiles()) {
      const local = path.relative(canonical, file.fileName);
      if (file.isDeclarationFile || local.startsWith('..') || path.isAbsolute(local) ||
          local.split(path.sep).includes('node_modules')) continue;
      if (!sources.has(file.fileName)) sources.set(file.fileName, { file, checker: program.getTypeChecker() });
    }
  }
  collect(path.resolve(canonical, tsconfig));
  return { ...discoverRoutes(ts, canonical, sources), ts, sources, programs };
}
