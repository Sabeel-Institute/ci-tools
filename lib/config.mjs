import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as layout from './ports.mjs';

/**
 * An app repository's ci-tools.json: what differs between the apps, said once,
 * so no script asks which app it is in. Every key is declared in SCHEMA; an
 * unknown or misspelt key is an error rather than a silently ignored setting.
 */
export const CONFIG_FILE = 'ci-tools.json';

/** The nearest directory at or above `start` holding ci-tools.json. */
export function findRoot(start) {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(join(directory, CONFIG_FILE))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`no ${CONFIG_FILE} in ${resolve(start)} or above it; run this inside an app repository`);
    directory = parent;
  }
}

const string = (value) => typeof value === 'string' && value.length > 0;

/**
 * Each key's check. A nested object is a section; a function is a leaf, which
 * returns true, or false or the reason when the value is wrong. A key named in
 * REQUIRED must be present; a section named in ACROSS is also checked whole,
 * after its keys, by a function returning the problem or null.
 */
const SCHEMA = {
  name: string,
  // The emulator ports (lib/ports.mjs), project and runs.
  emulators: {
    base: layout.base,
    project: layout.project,
    // The app's own ports beyond the layout, as offsets from its base.
    extras: layout.extras,
    // A command every run with the Functions emulator goes through, taking that run as its arguments.
    functionsWrapper: layout.command,
  },
};
const REQUIRED = new Set(['name', 'emulators', 'emulators.base', 'emulators.project']);
const ACROSS = {
  emulators: layout.claim,
};

/** Whether `path` (dotted) names a setting SCHEMA declares. */
export function declared(path) {
  let node = SCHEMA;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object' || !(key in node)) return false;
    node = node[key];
  }
  return true;
}

export function validate(value, schema = SCHEMA, path = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${CONFIG_FILE}: ${path || 'the file'} must be an object`);
  for (const key of Object.keys(value)) {
    if (!(key in schema)) throw new Error(`${CONFIG_FILE}: unknown key ${path}${key}; the keys are ${Object.keys(schema).join(', ')}`);
  }
  for (const [key, check] of Object.entries(schema)) {
    const name = `${path}${key}`;
    if (!(key in value)) {
      if (REQUIRED.has(name)) throw new Error(`${CONFIG_FILE}: ${name} is required`);
      continue;
    }
    if (typeof check === 'function') {
      const verdict = check(value[key]);
      if (verdict !== true) throw new Error(`${CONFIG_FILE}: ${name} ${typeof verdict === 'string' ? verdict : `has an invalid value ${JSON.stringify(value[key])}`}`);
    } else {
      validate(value[key], check, `${name}.`);
    }
  }
  const problem = ACROSS[path.slice(0, -1)]?.(value);
  if (problem) throw new Error(`${CONFIG_FILE}: ${problem}`);
  return value;
}

/** The app's ci-tools.json, read from `root` (the working directory by default) and checked. */
export function config(root = process.cwd()) {
  const path = join(root, CONFIG_FILE);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${CONFIG_FILE}: cannot read ${path}: ${error.message}`);
  }
  return validate(parsed);
}
