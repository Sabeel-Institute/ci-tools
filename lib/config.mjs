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
const boolean = (value) => typeof value === 'boolean';
const npmScripts = (value) => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
  && value.every((name) => typeof name === 'string' && /^[a-z0-9:-]+$/.test(name));
const secretPlaceholders = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([name, placeholder]) => /^[A-Z][A-Z0-9_]*$/.test(name) && typeof placeholder === 'string' && /^[A-Za-z0-9._-]+$/.test(placeholder));

/**
 * Each key's check. A nested object is a section; a function is a leaf, which
 * returns true, or false or the reason when the value is wrong. A key named in
 * REQUIRED must be present; a section named in ACROSS is also checked whole,
 * after its keys, by a function returning the problem or null.
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
  // The emulator ports (lib/ports.mjs), project and runs.
  emulators: {
    base: layout.base,
    project: layout.project,
    // The app's own ports beyond the layout, as offsets from its base.
    extras: layout.extras,
    // A command every run with the Functions emulator goes through, taking that run as its arguments.
    functionsWrapper: layout.command,
  },
  // The native flows (scripts/native-e2e.sh, workflows/native.yml).
  native: {
    // The script that seeds the emulators for the flows, run with node from the app's root.
    seed: (value) => typeof value === 'string' && /^[\w./-]+\.m?js$/.test(value) && !value.split('/').includes('..'),
    // The seed drives the web app: a web dev server runs on the app's `web` port for it, its address in E2E_BASE.
    seedWeb: boolean,
    // Ports (layout or extras names) the app reaches on this machine's 127.0.0.1, which an Android emulator must be given.
    reversePorts: (value) => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
      && value.every((name) => typeof name === 'string' && /^[a-z][A-Za-z0-9]*$/.test(name)),
  },
  // Publishing (scripts/publish-play.mjs, scripts/release.mjs).
  release: {
    // The SHA-256 fingerprint of the certificate Google Play signs installed
    // APKs with (Play Console, App integrity, App signing key certificate), as
    // Play Console prints it: 32 colon-separated pairs of uppercase hex digits.
    // publish-play completes a release only when Play signs with it.
    appSigningCertificate: (value) => typeof value === 'string' && /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(value),
  },
};
const REQUIRED = new Set(['name', 'ci', 'ci.browserSuites', 'ci.emulatorSecrets', 'build', 'build.sentryDsnVariable',
  'emulators', 'emulators.base', 'emulators.project', 'release', 'release.appSigningCertificate', 'native', 'native.seed']);
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
