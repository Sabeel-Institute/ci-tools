import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APNS_ENVIRONMENTS, APNS_TOKEN, appleIds, appleKey, functionsModule, messaging, project } from './lib/push.mjs';

/**
 * Send one real push to one device, as the real project.
 *
 *   sabeel-ci send-test-push <fcm-token> [key=value ...]
 *   sabeel-ci send-test-push --apple <development|production> <iphone-token> [key=value ...]
 *
 * The device check no emulator can do: there is no FCM or APNs emulator and
 * the emulated functions send nothing, so "a push is shown, and a tap opens
 * what it is about" is proved only by a real message reaching a real device,
 * with the app open and then closed. The `key=value` pairs are where a tap
 * leads, as the push carries them; the app's testMessage turns them into its
 * message and refuses a destination the app does not open. Left out, a tap
 * opens the app. The message is built and sent by the functions' own code
 * (scripts/lib/push.mjs), so this sends exactly what a notification sends.
 *
 * An iPhone's token goes to the Apple service that issued it: `development`
 * for a debug build (an Apple-silicon simulator receives these too),
 * `production` for TestFlight and the App Store; the device's row says which.
 * The key is the file APNS_KEY_FILE names, or ~/.apns/AuthKey_<APNS_KEY_ID>.p8;
 * its id and the team id come from functions/.env.<project>. An FCM send
 * authenticates as Application Default Credentials, or as CHECK_ACCESS_TOKEN.
 *
 * Writes nothing: no Firestore document, no inbox entry, no notification record.
 */

const USAGE = `usage: sabeel-ci send-test-push <fcm-token> [key=value ...]
       sabeel-ci send-test-push --apple <development|production> <iphone-token> [key=value ...]`;

function refuse(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

/** The command line, checked before anything is loaded or sent. */
export function parse(args) {
  const apple = args[0] === '--apple';
  const [environment, token = '', ...pairs] = apple ? args.slice(1) : [undefined, ...args];
  if (apple && !APNS_ENVIRONMENTS.includes(environment)) return { error: '--apple needs the service the token came from: development or production' };
  if (apple && !APNS_TOKEN.test(token)) return { error: "an iPhone's token is hex, at least 64 characters" };
  if (!apple && APNS_TOKEN.test(token)) return { error: "that is an iPhone's token: send it with --apple <development|production>" };
  if (!apple && token.length < 100) return { error: 'an FCM token is ~150 characters' };
  const entries = [];
  for (const pair of pairs) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)=(.+)$/.exec(pair);
    if (!match) return { error: `not a key=value pair: ${pair}` };
    if (entries.some(([key]) => key === match[1])) return { error: `${match[1]} is given twice` };
    entries.push([match[1], match[2]]);
  }
  return { apple, environment, token, fields: Object.fromEntries(entries) };
}

async function main(args) {
  const { error, apple, environment, token, fields } = parse(args);
  if (error) refuse(error);
  const projectId = project();
  const { testMessage } = await functionsModule('testPush');
  const message = testMessage('Test push', 'Sent by sabeel-ci send-test-push. Safe to dismiss.', fields);
  if (!message) refuse(`not a destination the app opens: ${Object.entries(fields).map((pair) => pair.join('=')).join(' ')}`);

  if (apple) {
    const { sendToApns } = await functionsModule('apns');
    const { keyId, teamId } = appleIds(projectId);
    const file = join(homedir(), '.apns', `AuthKey_${keyId}.p8`);
    let key;
    try {
      ({ key } = appleKey([file, () => readFileSync(file, 'utf8')]));
    } catch (error) {
      console.error(`no push key: ${error.message} (set APNS_KEY_FILE)`);
      process.exit(2);
    }
    const out = await sendToApns([{ token, apnsEnvironment: environment, message }], { key, keyId, teamId });
    if (out.delivered.length) console.log(`accepted by Apple (${environment})`);
    else if (out.dead.length) console.log('Apple says this token will never work (the other service, another app, or the app was removed)');
    else console.log(`not delivered: ${out.failed[0]?.reason}`);
    process.exit(out.delivered.length ? 0 : 1);
  }

  const { fcmMessage, DEAD_TOKEN_CODES } = await functionsModule('fcm');
  const fcmApi = messaging(projectId);
  try {
    console.log(`sent ${await fcmApi.send({ token, ...fcmMessage(message) })}`);
  } catch (error) {
    console.log(DEAD_TOKEN_CODES.has(error.code)
      ? `FCM says this token will never work (${error.code}): the app was removed, or the token replaced`
      : `not delivered: ${error.code ?? error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`send-test-push: ${error.message}`);
    process.exit(1);
  }
}
