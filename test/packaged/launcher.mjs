import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const within = (filename, directory) => filename === directory || filename.startsWith(directory + path.sep);

export async function preparePackagedLaunch(t, app, project, denied = []) {
  const canonicalApp = await realpath(app);
  const canonicalProject = await realpath(project);
  const executable = path.join(canonicalApp, 'Contents', 'MacOS', 'Screen Canvas');
  await access(executable);
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'screen-canvas-packaged-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const roots = await Promise.all(denied.map(directory => realpath(directory)));
  if (roots.some(root => [canonicalApp, canonicalProject, cwd].some(value => within(value, root)))) {
    throw new Error('Copy the app and project outside the denied source trees');
  }
  const options = { executablePath: executable, cwd };
  if (!roots.length) return { options, executable, project: canonicalProject };

  const controls = roots.map(root => path.join(root, 'package.json'));
  await Promise.all(controls.map(file => access(file)));
  const profile = path.join(cwd, 'profile.sb');
  const launcher = path.join(cwd, 'launch-app');
  const probe = path.join(cwd, 'exec-app');
  const trace = path.join(cwd, 'read-boundary');
  const packageFile = path.join(canonicalProject, 'package.json');
  await writeFile(profile, '(version 1)\n(allow default)\n' +
    roots.map(root => '(deny file-read* (subpath ' + JSON.stringify(root) + '))').join('\n') + '\n');
  await writeFile(probe, [
    '#!/bin/sh',
    '/usr/bin/head -c 1 ' + quote(packageFile) + ' >/dev/null 2>&1 || exit 91',
    ...controls.map(file => 'if /usr/bin/head -c 1 ' + quote(file) + ' >/dev/null 2>&1; then exit 92; fi'),
    'printf "%s\\n" ' + quote('deny-controls=' + controls.length + ' allow-project=1') + ' > ' + quote(trace),
    'exec ' + quote(executable) + ' "$@"', ''
  ].join('\n'), { mode: 0o700 });
  await writeFile(launcher, '#!/bin/sh\nexec /usr/bin/sandbox-exec -f ' + quote(profile) + ' ' + quote(probe) + ' "$@"\n',
    { mode: 0o700 });
  return { options: { ...options, executablePath: launcher }, executable, project: canonicalProject, trace };
}
