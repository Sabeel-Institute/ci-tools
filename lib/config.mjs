import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
const boolean = (value) => typeof value === 'boolean';

/**
 * Each key's check. A nested object is a section; a function is a leaf, and a
 * key named in REQUIRED must be present.
 */
const SCHEMA = {
  name: string,
  ios: {
    /** The app/.env.local variable carrying the native Sentry DSN, which Metro inlines. */
    sentryDsnVariable: (value) => typeof value === 'string' && /^EXPO_PUBLIC_[A-Z0-9_]+$/.test(value),
    /** The app plays on with the phone locked: expo-video must declare supportsBackgroundPlayback. */
    backgroundPlayback: boolean,
    /** `npm run release-notes -- <version>` must succeed before a release build. */
    releaseNotes: boolean,
    /** `npm run build-info` stamps the build; run immediately before a release build. */
    buildInfo: boolean,
  },
};
const REQUIRED = new Set(['name', 'ios', 'ios.sentryDsnVariable']);

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
      if (!check(value[key])) throw new Error(`${CONFIG_FILE}: ${name} has an invalid value ${JSON.stringify(value[key])}`);
    } else {
      validate(value[key], check, `${name}.`);
    }
  }
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
