import path from 'node:path';
import { createRequire } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function projectPath(root, relative, optional = false) {
  const requested = path.resolve(root, relative);
  let actual;
  try { actual = await realpath(requested); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!actual.startsWith(root + path.sep) || !(await lstat(actual)).isFile()) {
    throw new HostError('project-path', 'Use a file inside the selected project: ' + relative);
  }
  return actual;
}

export async function detectProject(directory) {
  const root = await realpath(directory);
  let manifest;
  try { manifest = JSON.parse(await readFile(await projectPath(root, 'package.json'), 'utf8')); }
  catch { throw new HostError('manifest', 'Select a project with a valid package.json'); }
  const require = createRequire(path.join(root, 'package.json'));
  const resolve = name => {
    try { return require.resolve(name); }
    catch { throw new HostError('dependencies', 'Install the selected project dependencies, including ' + name); }
  };
  const config = await projectPath(root, 'screen-canvas.config.mjs', true);
  let adapter = {};
  if (config) {
    try { adapter = (await import(pathToFileURL(config))).default; }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
        throw new HostError('adapter-dependency', 'Install the adapter dependencies with the project package manager. ' + error.message);
      }
      throw error;
    }
    if (!adapter || typeof adapter !== 'object') throw new HostError('adapter', 'Export an adapter object as default');
  }
  const dev = adapter.createHost ? {} : parseViteScript(manifest.scripts?.dev);
  let vitePath;
  if (!adapter.createHost) {
    const version = require(resolve('vite/package.json')).version;
    if (!/^5\.4\./.test(version)) throw new HostError('vite-version', 'Use Vite 5.4 or configure a host driver');
    const pkg = require(resolve('vite/package.json'));
    vitePath = path.resolve(path.dirname(resolve('vite/package.json')), pkg.exports['.'].import.default ?? pkg.exports['.'].import);
  }
  resolve('typescript');
  const tsconfig = adapter.tsconfig ?? 'tsconfig.json';
  try { await projectPath(root, tsconfig); }
  catch { throw new HostError('tsconfig', 'Add a tsconfig.json or set tsconfig in the adapter'); }
  return { root, manifest, adapter, dev, vitePath, tsconfig };
}

function parseViteScript(script) {
  if (typeof script !== 'string') throw new HostError('dev-script', 'Add a Vite dev script or configure a host driver');
  const [command, ...args] = script.trim().split(/\s+/);
  const unsupported = () => new HostError('dev-script', 'Use a standard Vite dev script or configure a host driver');
  if (command !== 'vite') throw unsupported();
  const options = {};
  if (args[0] === 'dev' || args[0] === 'serve') args.shift();
  while (args.length) {
    const [flag, inline] = args.shift().split('=');
    if (!['--host', '--port', '--strictPort', '--mode', '--config', '-c', '--open'].includes(flag)) throw unsupported();
    const required = ['--port', '--mode', '--config', '-c'].includes(flag);
    const optional = ['--host', '--open'].includes(flag);
    const argument = inline ?? ((required || optional) && args[0] && !args[0].startsWith('-') ? args.shift() : undefined);
    if (required && (!argument || !/^[\w./-]+$/.test(argument))) throw unsupported();
    if (argument && !/^[\w./:[\]-]+$/.test(argument)) throw unsupported();
    if (flag === '--mode') options.mode = argument;
    if (flag === '--config' || flag === '-c') options.configFile = argument;
  }
  return options;
}
