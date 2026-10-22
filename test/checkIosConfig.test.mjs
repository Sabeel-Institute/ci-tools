import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iosConfigProblems, plistStrings } from '../scripts/check-ios-config.mjs';
import { BUNDLE_ID, DSN, PROJECT, iosApp, plist, pngHeader } from './fixtures/iosApp.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import minimal from './fixtures/minimal.json' with { type: 'json' };

const script = fileURLToPath(new URL('../scripts/check-ios-config.mjs', import.meta.url));
const SENTRY = { SENTRY_ORG: 'o', SENTRY_PROJECT: 'p', SENTRY_AUTH_TOKEN: 't' };
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function app(settings) {
  const fixture = iosApp(settings);
  fixtures.push(fixture.root);
  const edit = (change) => {
    const json = JSON.parse(readFileSync(join(fixture.root, 'app/app.json'), 'utf8'));
    change(json.expo);
    fixture.put('app/app.json', json);
  };
  return { ...fixture, edit, check: (env = SENTRY) => iosConfigProblems(fixture.root, env) };
}

describe('check-ios-config', () => {
  it('passes a complete configuration, and warns where the Sentry build variables are missing', () => {
    const { check } = app();
    expect(check()).toEqual({ problems: [], warnings: [], summary: `${BUNDLE_ID}, v1.2.3 build 3` });
    expect(check({}).warnings).toEqual([expect.stringMatching(/^SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN not set/)]);
  });

  it.each([
    ['an app not built for iOS', ({ edit }) => edit((e) => { e.platforms = ['android', 'web']; }), /platforms does not include "ios"/],
    ['no plist', ({ root }) => rmSync(join(root, 'app/GoogleService-Info.plist')), /GoogleService-Info\.plist is missing[\s\S]*GOOGLE_SERVICE_INFO_PLIST/],
    ['another bundle id in the plist', ({ put }) => put('app/GoogleService-Info.plist', plist({ BUNDLE_ID: 'com.example.other', PROJECT_ID: PROJECT, REVERSED_CLIENT_ID: 'x' })), /bundle id mismatch/],
    ['a plist from a project .firebaserc does not name', ({ put }) => {
      put('app/GoogleService-Info.plist', plist({ BUNDLE_ID, PROJECT_ID: 'legacy-project', REVERSED_CLIENT_ID: 'x' }));
      put('app/google-services.json', { project_info: { project_id: 'legacy-project' } });
    }, /the plist is for Firebase project "legacy-project", but \.firebaserc names "example-project"/],
    ['Android in another project', ({ put }) => put('app/google-services.json', { project_info: { project_id: 'other' } }), /Firebase project mismatch.*google-services\.json for "other"/],
    ['no .firebaserc', ({ root }) => rmSync(join(root, '.firebaserc')), /cannot read the Firebase project from \.firebaserc/],
    ['Google sign-in given options', ({ edit }) => edit((e) => { e.plugins[0] = ['@react-native-google-signin/google-signin', { iosUrlScheme: 'x' }]; }), /google-signin" is configured with options/],
    ['no REVERSED_CLIENT_ID', ({ put }) => put('app/GoogleService-Info.plist', plist({ BUNDLE_ID, PROJECT_ID: PROJECT })), /no REVERSED_CLIENT_ID/],
    ['Sentry given options', ({ edit }) => edit((e) => { e.plugins[1] = ['@sentry/react-native/expo', { organization: 'o' }]; }), /"@sentry\/react-native\/expo" is configured with options/],
    ['no Sentry plugin', ({ edit }) => edit((e) => { e.plugins.splice(1, 1); }), /missing "@sentry\/react-native"/],
    ['no push plugin', ({ edit }) => edit((e) => { e.plugins.splice(2, 1); }), /missing "expo-notifications".*aps-environment/],
    ['no background playback', ({ edit }) => edit((e) => { e.plugins[3] = 'expo-video'; }), /supportsBackgroundPlayback: true/],
    ['export compliance unanswered', ({ edit }) => edit((e) => { delete e.ios.config; }), /usesNonExemptEncryption must be explicitly false/],
    ['a second version', ({ edit }) => edit((e) => { e.ios.version = '1.2.4'; }), /expo\.ios\.version is set/],
    ['a version Apple refuses', ({ edit, put }) => {
      edit((e) => { e.version = '1.2.3-beta.1'; });
      put('app/android/app/build.gradle', 'versionName "1.2.3-beta.1"\n');
    }, /not three period-separated integers/],
    ['a stated versionName that differs', ({ put }) => put('app/android/app/build.gradle', 'versionName "1.2.2"\n'), /build\.gradle says 1\.2\.2/],
    ['a build number that cannot be raised', ({ edit }) => edit((e) => { e.ios.buildNumber = '3a'; }), /buildNumber must be a whole number/],
    ['no build number', ({ edit }) => edit((e) => { delete e.ios.buildNumber; }), /buildNumber must be a whole number as a string; got undefined/],
    ['an icon with alpha', ({ put }) => put('app/assets/icon.png', pngHeader(1024, 1024, 6)), /alpha channel \(PNG colour type 6\)/],
    ['an icon of the wrong size', ({ put }) => put('app/assets/icon.png', pngHeader(512, 512)), /512x512; the App Store icon must be 1024x1024/],
    ['an icon that is not a PNG', ({ put }) => put('app/assets/icon.png', 'GIF89a'), /is not a PNG/],
    ['no DSN', ({ put }) => put('app/.env.local', 'EXPO_PUBLIC_OTHER=1\n'), /no EXPO_PUBLIC_SENTRY_DSN_NATIVE, so the build would ship with crash reporting OFF/],
    ['the DSN under another app\'s name', ({ put }) => put('app/.env.local', `EXPO_PUBLIC_SENTRY_DSN=${DSN}\n`), /no EXPO_PUBLIC_SENTRY_DSN_NATIVE/],
    ['something that is not a DSN', ({ put }) => put('app/.env.local', 'EXPO_PUBLIC_SENTRY_DSN_NATIVE=http://example\n'), /does not look like a Sentry DSN/],
    ['no privacy manifest', ({ edit }) => edit((e) => { delete e.ios.privacyManifests; }), /no expo\.ios\.privacyManifests/],
    ['tracking declared', ({ edit }) => edit((e) => { e.ios.privacyManifests.NSPrivacyTracking = true; }), /NSPrivacyTracking must be false/],
    ['a collected type that does not deny tracking', ({ edit }) => edit((e) => { delete e.ios.privacyManifests.NSPrivacyCollectedDataTypes[0].NSPrivacyCollectedDataTypeTracking; }), /every collected data type must say/],
  ])('refuses %s', (_, change, message) => {
    const fixture = app();
    change(fixture);
    const { problems } = fixture.check();
    expect(problems).toEqual([expect.stringMatching(message)]);
  });

  it('asks only what ci-tools.json says of the app', () => {
    const { edit, put, check } = app(minimal);
    edit((e) => { e.plugins = e.plugins.filter((p) => !Array.isArray(p)); });
    put('app/android/app/build.gradle', 'versionName expoVersion\n');
    expect(check().problems).toEqual([]);
    put('app/.env.local', `${minimal.build.sentryDsnVariable}="${DSN}"\n`);
    expect(check().problems).toEqual([]);
  });

  it('takes either spelling of the Sentry plugin, and a project among several', () => {
    const { edit, put, check } = app();
    edit((e) => { e.plugins[1] = '@sentry/react-native/expo'; });
    put('.firebaserc', { projects: { dev: PROJECT, staging: 'example-staging' } });
    expect(check().problems).toEqual([]);
  });


  it('reads the plist\'s string values', () => {
    expect(plistStrings(plist({ A: '1', B: '' }) + '<key>C</key><true/>')).toEqual({ A: '1', B: '' });
  });

  it('runs as a command: problems fail it, a bad ci-tools.json cannot run it', () => {
    const { root, put } = app();
    const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...SENTRY } });
    let result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`iOS config ok (${BUNDLE_ID}, v1.2.3 build 3)\n`);
    put('app/assets/icon.png', pngHeader(1024, 1024, 4));
    result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/iOS config check FAILED[\s\S]*alpha channel/);
    put('ci-tools.json', { ...full, build: { ...full.build, sentryDsnVariable: 'SENTRY_DSN' } });
    result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/build\.sentryDsnVariable has an invalid value/);
  });
});
