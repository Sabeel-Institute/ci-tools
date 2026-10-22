import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import full from './full.json' with { type: 'json' };

/** A fresh VAPID public key as a browser takes it: 0x04, x, y, in base64url. */
export function vapidKey() {
  const { x, y } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('base64url');
}

/** A web export whose index.html loads `bundles` (name to text), with `extra` files beside them. */
export function webExport(site, bundles, extra = {}) {
  const put = (path, text) => {
    mkdirSync(dirname(join(site, path)), { recursive: true });
    writeFileSync(join(site, path), text);
  };
  put('index.html', `<!DOCTYPE html><html><head>${Object.keys(bundles)
    .map((name) => `<script src="/_expo/static/js/web/${name}" defer></script>`).join('')}</head><body></body></html>`);
  for (const [name, text] of Object.entries({ ...bundles, ...extra })) put(`_expo/static/js/web/${name}`, text);
}

export const PROJECT = 'demo-push-fixture';
export const KEY_ID = 'KEYID12345';
export const TEAM_ID = 'TEAMID6789';
/** What Secret Manager and the key file hold here: shaped like a .p8, and never to be printed. */
export const SECRET_MANAGER_KEY = '-----BEGIN PRIVATE KEY-----\nFIXTURE-SECRET-MANAGER-KEY\n-----END PRIVATE KEY-----\n';
export const FILE_KEY = '-----BEGIN PRIVATE KEY-----\nFIXTURE-FILE-KEY\n-----END PRIVATE KEY-----\n';

/**
 * The app side of the push tools, as the README's "Push" describes it, with
 * every outside service a stand-in that writes what it was asked to push.log:
 * the functions' fcm.ts, apns.ts and testPush.ts (TypeScript, run from source),
 * firebase-admin in the functions workspace, and gcloud on the PATH. FAKE_FCM
 * and FAKE_APPLE say what the services answer.
 */
export function pushApp() {
  const root = mkdtempSync(join(tmpdir(), 'ci-tools-push-'));
  const put = (path, text, mode = 0o644) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, { mode });
  };
  put('ci-tools.json', JSON.stringify(full));
  put('.firebaserc', JSON.stringify({ projects: { prod: PROJECT } }));
  put('functions/package.json', JSON.stringify({ name: 'functions', main: 'lib/index.js' }));
  put(`functions/.env.${PROJECT}`, `# the ids the deployed functions read\nAPNS_KEY_ID=${KEY_ID}\nAPPLE_TEAM_ID="${TEAM_ID}"\n`);
  put('functions/src/fcm.ts', `import type { Message } from './testPush';

export const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export function fcmMessage(message: Message) {
  return { notification: { title: message.title, body: message.body }, data: message.route ?? {} };
}
`);
  put('functions/src/apns.ts', `import { appendFileSync } from 'node:fs';
import type { Message } from './testPush';

type Send = { token: string; apnsEnvironment: 'production' | 'development'; message: Message };

export async function sendToApns(sends: Send[], creds: { key: string; keyId: string; teamId: string }) {
  appendFileSync(process.env.PUSH_LOG!, JSON.stringify({ apple: sends, ...creds }) + '\\n');
  const out = { delivered: [] as string[], dead: [] as string[], failed: [] as { token: string; reason: string }[] };
  for (const send of sends) {
    const answer = JSON.parse(process.env.FAKE_APPLE ?? '{}')[send.apnsEnvironment] ?? 'dead';
    if (answer === 'throw') throw new Error('Invalid key data');
    if (answer === 'delivered') out.delivered.push(send.token);
    else if (answer === 'dead') out.dead.push(send.token);
    else out.failed.push({ token: send.token, reason: answer });
  }
  return out;
}
`);
  put('functions/src/testPush.ts', `export type Message = { title: string; body: string; route: Record<string, string> | null };

export function testMessage(title: string, body: string, fields: Record<string, string>): Message | null {
  const keys = Object.keys(fields);
  if (keys.some((key) => key !== 'screen' && key !== 'id')) return null;
  return { title, body, route: keys.length ? fields : null };
}
`);
  put('functions/node_modules/firebase-admin/package.json', JSON.stringify({ name: 'firebase-admin', main: 'index.js' }));
  put('functions/node_modules/firebase-admin/index.js', `const { appendFileSync } = require('node:fs');
const log = (entry) => appendFileSync(process.env.PUSH_LOG, JSON.stringify(entry) + '\\n');
let options;
exports.initializeApp = (value) => { options = value; };
exports.messaging = () => ({
  async sendEachForMulticast(message) {
    const credential = options.credential ? (await options.credential.getAccessToken()).access_token : null;
    log({ fcm: 'multicast', projectId: options.projectId, credential, message });
    const answer = process.env.FAKE_FCM ?? 'messaging/registration-token-not-registered';
    if (answer === 'throw') throw new Error('Firebase Cloud Messaging API has not been used in this project');
    return { responses: [answer === 'accepted' ? { success: true } : { success: false, error: { code: answer } }] };
  },
  async send(message) {
    log({ fcm: 'send', projectId: options.projectId, message });
    const answer = process.env.FAKE_FCM ?? 'accepted';
    if (answer !== 'accepted') throw Object.assign(new Error('Requested entity was not found.'), { code: answer });
    return 'projects/${PROJECT}/messages/0:1';
  },
});
`);
  put('bin/gcloud', `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.PUSH_LOG, JSON.stringify({ gcloud: process.argv.slice(2) }) + '\\n');
if (process.env.FAKE_GCLOUD === 'fail') process.exit(1);
process.stdout.write(process.env.FAKE_GCLOUD ?? ${JSON.stringify(SECRET_MANAGER_KEY)});
`, 0o755);
  put(`home/.apns/AuthKey_${KEY_ID}.p8`, FILE_KEY, 0o600);
  const log = join(root, 'push.log');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { root, put, log, calls };
}
