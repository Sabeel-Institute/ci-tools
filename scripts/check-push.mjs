import { execFileSync } from 'node:child_process';
import { APNS_ENVIRONMENTS, appleIds, appleKey, functionsModule, messaging, project } from './lib/push.mjs';

/**
 * Is the push send path reachable and authorised against the real project?
 *
 *   sabeel-ci check-push [fcm|apple]
 *
 * There is no FCM or APNs emulator, so the app's tests stand in for both
 * senders and the functions meet the real services only in production. The
 * signature failure of push is that every visible part works while nothing is
 * delivered, so this asks each service the one question answerable without a
 * device: will you accept a message from us? Each probe goes to a token that
 * cannot exist, built and sent by the functions' own code (scripts/lib/push.mjs),
 * and the right refusal proves the request was authenticated as this project
 * and this app.
 *
 *  1. FCM (Android phones and browsers) answers
 *     `registration-token-not-registered` only once it has accepted our
 *     credentials, and that answer must be one of the functions'
 *     DEAD_TOKEN_CODES, so a pruner that stopped matching what FCM really says
 *     fails here. Credentials: Application Default Credentials, or
 *     CHECK_ACCESS_TOKEN.
 *  2. Apple (iPhones), production and development services: an answer about
 *     the token comes only after Apple accepted the provider token, so the
 *     key, its id, the team and the app id were all right; and it arriving as
 *     dead means the sender prunes on what Apple really says. The key is
 *     Secret Manager's APNS_KEY, the one the deployed functions read (through
 *     gcloud, never printed), or the file APNS_KEY_FILE names, on a machine
 *     with the `.p8` and not the project's credentials.
 *
 * `fcm` or `apple` asks that service alone. Reads and writes nothing in
 * Firestore and reaches no real device; a banner on a phone is still a device
 * check (`sabeel-ci send-test-push`).
 */

const SERVICES = ['fcm', 'apple'];
const FCM_PROBE_TOKEN = 'dGhpcy1pcy1ub3QtYS10b2tlbg:APA91bHnotarealtokennotarealtokennotareal';
const APPLE_PROBE_TOKEN = 'ab'.repeat(32);

let failed = false;
const ok = (first, ...rest) => console.log([`  ok    ${first}`, ...rest.map((line) => `        ${line}`)].join('\n'));
const fail = (first, ...rest) => {
  failed = true;
  console.log([`  FAIL  ${first}`, ...rest.map((line) => `        ${line}`)].join('\n'));
};

async function fcm(projectId, probe) {
  const { fcmMessage, DEAD_TOKEN_CODES } = await functionsModule('fcm');
  const fcmApi = messaging(projectId);
  let code;
  try {
    const answer = await fcmApi.sendEachForMulticast({ tokens: [FCM_PROBE_TOKEN], ...fcmMessage(probe) });
    code = answer.responses[0].error?.code;
  } catch (error) {
    code = `threw: ${error.message}`;
  }
  if (DEAD_TOKEN_CODES.size === 0) {
    fail('DEAD_TOKEN_CODES in functions/src/fcm.ts is empty: the functions prune no dead token');
  } else if (DEAD_TOKEN_CODES.has(code)) {
    ok(`FCM accepted our credentials and refused the bogus token as ${code},`, 'a code the functions prune on');
  } else {
    fail(`unexpected answer from FCM: ${code ?? 'the bogus token was ACCEPTED'}`,
      `the functions prune on: ${[...DEAD_TOKEN_CODES].join(', ')}`,
      'an auth or permission code means Cloud Messaging is off, or these',
      'credentials are not this project (try CHECK_ACCESS_TOKEN)');
  }
}

async function apple(projectId, probe) {
  const { sendToApns } = await functionsModule('apns');
  const { keyId, teamId } = appleIds(projectId);
  let key, from;
  try {
    ({ key, from } = appleKey([`Secret Manager's APNS_KEY in ${projectId}`, () => execFileSync('gcloud',
      ['secrets', 'versions', 'access', 'latest', '--secret=APNS_KEY', `--project=${projectId}`],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString()]));
  } catch (error) {
    fail(`no APNs key, so iPhones would hear nothing: ${error.message}`,
      ...(process.env.APNS_KEY_FILE ? [] : ["(APNS_KEY_FILE names the .p8 on a machine without the project's credentials)"]));
    return;
  }
  let refused = false;
  for (const apnsEnvironment of APNS_ENVIRONMENTS) {
    let answer;
    try {
      answer = await sendToApns([{ token: APPLE_PROBE_TOKEN, apnsEnvironment, message: probe }], { key, keyId, teamId });
    } catch (error) {
      fail(`Apple ${apnsEnvironment}: the sender threw: ${error.message}`);
      continue;
    }
    if (answer.dead.includes(APPLE_PROBE_TOKEN)) {
      ok(`Apple ${apnsEnvironment} accepted key ${keyId} (from ${from}) for team ${teamId} and this app,`,
        'and refused the bogus token as one the sender prunes on');
    } else {
      refused = true;
      fail(`unexpected answer from Apple ${apnsEnvironment}: ${answer.failed[0]?.reason ?? 'the bogus token was ACCEPTED'}`);
    }
  }
  if (refused) {
    console.log('        InvalidProviderToken: the key, its id or the team id is wrong;');
    console.log('        TopicDisallowed or BadTopic: the key is not for this app');
  }
}

async function main(args) {
  if (args.length > 1 || (args.length === 1 && !SERVICES.includes(args[0]))) {
    console.error('usage: sabeel-ci check-push [fcm|apple]');
    process.exit(2);
  }
  const projectId = project();
  const { testMessage } = await functionsModule('testPush');
  const probe = testMessage('reachability probe', 'never delivered to anyone', {});
  if (!probe) throw new Error('functions/src/testPush.ts makes no message for no destination: testMessage(title, body, {}) must open the app');
  console.log(`Push send path against ${projectId}\n`);
  for (const [service, check] of [['fcm', fcm], ['apple', apple]]) {
    if (args.length && args[0] !== service) continue;
    try {
      await check(projectId, probe);
    } catch (error) {
      fail(error.message);
    }
  }
  console.log(failed ? '\nthe send path is NOT ready' : '\nthe send path is ready; a banner appearing is still a device check');
  process.exit(failed ? 1 : 0);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`check-push: ${error.message}`);
  process.exit(1);
}
