import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { assertScenario } from './contracts.mjs';
import { validateValue } from './data/validate.mjs';

const pattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const variantsPath = ['screen-canvas', 'scenarios'];

class VariantError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function createVariantStore(root, getSchema) {
  const canonical = await realpath(root);
  async function directory(create) {
    let current = canonical;
    for (const segment of variantsPath) {
      current = path.join(current, segment);
      if (create) await mkdir(current).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const stat = await lstat(current).catch(error => {
        if (!create && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!stat) return undefined;
      if (!stat.isDirectory() || await realpath(current) !== current) {
        throw new VariantError('unsafe-path', 'Scenario directories must belong to the selected project');
      }
    }
    return current;
  }

  function check(value, id) {
    if (!value || value.version !== 1 || value.id !== id || !Number.isSafeInteger(value.revision) ||
        value.revision < 1 || cleanName(value.name) !== value.name) {
      throw new VariantError('incompatible-version', 'Unrecognized variant format');
    }
    assertScenario(value.scenario);
    rejectPrivateFields(value.scenario.data);
    if (value.scenario.draft) rejectPrivateFields(value.scenario.draft);
    return value;
  }

  async function inspect(dir, id) {
    let file;
    try {
      file = await open(path.join(dir, id + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_048_576) throw new VariantError('unsafe-file', 'Invalid scenario file');
      const value = check(JSON.parse(await file.readFile('utf8')), id);
      const schema = await getSchema(value.scenario.nodeId);
      if (schema === undefined) return { id, value, status: 'orphaned' };
      const errors = schema ? validateValue(schema, value.scenario.data, '$', true) : [];
      return errors.length ? { id, value, status: 'incompatible', errors } : { id, value, status: 'ready' };
    } catch (error) {
      if (error.code === 'ENOENT') return { id, status: 'missing' };
      return { id, status: error.code === 'incompatible-version' ? 'incompatible' : 'corrupt',
        errors: [{ code: error.code ?? 'invalid-json', message: error.message }] };
    } finally {
      await file?.close();
    }
  }

  async function entries(dir) {
    if (!dir) return [];
    const names = await readdir(dir);
    return Promise.all(names.filter(name => name.endsWith('.json') && pattern.test(name.slice(0, -5)))
      .sort().map(name => inspect(dir, name.slice(0, -5))));
  }

  async function save({ id, name, revision, scenario }) {
    const label = cleanName(name);
    if (id !== undefined && !pattern.test(id)) throw new VariantError('id', 'Invalid variant ID');
    const dir = await directory(true);
    const lockPath = path.join(dir, '.write-lock');
    const lock = await acquire(lockPath);
    let temporary;
    try {
      const schema = await getSchema(assertScenario(scenario).nodeId);
      if (schema === undefined) throw new VariantError('orphaned', 'Screen is absent from the current graph');
      if (schema) {
        const errors = validateValue(schema, scenario.data, '$', true);
        if (errors.length) throw new VariantError('incompatible', errors.map(error => error.path + ' ' + error.message).join(', '));
      }
      const existing = id === undefined ? undefined : await inspect(dir, id);
      if (existing && (existing.status !== 'ready' || existing.value.revision !== revision ||
          existing.value.scenario.nodeId !== scenario.nodeId)) {
        throw new VariantError('revision-conflict', 'Variant changed or belongs to a different screen');
      }
      if ((await entries(dir)).some(entry => entry.id !== id && entry.value?.name === label)) {
        throw new VariantError('name-conflict', 'A variant with that name already exists');
      }
      const fileId = id ?? randomUUID();
      const value = check({ version: 1, id: fileId, name: label,
        revision: (existing?.value.revision ?? 0) + 1, scenario }, fileId);
      const buffer = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      if (buffer.length > 1_048_576) throw new VariantError('too-large', 'Scenario exceeds 1 MiB');
      temporary = path.join(dir, '.' + randomUUID() + '.tmp');
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(buffer);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await directory(false);
      await rename(temporary, path.join(dir, fileId + '.json'));
      temporary = undefined;
      return value;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(lockPath);
    }
  }

  return {
    list: async () => entries(await directory(false)),
    async read(id) {
      if (!pattern.test(id)) throw new VariantError('id', 'Invalid variant ID');
      const dir = await directory(false);
      return dir ? inspect(dir, id) : { id, status: 'missing' };
    },
    create: ({ name, scenario }) => save({ name, scenario }),
    update: details => {
      if (!pattern.test(details.id)) throw new VariantError('id', 'Invalid variant ID');
      return save(details);
    }
  };
}

function cleanName(name) {
  if (typeof name !== 'string') throw new VariantError('name', 'Enter a variant name');
  const cleaned = name.trim().normalize('NFC');
  if (!cleaned || cleaned.length > 120 || /[\p{Cc}]/u.test(cleaned)) {
    throw new VariantError('name', 'Enter a name of 1 to 120 characters');
  }
  return cleaned;
}

function rejectPrivateFields(data) {
  if (!data || typeof data !== 'object') return;
  for (const [key, value] of Object.entries(data)) {
    if (/^(?:authorization|headers|token|access.?token|refresh.?token|cookie|cookies|localStorage|sessionStorage|storage)$/i.test(key)) {
      throw new VariantError('private-data', 'Session credentials and storage cannot be written to a scenario');
    }
    rejectPrivateFields(value);
  }
}

async function acquire(lockPath) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await setTimeout(20);
    }
  }
  throw new VariantError('busy', 'Could not acquire the scenario write lock');
}
