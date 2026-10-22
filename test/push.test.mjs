import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../scripts/send-test-push.mjs';
import { FILE_KEY, KEY_ID, PROJECT, SECRET_MANAGER_KEY, TEAM_ID, pushApp } from './fixtures/push.mjs';

const bin = fileURLToPath(new URL('../bin/sabeel-ci.mjs', import.meta.url));
const apps = [];

afterEach(() => {
  for (const { root } of apps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function app() {
  const made = pushApp();
  apps.push(made);
  const run = (command, args = [], env = {}) => {
    const base = { ...process.env };
    for (const name of ['APNS_KEY_FILE', 'CHECK_ACCESS_TOKEN', 'FAKE_FCM', 'FAKE_APPLE', 'FAKE_GCLOUD']) delete base[name];
    const result = spawnSync(process.execPath, [bin, command, ...args], {
      cwd: made.root, encoding: 'utf8',
      env: { ...base, PATH: `${join(made.root, 'bin')}:${process.env.PATH}`, HOME: join(made.root, 'home'), PUSH_LOG: made.log, ...env },
    });
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('FIXTURE-SECRET-MANAGER-KEY');
    expect(output).not.toContain('FIXTURE-FILE-KEY');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output };
  };
  return { ...made, run };
}

const FCM_TOKEN = 'dGVzdC1kZXZpY2U:APA91b' + 'Q'.repeat(140);
const IPHONE_TOKEN = 'c0ffee'.repeat(16);
const probe = { title: 'reachability probe', body: 'never delivered to anyone', route: null };

describe('check-push', () => {
  it("asks FCM and both Apple services through the app's own code, as the one project .firebaserc names", () => {
    const test = app();
    const result = test.run('check-push', [], { CHECK_ACCESS_TOKEN: 'owner-token' });
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(`Push send path against ${PROJECT}`);
    expect(result.stdout).toMatch(/ok {4}FCM accepted our credentials and refused the bogus token as messaging\/registration-token-not-registered/);
    expect(result.stdout).toContain(`Apple production accepted key ${KEY_ID} (from Secret Manager's APNS_KEY in ${PROJECT}) for team ${TEAM_ID}`);
    expect(result.stdout).toContain('Apple development accepted');
    expect(result.stdout).toContain('the send path is ready');
    const [fcm, gcloud, ...apple] = test.calls();
    expect(fcm).toMatchObject({ fcm: 'multicast', projectId: PROJECT, credential: 'owner-token' });
    expect(fcm.message.tokens).toHaveLength(1);
    expect(fcm.message.notification).toEqual({ title: probe.title, body: probe.body });
    expect(gcloud.gcloud).toEqual(['secrets', 'versions', 'access', 'latest', '--secret=APNS_KEY', `--project=${PROJECT}`]);
    expect(apple.map((call) => call.apple.map((send) => send.apnsEnvironment))).toEqual([['production'], ['development']]);
    for (const call of apple) {
      expect(call).toMatchObject({ key: SECRET_MANAGER_KEY, keyId: KEY_ID, teamId: TEAM_ID });
      expect(call.apple[0]).toEqual({ token: 'ab'.repeat(32), apnsEnvironment: expect.any(String), message: probe });
    }
  });

  it('fails when FCM refuses with a code the functions do not prune on', () => {
    const test = app();
    test.put('functions/src/fcm.ts', `export const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set(['messaging/invalid-registration-token']);
export function fcmMessage(message: { title: string; body: string }) { return { notification: { title: message.title, body: message.body } }; }
`);
    const drifted = test.run('check-push', ['fcm']);
    expect(drifted.status).toBe(1);
    expect(drifted.stdout).toContain('FAIL  unexpected answer from FCM: messaging/registration-token-not-registered');
    expect(drifted.stdout).toContain('the functions prune on: messaging/invalid-registration-token');
    expect(drifted.stdout).toContain('the send path is NOT ready');

    const wrongProject = app().run('check-push', ['fcm'], { FAKE_FCM: 'messaging/third-party-auth-error' });
    expect(wrongProject.status).toBe(1);
    expect(wrongProject.stdout).toMatch(/unexpected answer from FCM: messaging\/third-party-auth-error[\s\S]*try CHECK_ACCESS_TOKEN/);
    const off = app().run('check-push', ['fcm'], { FAKE_FCM: 'throw' });
    expect(off.status).toBe(1);
    expect(off.stdout).toContain('unexpected answer from FCM: threw: Firebase Cloud Messaging API has not been used');
    const accepted = app().run('check-push', ['fcm'], { FAKE_FCM: 'accepted' });
    expect(accepted.stdout).toContain('the bogus token was ACCEPTED');
  });

  it('fails on each Apple service that refuses the key, saying what the refusal means', () => {
    const test = app();
    const result = test.run('check-push', ['apple'], { FAKE_APPLE: JSON.stringify({ development: 'InvalidProviderToken' }) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ok    Apple production accepted');
    expect(result.stdout).toContain('FAIL  unexpected answer from Apple development: InvalidProviderToken');
    expect(result.stdout).toContain('InvalidProviderToken: the key, its id or the team id is wrong');
    const thrown = app().run('check-push', ['apple'], { FAKE_APPLE: JSON.stringify({ production: 'throw' }) });
    expect(thrown.status).toBe(1);
    expect(thrown.stdout).toContain('FAIL  Apple production: the sender threw: Invalid key data');
  });

  it('takes the key from APNS_KEY_FILE without asking Secret Manager, and fails with no key', () => {
    const test = app();
    const file = join(test.root, 'home/.apns', `AuthKey_${KEY_ID}.p8`);
    expect(test.run('check-push', ['apple'], { APNS_KEY_FILE: file }).status).toBe(0);
    expect(test.calls().some((call) => call.gcloud)).toBe(false);
    expect(test.calls().every((call) => call.key === FILE_KEY)).toBe(true);

    const missing = app().run('check-push', ['apple'], { APNS_KEY_FILE: '/nonexistent/AuthKey.p8' });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('no APNs key, so iPhones would hear nothing: APNS_KEY_FILE (/nonexistent/AuthKey.p8) cannot be read');
    const unreadable = app().run('check-push', ['apple'], { FAKE_GCLOUD: 'fail' });
    expect(unreadable.stdout).toContain(`Secret Manager's APNS_KEY in ${PROJECT} cannot be read`);
    expect(unreadable.stdout).toContain('APNS_KEY_FILE names the .p8');
    const notKey = app().run('check-push', ['apple'], { FAKE_GCLOUD: 'placeholder' });
    expect(notKey.status).toBe(1);
    expect(notKey.stdout).toContain('is not an APNs .p8 key');
  });

  it('asks one service when told which, and refuses anything else', () => {
    const apple = app();
    expect(apple.run('check-push', ['apple']).status).toBe(0);
    expect(apple.calls().some((call) => call.fcm)).toBe(false);
    const fcm = app();
    expect(fcm.run('check-push', ['fcm']).status).toBe(0);
    expect(fcm.calls().some((call) => call.apple || call.gcloud)).toBe(false);
    const both = app().run('check-push', ['both']);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain('usage: sabeel-ci check-push [fcm|apple]');
  });

  it('refuses a project it cannot name and Apple ids it cannot read, and still reports the other service', () => {
    const two = app();
    two.put('.firebaserc', JSON.stringify({ projects: { default: PROJECT, staging: 'demo-push-staging' } }));
    const ambiguous = two.run('check-push');
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain(`.firebaserc must name exactly one project, the one push is sent from; it names ${PROJECT}, demo-push-staging`);
    expect(two.calls()).toEqual([]);

    const noTeam = app();
    noTeam.put(`functions/.env.${PROJECT}`, `APNS_KEY_ID=${KEY_ID}\n`);
    const result = noTeam.run('check-push');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ok    FCM accepted');
    expect(result.stdout).toContain(`FAIL  functions/.env.${PROJECT} must set APPLE_TEAM_ID`);
  });

  it("names what the app's functions must provide when they do not", () => {
    const noTestPush = app();
    rmSync(join(noTestPush.root, 'functions/src/testPush.ts'));
    const missing = noTestPush.run('check-push');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('no functions/src/testPush.ts: the push tools send through the functions\' own code');

    const oldFcm = app();
    oldFcm.put('functions/src/fcm.ts', 'export function fcmMessage(token: string, message: unknown) { return { token, message }; }\n');
    expect(oldFcm.run('check-push', ['fcm']).stdout).toContain('functions/src/fcm.ts does not export DEAD_TOKEN_CODES');

    const relative = app();
    relative.put('functions/src/apns.ts', "import { APNS_ORIGINS } from './origins';\nexport const sendToApns = () => APNS_ORIGINS;\n");
    expect(relative.run('check-push', ['apple']).stdout).toContain('cannot run functions/src/apns.ts from source');
  });
});

describe('send-test-push', () => {
  it("sends the app's own message to an FCM token, opening what the pairs name", () => {
    const test = app();
    const result = test.run('send-test-push', [FCM_TOKEN, 'screen=Timesheet', 'id=2026-10-11']);
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain(`sent projects/${PROJECT}/messages/0:1`);
    expect(test.calls()).toEqual([{
      fcm: 'send', projectId: PROJECT,
      message: {
        token: FCM_TOKEN,
        notification: { title: 'Test push', body: 'Sent by sabeel-ci send-test-push. Safe to dismiss.' },
        data: { screen: 'Timesheet', id: '2026-10-11' },
      },
    }]);
    const dead = app().run('send-test-push', [FCM_TOKEN], { FAKE_FCM: 'messaging/registration-token-not-registered' });
    expect(dead.status).toBe(1);
    expect(dead.stdout).toContain('FCM says this token will never work');
  });

  it('sends to an iPhone through the service that issued its token, with the key in ~/.apns', () => {
    const test = app();
    const result = test.run('send-test-push', ['--apple', 'development', IPHONE_TOKEN], { FAKE_APPLE: JSON.stringify({ development: 'delivered' }) });
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain('accepted by Apple (development)');
    expect(test.calls()).toEqual([{
      apple: [{ token: IPHONE_TOKEN, apnsEnvironment: 'development', message: { title: 'Test push', body: 'Sent by sabeel-ci send-test-push. Safe to dismiss.', route: null } }],
      key: FILE_KEY, keyId: KEY_ID, teamId: TEAM_ID,
    }]);
    const dead = app().run('send-test-push', ['--apple', 'production', IPHONE_TOKEN]);
    expect(dead.status).toBe(1);
    expect(dead.stdout).toContain('Apple says this token will never work');

    const keyless = app();
    rmSync(join(keyless.root, 'home/.apns'), { recursive: true });
    const noKey = keyless.run('send-test-push', ['--apple', 'development', IPHONE_TOKEN]);
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toContain(`no push key: ${join(keyless.root, 'home/.apns', `AuthKey_${KEY_ID}.p8`)} cannot be read (set APNS_KEY_FILE)`);
    expect(keyless.calls()).toEqual([]);
  });

  it('refuses what it cannot send, before loading or sending anything', () => {
    const cases = [
      [['--apple', 'staging', IPHONE_TOKEN], /development or production/],
      [['--apple', 'development', 'not-hex'], /hex, at least 64 characters/],
      [[IPHONE_TOKEN], /that is an iPhone's token: send it with --apple/],
      [['short'], /an FCM token is ~150 characters/],
      [[], /an FCM token is ~150 characters/],
      [[FCM_TOKEN, 'screen'], /not a key=value pair: screen/],
      [[FCM_TOKEN, 'screen='], /not a key=value pair/],
      [[FCM_TOKEN, 'screen=a', 'screen=b'], /screen is given twice/],
    ];
    for (const [args, error] of cases) expect(parse(args).error, args.join(' ')).toMatch(error);

    const test = app();
    const refused = test.run('send-test-push', ['--apple', 'staging', IPHONE_TOKEN]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/development or production\nusage: sabeel-ci send-test-push/);
    const nowhere = test.run('send-test-push', [FCM_TOKEN, 'board=1']);
    expect(nowhere.status).toBe(2);
    expect(nowhere.stderr).toContain('not a destination the app opens: board=1');
    expect(test.calls()).toEqual([]);
  });
});
