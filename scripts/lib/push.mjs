import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * What check-push and send-test-push take from the app they run in. The
 * message and its transport are the functions' own code, run from source, so
 * a probe or a test push is exactly what a notification sends:
 *
 *   functions/src/fcm.ts       fcmMessage(message): the FCM message, less its token
 *                              DEAD_TOKEN_CODES: the FCM error codes the functions prune on
 *   functions/src/apns.ts      sendToApns([{ token, apnsEnvironment, message }], credentials)
 *                              answering { delivered, dead, failed }
 *   functions/src/testPush.ts  testMessage(title, body, fields): the app's message, opening
 *                              what `fields` name (none: the app); null when they name
 *                              nothing the app opens
 *
 * Each imports nothing relative but types, so Node runs it as it is.
 * firebase-admin comes from the functions workspace, never from ci-tools. The
 * project is the one .firebaserc names; the APNs key's id and the team id are
 * in functions/.env.<project>, where the deployed functions read them.
 */

/** An Apple device token: hex, 64 characters or more. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/i;

/** Apple's two services; a token from one is refused by the other. */
export const APNS_ENVIRONMENTS = ['production', 'development'];

const CONTRACT = {
  fcm: { fcmMessage: 'function', DEAD_TOKEN_CODES: 'set' },
  apns: { sendToApns: 'function' },
  testPush: { testMessage: 'function' },
};

/** The Firebase project .firebaserc names, under whatever alias; it must name exactly one. */
export function project(root = '.') {
  let aliases;
  try {
    aliases = JSON.parse(readFileSync(resolve(root, '.firebaserc'), 'utf8')).projects;
  } catch (error) {
    throw new Error(`cannot read the project from .firebaserc: ${error.message}`);
  }
  const ids = [...new Set(Object.values(aliases ?? {}))];
  if (ids.length !== 1 || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(String(ids[0]))) {
    throw new Error(`.firebaserc must name exactly one project, the one push is sent from; it names ${ids.length ? ids.join(', ') : 'none'}`);
  }
  return ids[0];
}

/** The APNs key's id and the team id, from functions/.env.<project>. */
export function appleIds(projectId, root = '.') {
  const path = `functions/.env.${projectId}`;
  let values;
  try {
    values = parseEnv(readFileSync(resolve(root, path), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
  for (const [name, what] of [['APNS_KEY_ID', 'the ten characters in AuthKey_<id>.p8'], ['APPLE_TEAM_ID', 'the team that owns the key and the app']]) {
    if (!/^[A-Z0-9]{10}$/.test(values[name] ?? '')) throw new Error(`${path} must set ${name}, ${what}`);
  }
  return { keyId: values.APNS_KEY_ID, teamId: values.APPLE_TEAM_ID };
}

/** functions/src/<name>.ts, run from source, holding what the push tools call. */
export async function functionsModule(name) {
  const path = `functions/src/${name}.ts`;
  if (!process.features.typescript) throw new Error(`running ${path} from source needs Node 22.18 or later`);
  if (!existsSync(path)) throw new Error(`no ${path}: the push tools send through the functions' own code (ci-tools README, "Push")`);
  let module;
  try {
    module = await import(pathToFileURL(resolve(path)).href);
  } catch (error) {
    throw new Error(`cannot run ${path} from source (it may import only types relatively, and its packages must be installed and built): ${error.message}`);
  }
  for (const [exported, kind] of Object.entries(CONTRACT[name])) {
    if (kind === 'set' ? !(module[exported] instanceof Set) : typeof module[exported] !== kind) {
      throw new Error(`${path} does not export ${exported}, which the push tools call (ci-tools README, "Push")`);
    }
  }
  return module;
}

/**
 * FCM through firebase-admin from the functions workspace, for the project,
 * by its modular entry points as the functions reach it (firebase-admin 14
 * has no `admin.messaging()`). With CHECK_ACCESS_TOKEN set it authenticates
 * as that user token (`gcloud auth print-access-token --account=<owner>`)
 * rather than Application Default Credentials, which on a shared machine may
 * be another Google account.
 */
export function messaging(projectId) {
  let app;
  let getMessaging;
  try {
    const require = createRequire(resolve('functions/package.json'));
    app = require('firebase-admin/app');
    ({ getMessaging } = require('firebase-admin/messaging'));
  } catch (error) {
    throw new Error(`cannot load firebase-admin from functions/ (npm ci first): ${error.message}`);
  }
  const accessToken = process.env.CHECK_ACCESS_TOKEN;
  return getMessaging(app.initializeApp({
    projectId,
    ...(accessToken ? { credential: { getAccessToken: async () => ({ access_token: accessToken, expires_in: 3000 }) } } : {}),
  }));
}

/**
 * Apple's key, which is never printed: the file APNS_KEY_FILE names, or else
 * `[where, read]`. Throws naming where it looked.
 */
export function appleKey([where, read]) {
  const file = process.env.APNS_KEY_FILE;
  const from = file ? `APNS_KEY_FILE (${file})` : where;
  let key;
  try {
    key = file ? readFileSync(file, 'utf8') : read();
  } catch {
    throw new Error(`${from} cannot be read`);
  }
  if (!key.includes('-----BEGIN PRIVATE KEY-----')) throw new Error(`the key from ${from} is not an APNs .p8 key`);
  return { key, from };
}
