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
const npmScripts = (value) => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
  && value.every((name) => typeof name === 'string' && /^[a-z0-9:-]+$/.test(name));
const secretPlaceholders = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([name, placeholder]) => /^[A-Z][A-Z0-9_]*$/.test(name) && typeof placeholder === 'string' && /^[A-Za-z0-9._-]+$/.test(placeholder));

/**
 * Each key's check. A nested object is a section; a function is a leaf, and a
 * key named in REQUIRED must be present.
 */
const SCHEMA = {
  name: string,
  ci: {
    /** The npm scripts the browser job runs, one per matrix entry; `test:screens` among them. */
    browserSuites: (value) => npmScripts(value) && value.includes('test:screens'),
    /** functions/.secret.local for the emulators: each secret the functions bind, with a placeholder. */
    emulatorSecrets: secretPlaceholders,
    /** `npm run knip` in the quality job. */
    knip: boolean,
    /** ffmpeg on the quality, integration and browser runners. */
    ffmpeg: boolean,
    /** SeaweedFS on the integration and browser runners, standing in for the media bucket. */
    mediaStore: boolean,
  },
  // The release builds (scripts/build-aab.mjs, scripts/build-web.mjs).
  build: {
    // The variable in app/.env.local that carries the native Sentry DSN, as the
    // app's own Sentry setup reads it. A release built without it reports no
    // crashes and looks no different.
    sentryDsnVariable: (value) => typeof value === 'string' && /^EXPO_PUBLIC_[A-Z0-9_]+$/.test(value),
  },
  ios: {
    /** The app plays on with the phone locked: expo-video must declare supportsBackgroundPlayback. */
    backgroundPlayback: boolean,
  },
};
const REQUIRED = new Set(['name', 'ci', 'ci.browserSuites', 'ci.emulatorSecrets', 'build', 'build.sentryDsnVariable']);

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
