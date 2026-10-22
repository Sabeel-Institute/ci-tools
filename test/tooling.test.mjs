import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, findRoot, validate } from '../lib/config.mjs';
import { hostingProblems, portProblems, problems, pushChannelProblems } from '../scripts/check-app.mjs';
import { drift, expand, renderAll } from '../scripts/workflows.mjs';
import { emulatorProject, ports, suitePorts } from '../lib/ports.mjs';
import { SENTRY_GRADLE } from './fixtures/gradle.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import minimal from './fixtures/minimal.json' with { type: 'json' };

const bin = fileURLToPath(new URL('../bin/sabeel-ci.mjs', import.meta.url));
/** build.gradle's stop for a release it cannot sign, as Kanban wrote it. */
const RELEASE_KEY = `gradle.taskGraph.whenReady { graph ->
    def releaseSigning = android.buildTypes.release.signingConfig
    def packagesRelease = graph.allTasks.any { it.project == project && it.name ==~ /^(package|sign)Release(Bundle)?$/ }
    if (packagesRelease && releaseSigning != null && releaseSigning.storeFile == null) {
        throw new GradleException("No release key: restore it from the vault; a release is never left unsigned.")
    }
}
`;
/** How build.gradle finds the release key, the one variable ci-platform sets, stops without one, and applies Sentry's upload. */
const SIGNING = "    def releaseKeyFile = file(System.getenv('SABEEL_KEYSTORE_PROPERTIES') ?: \"${System.getProperty('user.home')}/.config/example/keystore.properties\")\n"
  + RELEASE_KEY + SENTRY_GRADLE;
const METRO = "const { getSentryExpoConfig } = require('@sentry/react-native/metro');\nmodule.exports = getSentryExpoConfig(__dirname);\n";
/** LMS's Hosting site, the one shape. */
const HOSTING = {
  public: 'app/dist-web',
  rewrites: [{ source: '/privacy', destination: '/privacy.html' }, { source: '!/_expo/**', destination: '/index.html' }],
  headers: [
    { source: '**', headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }] },
    { source: '!/__/**', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] },
    { source: '/_expo/static/**', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/assets/**', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
  ],
};
const CHANNEL = '<meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="sabeel-alerts"/>';
const MANIFEST = (meta) => `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <application>\n    ${meta}\n  </application>\n</manifest>\n`;
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** full.json's block, 61900, as firebase.json and the client state it. */
const FIREBASE_EMULATORS = {
  auth: { port: 61902 },
  functions: { port: 61903 },
  firestore: { port: 61900, websocketPort: 61901 },
  storage: { port: 61907 },
  ui: { enabled: true, port: 61904 },
  hub: { port: 61905 },
  logging: { port: 61906 },
  tasks: { port: 61908 },
  eventarc: { port: 61909 },
  singleProjectMode: true,
};
const ENV_TS = `import { Platform } from 'react-native';
export const EMULATOR_HOST = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
export const EMULATOR_PORTS = {
  auth: 61902,
  firestore: 61900,
  functions: 61903,
  storage: 61907,
} as const;
`;

/** An app repository that meets everything check-app asks. */
function app() {
  const root = mkdtempSync(join(tmpdir(), 'ci-tools-app-'));
  fixtures.push(root);
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  put('ci-tools.json', full);
  put('.gitignore', '.env.local\n.env.sentry-build-plugin\napp/android/keystore.properties\napp/src/build-info.ts\nfunctions/.secret.local\n*.jks\n*.keystore\n*service-account*.json\n*firebase-adminsdk*.json\n');
  put('app/app.json', { expo: { version: '0.2.1', android: { package: 'com.sabeelinstitute.example' }, ios: { bundleIdentifier: 'com.sabeelinstitute.example', buildNumber: '2001' } } });
  put('app/android/app/build.gradle', SIGNING + '        versionCode computedVersionCode\n        versionName expoVersion\n');
  put('app/android/build.gradle', "buildscript {\n  dependencies {\n    classpath('com.google.gms:google-services:4.4.4')\n  }\n}\n");
  put('app/android/app/src/main/AndroidManifest.xml', MANIFEST(CHANNEL));
  put('.firebaserc', { projects: { default: 'example-project' } });
  put('app/metro.config.js', METRO);
  put('app/src/sentry.ts', 'const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN_NATIVE;\n');
  put('app/src/sentry.web.ts', 'const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN_WEB;\n');
  put('docs/PHASE_STATUS.md', '## Deploy log\n\n### 2026-10-21 — The example release — v0.2.1\n');
  put('docs/USER-MANUAL.md', '# Manual\n\n*For app version 0.2.1 · October 2026*\n');
  put('functions/package.json', { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } });
  put('functions/package-lock.json', { packages: { '': { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } } } });
  put('functions/.env.demo-sabeel-example', 'MEDIA_BUCKET=local\n');
  for (const [name, text] of renderAll(full)) put(`.github/workflows/${name}`, text);
  put('firebase.json', { hosting: HOSTING, emulators: FIREBASE_EMULATORS });
  put('app/src/env.ts', ENV_TS);
  put('packages/shared/src/constants.ts', "export const EMULATOR_PROJECT_ID = 'demo-sabeel-example';\n");
  put('packages/shared/src/notify.ts', "export const PUSH_CHANNEL_ID = 'sabeel-alerts';\n");
  put('scripts/seed.mjs', "import { ports } from '@sabeel-institute/ci-tools/lib/ports.mjs';\nconst wait = 61000; // ms, not a port\n");
  put('package.json', { scripts: { 'dev:web': 'cd app && expo start --web --port $(sabeel-ci ports web)', test: 'vitest run' } });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return { root, put };
}

describe('ci-tools.json', () => {
  it('is found from anywhere inside the app', () => {
    const { root } = app();
    mkdirSync(join(root, 'app/src'), { recursive: true });
    expect(findRoot(join(root, 'app/src'))).toBe(root);
    expect(() => findRoot(tmpdir())).toThrow(/no ci-tools\.json/);
  });

  it('refuses a missing, misspelt or malformed setting', () => {
    expect(validate(structuredClone(minimal))).toEqual(minimal);
    expect(validate(structuredClone(full))).toEqual(full);
    const { name: _name, ...nameless } = minimal;
    expect(() => validate(nameless)).toThrow(/name is required/);
    expect(() => validate({ ...minimal, nmae: 'x' })).toThrow(/unknown key nmae/);
    expect(() => validate({ ...minimal, name: '' })).toThrow(/name must be lowercase words/);
    expect(() => validate({ ...minimal, ci: { ...minimal.ci, mediaStroe: true } })).toThrow(/unknown key ci\.mediaStroe/);
    expect(() => validate({ ...minimal, ci: { ...minimal.ci, browserSuites: ['test:e2e'] } })).toThrow(/ci\.browserSuites/);
    expect(() => validate({ ...minimal, ci: { ...minimal.ci, emulatorSecrets: { SENTRY_DSN: "it's" } } })).toThrow(/ci\.emulatorSecrets/);
    const { sentry: _sentry, ...sentryless } = minimal;
    expect(() => validate(sentryless)).toThrow(/sentry is required/);
    expect(() => validate({ ...minimal, sentry: { org: 'example-org' } })).toThrow(/sentry\.projects is required/);
    expect(() => validate({ ...minimal, sentry: { ...minimal.sentry, projects: { native: 'n', web: 'w' } } })).toThrow(/sentry\.projects\.functions is required/);
    expect(() => validate({ ...minimal, sentry: { ...minimal.sentry, projects: { ...minimal.sentry.projects, ios: 'i' } } })).toThrow(/unknown key sentry\.projects\.ios;/);
    for (const org of ['Example', 'has space', '-lead', '', 'a'.repeat(51)]) {
      expect(() => validate({ ...minimal, sentry: { ...minimal.sentry, org } }), org).toThrow(/sentry\.org has an invalid value/);
    }
    expect(() => validate({ ...minimal, build: { sentryDsnVariable: 'EXPO_PUBLIC_SENTRY_DSN' } })).toThrow(/unknown key build;/);
    expect(() => validate({ ...minimal, ios: { backgroundPlayback: 'yes' } })).toThrow(/ios\.backgroundPlayback has an invalid value/);
    expect(() => validate({ ...minimal, ios: { releaseNotes: true } })).toThrow(/unknown key ios\.releaseNotes/);
    for (const certificate of ['ab:'.repeat(31) + 'ab', 'AB'.repeat(32), 'AB:'.repeat(30) + 'AB']) {
      expect(() => validate({ ...minimal, release: { appSigningCertificate: certificate } }), certificate).toThrow(/release\.appSigningCertificate has an invalid value/);
    }
    const { release: _release, ...unreleased } = minimal;
    expect(() => validate(unreleased)).toThrow(/release is required/);
    const { root, put } = app();
    put('ci-tools.json', '{ not json');
    expect(() => config(root)).toThrow(/cannot read/);
  });
});

describe('ci-tools.json emulators', () => {
  const settings = (emulators) => ({ ...minimal, emulators: { ...minimal.emulators, ...emulators } });

  it('is required, with a base', () => {
    const { emulators: _emulators, ...portless } = minimal;
    expect(() => validate(portless)).toThrow(/emulators is required/);
    expect(() => validate({ ...minimal, emulators: {} })).toThrow(/emulators\.base is required/);
    expect(() => validate({ ...minimal, emulators: { base: 61900, project: 'demo-example' } })).toThrow(/unknown key emulators\.project/);
    expect(validate(minimal)).toEqual(minimal);
    expect(validate(full)).toEqual(full);
  });

  it('takes a whole block above the ephemeral range as the base', () => {
    for (const base of [61950, 60900, 65500, '61900', 1024]) {
      expect(() => validate(settings({ base })), String(base)).toThrow(/emulators\.base must be a multiple of 100 from 61000 to 65400/);
    }
  });

  it('runs under demo-sabeel-<name>, so the name must make a project id', () => {
    expect(emulatorProject(full)).toBe('demo-sabeel-example');
    for (const name of ['Example', 'time_tracker', 'time-', '-lms', 'a'.repeat(19), '']) {
      expect(() => validate({ ...minimal, name }), name).toThrow(/name must be lowercase words joined by hyphens, at most 18 characters/);
    }
    expect(validate({ ...minimal, name: 'time-tracker', emulators: { base: 61000 } }).name).toBe('time-tracker');
  });

  it('keeps extras inside the block, clear of the layout and of each other', () => {
    expect(() => validate(settings({ extras: { store: 7 } }))).toThrow(/an extra takes an offset from 20 to 99/);
    expect(() => validate(settings({ extras: { store: 100 } }))).toThrow(/an extra takes an offset from 20 to 99/);
    expect(() => validate(settings({ extras: { web: 30 } }))).toThrow(/names web, which the layout already places at \+10/);
    expect(() => validate(settings({ extras: { store: 20, admin: 20 } }))).toThrow(/puts admin and store both at \+20/);
    expect(() => validate(settings({ extras: { 'Store-1': 20 } }))).toThrow(/camelCase/);
    expect(() => validate(settings({ functionsWrapper: 'node wrap.mjs' }))).toThrow(/a command as a list of words/);
  });

  it("refuses another checkout's block, or a block other than the project's own", () => {
    expect(() => validate(settings({ base: 61200 }))).toThrow(/61200 is the block of demo-sabeel-kanban, not of demo-sabeel-example/);
    expect(() => validate(settings({ base: 61100 }))).toThrow(/legacy sabeel-recording-app/);
    expect(() => validate({ ...minimal, name: 'lms' })).toThrow(/demo-sabeel-lms \(name lms\) owns the block at 61300, not 61900/);
    expect(validate({ ...minimal, name: 'lms', emulators: { base: 61300 } }).emulators.base).toBe(61300);
  });
});

describe('the port layout', () => {
  it('computes every port from the base, the extras after the layout', () => {
    const all = ports(full);
    expect(all).toMatchObject({ firestore: 61900, firestoreWebsocket: 61901, auth: 61902, functions: 61903, ui: 61904, hub: 61905,
      logging: 61906, storage: 61907, tasks: 61908, eventarc: 61909, web: 61910, sweep: 61911, proxy: 61912, store: 61920, storeAdmin: 61921 });
    expect(ports(minimal).store).toBeUndefined();
  });

  it('frees the suite and the extras, never a dev server and never outside the block', () => {
    expect(suitePorts(full)).toEqual([61900, 61901, 61902, 61903, 61904, 61905, 61906, 61907, 61908, 61909, 61920, 61921]);
    expect(suitePorts(minimal)).toEqual([61900, 61901, 61902, 61903, 61904, 61905, 61906, 61907, 61908, 61909]);
  });
});

describe('sabeel-ci', () => {
  const run = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });

  it('runs a command at the app root, from any directory inside it', () => {
    const { root } = app();
    mkdirSync(join(root, 'app/src'), { recursive: true });
    const result = run(join(root, 'app/src'), 'check-app');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('names the commands when asked for one it does not have', () => {
    const { root } = app();
    const result = run(root, 'deploy-everything');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no command "deploy-everything".*check-app/);
    expect(run(root, '../bin/sabeel-ci').status).toBe(2);
  });

  it('refuses to run outside an app repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ci-tools-outside-'));
    fixtures.push(outside);
    const result = run(outside, 'check-app');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no ci-tools\.json/);
  });
});

describe('the shared workflows', () => {
  it('expand a partial at the indentation it is named at', () => {
    expect(expand('steps:\n  # ci-tools: two\n  - run: x\n', () => '- run: a\n  if: b\n'))
      .toBe('steps:\n  - run: a\n    if: b\n  - run: x\n');
  });

  it('include a partial when a setting is on, or off, and fill in values', () => {
    const partial = (name) => ({ media: '- run: media\n', plain: '- run: {{ci-tools.name}}\n' })[name];
    const template = 'steps:\n  # ci-tools: media if name\n  # ci-tools: plain if !name\n  - run: echo {{ci-tools.name}}\n';
    expect(expand(template, partial, { name: 'lms' })).toBe('steps:\n  - run: media\n  - run: echo lms\n');
    expect(() => expand('# ci-tools: media if nmae\n', partial, { name: 'lms' })).toThrow(/does not declare/);
    expect(() => expand('{{ci-tools.nmae}}', partial, { name: 'lms' })).toThrow(/does not declare/);
    expect(() => expand('{{ci-tools.name}}', partial, {})).toThrow(/does not set/);
  });

  it('name where they come from, and leave no directive unexpanded', () => {
    for (const [name, text] of renderAll(full)) {
      expect(text.startsWith(`# Rendered from Sabeel-Institute/ci-tools workflows/${name} by\n`)).toBe(true);
      expect(text).not.toMatch(/# ci-tools:/);
    }
  });

  it('fetch ci-tools before any job runs it, at the pinned commit and only from main', () => {
    for (const [name, text] of renderAll(full)) {
      for (const job of text.split(/\n(?= {2}[a-z0-9-]+:\n)/).slice(1)) {
        if (!job.includes('sabeel-ci ')) continue;
        const fetch = job.indexOf('ci-tools, at the commit package-lock.json pins');
        expect(fetch, `${name}: ${job.slice(0, 40)}`).toBeGreaterThan(-1);
        expect(fetch).toBeLessThan(job.indexOf('sabeel-ci '));
      }
    }
    const step = renderAll(full).get('android.yml');
    expect(step).toContain('merge-base --is-ancestor "$sha" origin/main');
    expect(step).toContain('--ignore-scripts');
  });

  it('report every drifted, missing or orphaned file', () => {
    const { root, put } = app();
    expect(drift(root)).toEqual([]);
    put('.github/workflows/web.yml', 'edited by hand\n');
    rmSync(join(root, '.github/workflows/android.yml'));
    put('.github/workflows/old.yml', '# Rendered from Sabeel-Institute/ci-tools workflows/old.yml by\n');
    put('.github/workflows/app-only.yml', 'the app\'s own\n');
    expect(drift(root)).toEqual([
      '.github/workflows/android.yml is missing',
      '.github/workflows/web.yml differs from ci-tools workflows/web.yml',
      '.github/workflows/old.yml was rendered from a template ci-tools no longer has',
    ]);
  });
});

describe('check-app', () => {
  it('passes an app that meets what ci-tools assumes', () => {
    expect(problems(app().root)).toEqual([]);
  });

  it('reports a secret or stamp Git would pick up, bad identifiers, unrecorded release and stale functions lock', () => {
    const { root, put } = app();
    put('.gitignore', '.env.local\n.env.sentry-build-plugin\n');
    put('app/app.json', { expo: { version: '0.3.0', android: { package: 'com.example.app' }, ios: { bundleIdentifier: '<key>bad</key>', buildNumber: '3000' } } });
    put('docs/USER-MANUAL.md', '# Manual\n\n*For app version 0.3.0 · October 2026*\n');
    put('functions/package.json', { dependencies: { a: '^1.1.0' }, devDependencies: { b: '^2.0.0' } });
    expect(problems(root)).toEqual([
      expect.stringMatching(/does not cover app\/android\/keystore\.properties/),
      '.gitignore does not cover *.jks (release.jks, say): a key committed to a public repository stays readable in its history',
      expect.stringMatching(/does not cover \*\.keystore \(app\/android\/app\/release\.keystore, say\)/),
      expect.stringMatching(/does not cover \*service-account\*\.json/),
      expect.stringMatching(/does not cover \*firebase-adminsdk\*\.json/),
      expect.stringMatching(/does not cover app\/src\/build-info\.ts, which every build writes/),
      expect.stringMatching(/does not cover functions\/\.secret\.local, which sabeel-ci writes for the emulators/),
      expect.stringMatching(/identifier/),
      expect.stringMatching(/no deploy-log entry for v0\.3\.0/),
      expect.stringMatching(/out of step/),
    ]);
    expect(readFileSync(join(root, 'ci-tools.json'), 'utf8')).toContain('example');
  });

  it('reports a build.gradle that applies sentry.gradle other than exactly when the build machine\'s file exists', () => {
    const { root, put } = app();
    const message = /^app\/android\/app\/build\.gradle must apply sentry\.gradle exactly when app\/\.env\.sentry-build-plugin exists/;
    const versions = '        versionCode computedVersionCode\n        versionName expoVersion\n';
    const withSentry = (block) => SIGNING.replace(SENTRY_GRADLE, block) + versions;
    for (const block of [
      '',
      SENTRY_GRADLE.replace('$projectRoot/.env.sentry-build-plugin', '${rootProject.projectDir}/sentry.properties'),
      SENTRY_GRADLE.replace('file("$projectRoot/.env.sentry-build-plugin").exists()', 'System.getenv("SENTRY_AUTH_TOKEN")'),
      SENTRY_GRADLE.replace('.exists()) {', '.exists() || System.getenv("SENTRY_AUTH_TOKEN")) {'),
      SENTRY_GRADLE + 'apply from: "../sentry.gradle"\n',
    ]) {
      put('app/android/app/build.gradle', withSentry(block));
      expect(problems(root), block).toEqual([expect.stringMatching(message)]);
    }
    put('app/android/app/build.gradle', withSentry(SENTRY_GRADLE.replace('{\n', '{\n\n') + '} else {\n    logger.warn("no upload")\n}\n'));
    expect(problems(root)).toEqual([]);
  });

  it('reports bundles without debug ids, and Sentry DSNs read under other names', () => {
    const { root, put } = app();
    put('app/metro.config.js', "const { getDefaultConfig } = require('expo/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n");
    put('app/src/sentry.ts', 'const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN_ANDROID;\n');
    put('app/src/sentry.test.ts', 'process.env.EXPO_PUBLIC_SENTRY_DSN = "x";\n');
    expect(problems(root)).toEqual([
      'app/metro.config.js does not build on getSentryExpoConfig from @sentry/react-native/metro, so its bundles carry no debug ids for Sentry to match their source maps by',
      'app/src reads EXPO_PUBLIC_SENTRY_DSN_ANDROID; the Sentry DSNs are EXPO_PUBLIC_SENTRY_DSN_NATIVE (Android and iOS) and EXPO_PUBLIC_SENTRY_DSN_WEB (web)',
      'app/src never reads EXPO_PUBLIC_SENTRY_DSN_NATIVE, which the release builds require in app/.env.local',
    ]);
  });

  it('reports a build.gradle that would package a release it cannot sign', () => {
    const { root, put } = app();
    const versions = '        versionCode computedVersionCode\n        versionName expoVersion\n';
    const message = /^app\/android\/app\/build\.gradle does not stop a release it cannot sign[\s\S]*gradle\.taskGraph\.whenReady \{ graph ->/;
    for (const gradle of [
      SIGNING.replace(RELEASE_KEY, ''),
      SIGNING.replace('releaseSigning.storeFile == null', 'true'),
      SIGNING.replace('releaseSigning != null && ', ''),
      SIGNING.replace('/^(package|sign)Release(Bundle)?$/', '/^packageRelease$/'),
      SIGNING.replace(/throw new GradleException\(.*\)/, 'logger.warn("unsigned")'),
    ]) {
      put('app/android/app/build.gradle', gradle + versions);
      expect(problems(root), gradle).toEqual([expect.stringMatching(message)]);
    }
  });

  it('holds the Hosting site to one shape: security headers, immutable assets, the SPA rewrite, a default project', () => {
    const { root, put } = app();
    const hosting = (change) => {
      const site = structuredClone(HOSTING);
      change(site);
      put('firebase.json', { hosting: site, emulators: FIREBASE_EMULATORS });
      return hostingProblems(root);
    };
    expect(hosting(() => {})).toEqual([]);
    expect(hosting((site) => { site.headers.splice(1, 1); })).toEqual([
      "firebase.json hosting has no headers rule for !/__/**, every page but Firebase's own: it sets X-Frame-Options: DENY, "
        + "Content-Security-Policy: frame-ancestors 'none', X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin",
    ]);
    expect(hosting((site) => {
      site.headers[1].headers[0].value = 'SAMEORIGIN';
      site.headers[1].headers[1].value = "default-src 'self'; frame-ancestors 'none'";
      site.headers[1].headers.pop();
      site.headers[0].headers.push({ key: 'X-Frame-Options', value: 'SAMEORIGIN' });
    })).toEqual([
      'firebase.json hosting does not set X-Frame-Options: DENY on !/__/** (it sets "SAMEORIGIN")',
      'firebase.json hosting does not set Referrer-Policy: strict-origin-when-cross-origin on !/__/**',
      "firebase.json hosting sets X-Frame-Options on **; set it on !/__/** only, so Firebase's own /__/ pages, which sign-in frames, keep working",
    ]);
    expect(hosting((site) => { site.headers.pop(); site.rewrites[1].source = '**'; })).toEqual([
      'firebase.json hosting does not cache /assets/** as "public, max-age=31536000, immutable": its files are named by their content',
      'firebase.json hosting must rewrite to /index.html from "!/_expo/**" alone, so a missing chunk under /_expo/ is a 404 rather than index.html served as JavaScript (it rewrites from "**")',
    ]);
    put('firebase.json', { hosting: [HOSTING], emulators: FIREBASE_EMULATORS });
    expect(hostingProblems(root)).toEqual(['firebase.json must have one Hosting site, an object under "hosting": Deploy Web publishes one']);
    put('firebase.json', { hosting: HOSTING, emulators: FIREBASE_EMULATORS });
    put('.firebaserc', { projects: { dev: 'example-project' } });
    expect(problems(root)).toEqual(['.firebaserc has no "default" project alias (it has dev): firebase and the push checks use the default']);
  });

  it("holds Android's default notification channel to the one the functions send on", () => {
    const { root, put } = app();
    put('app/android/app/src/main/AndroidManifest.xml', MANIFEST('<meta-data android:value="sabeel-alerts" android:name="com.google.firebase.messaging.default_notification_channel_id" />'));
    expect(pushChannelProblems(root)).toEqual([]);
    put('app/android/app/src/main/AndroidManifest.xml', MANIFEST(CHANNEL.replace('sabeel-alerts', 'alerts')));
    expect(pushChannelProblems(root)).toEqual([
      'app/android/app/src/main/AndroidManifest.xml makes alerts the default notification channel; the functions send on PUSH_CHANNEL_ID sabeel-alerts',
    ]);
    put('app/android/app/src/main/AndroidManifest.xml', MANIFEST('<meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic"/>'));
    expect(problems(root)).toEqual([
      'app/android/app/src/main/AndroidManifest.xml has no com.google.firebase.messaging.default_notification_channel_id meta-data, '
        + 'so a push sent without a channel lands in Android\'s "Miscellaneous":\n'
        + '    <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="sabeel-alerts"/>',
    ]);
    rmSync(join(root, 'packages/shared/src/notify.ts'));
    expect(pushChannelProblems(root)).toEqual(['packages/shared/src must export one PUSH_CHANNEL_ID, the channel the functions send on; it exports 0']);
  });

  it('holds the google-services Gradle plugin at one version', () => {
    const { root, put } = app();
    put('app/android/build.gradle', "buildscript {\n  dependencies {\n    classpath('com.google.gms:google-services:4.4.2')\n  }\n}\n");
    expect(problems(root)).toEqual(['app/android/build.gradle takes the google-services Gradle plugin at 4.4.2; every app builds with 4.4.4']);
    put('app/android/build.gradle', 'buildscript {}\n');
    expect(problems(root)).toEqual(['app/android/build.gradle names no com.google.gms:google-services plugin; every app builds with 4.4.4']);
  });

  it("reports the emulators' secrets file committed", () => {
    const { root, put } = app();
    put('functions/.secret.local', 'SENTRY_DSN=disabled\n');
    execFileSync('git', ['add', '--force', 'functions/.secret.local'], { cwd: root });
    expect(problems(root)).toEqual([
      'functions/.secret.local is committed; sabeel-ci writes it from ci.emulatorSecrets, so the app keeps no copy: git rm --cached functions/.secret.local',
    ]);
  });

  it('reports a build.gradle that does not take the release key from SABEEL_KEYSTORE_PROPERTIES', () => {
    const { root, put } = app();
    put('app/android/app/build.gradle', SIGNING.replace('SABEEL_KEYSTORE', 'SABEEL_LMS_KEYSTORE') + '        versionCode computedVersionCode\n        versionName expoVersion\n');
    expect(problems(root)).toEqual([
      "app/android/app/build.gradle does not read the release key's properties from System.getenv('SABEEL_KEYSTORE_PROPERTIES')",
      'app/android/app/build.gradle names SABEEL_LMS_KEYSTORE_PROPERTIES; the variable is SABEEL_KEYSTORE_PROPERTIES',
    ]);
  });

  it('reports an app whose own Dependabot updates the rendered workflows', () => {
    const { root, put } = app();
    const npm = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n';
    put('.github/dependabot.yml', npm);
    expect(problems(root)).toEqual([]);
    put('.github/dependabot.yml', `${npm}  - package-ecosystem: "github-actions"\n    directory: /\n`);
    expect(problems(root)).toEqual([
      '.github/dependabot.yml updates github-actions, but the workflows are rendered from ci-tools, whose Dependabot updates them: remove that entry',
    ]);
  });

  it('reports a flow that does not take its app from native-e2e, and flows with no seed', () => {
    const { root, put } = app();
    put('maestro/board.yaml', 'appId: ${APP_ID}\n---\n- launchApp\n');
    put('maestro/common/back.yaml', 'appId: ${APP_ID}\n---\n- back\n');
    expect(problems(root)).toEqual(['maestro/ holds flows, but there is no scripts/seed-emulators.mjs: native-e2e seeds the emulators for them with it']);
    put('scripts/seed-emulators.mjs', "import { emulatorProject } from '@sabeel-institute/ci-tools/lib/ports.mjs';\n");
    expect(problems(root)).toEqual([]);
    put('maestro/old.yaml', 'appId: com.sabeelinstitute.example\n---\n- launchApp\n');
    expect(problems(root)).toEqual(['maestro/old.yaml does not take its app from native-e2e: it must name it as appId: ${APP_ID}']);
  });

  it('reports a signing secret read outside release-build, in the app\'s own workflows too', () => {
    const { root, put } = app();
    put('.github/workflows/app-only.yml', 'on: push\njobs:\n  test:\n    steps:\n      - run: x\n        env:\n          K: ${{ secrets.ASC_KEY_P8 }}\n');
    expect(problems(root)).toEqual(['app-only.yml job test reads ASC_KEY_P8 without entering the release-build environment']);
  });

  it('holds firebase.json to the ports ci-tools.json gives the app', () => {
    const { root, put } = app();
    put('firebase.json', { emulators: { ...FIREBASE_EMULATORS, auth: { port: 61802 }, firestore: { port: 61900 }, tasks: undefined,
      storage: {}, pubsub: { port: 61915 } } });
    expect(portProblems(root)).toEqual([
      "firebase.json pins auth to 61802; this app's auth port is 61902",
      "firebase.json pins storage to no port; this app's storage port is 61907",
      'firebase.json runs the pubsub emulator, which the ci-tools port layout has no place for (lib/ports.mjs LAYOUT)',
      "firebase.json does not pin tasks: every run starts it, and unpinned it takes Firebase's default port, which other checkouts take too",
      "firebase.json pins firestore.websocketPort to no port; this app's is 61901 (unpinned it is 9150, and moves on a collision)",
    ]);
    put('firebase.json', { hosting: {} });
    expect(portProblems(root)).toContain('firebase.json has no emulators section');
  });

  it('holds the client bundle to the same ports, and to every emulator firebase.json runs', () => {
    const { root, put } = app();
    put('app/src/env.ts', 'export const EMULATOR_PORTS = { auth: 61202, firestore: 61900, functions: 61903 } as const;\n');
    expect(portProblems(root)).toEqual([
      "app/src/env.ts connects auth to 61202; this app's auth port is 61902",
      'app/src/env.ts EMULATOR_PORTS has no storage, which firebase.json runs: the app would not use that emulator',
    ]);
    put('app/src/env.ts', 'export const PORTS = {};\n');
    expect(portProblems(root)).toEqual(['app/src/env.ts has no EMULATOR_PORTS = { … }, the ports the app connects to']);
  });

  it('finds a port stated in a script, a default or a sibling\'s port, and another emulator project', () => {
    const { root, put } = app();
    put('scripts/lib/stack.sh', 'WEB_PORT=61910\nwait_for http://127.0.0.1:61900/\nfirebase emulators:exec --project demo-sabeel-kanban "x"\n');
    put('scripts/old.mjs', "// FIRESTORE_EMULATOR_HOST=localhost:8080, auth on 10.0.2.2:9099\nfetch('http://127.0.0.1:61203/');\n");
    put('package.json', { scripts: { 'dev:web': 'expo start --web --port 61910' } });
    expect(portProblems(root)).toEqual([
      'scripts/lib/stack.sh states 61900 (firestore), 61910 (web): read ports from ci-tools instead (`sabeel-ci ports <name>`, ports() in Node)',
      "scripts/lib/stack.sh passes --project demo-sabeel-kanban; this app's emulator project is demo-sabeel-example",
      "scripts/old.mjs names 8080, 9099: Firebase defaults or given-up ports, not this app's",
      "scripts/old.mjs names 61203, outside this app's block 61900-61999: another checkout's",
      'package.json states 61910 (web): read ports from ci-tools instead (`sabeel-ci ports <name>`, ports() in Node)',
    ]);
  });

  it('holds the emulator project the app and the functions check for to ci-tools.json', () => {
    const { root, put } = app();
    put('packages/shared/src/constants.ts', "export const EMULATOR_PROJECT_ID = 'demo-sabeel';\n");
    put('functions/.env.demo-sabeel', 'MEDIA_BUCKET=local\n');
    expect(portProblems(root)).toEqual([
      "packages/shared/src/constants.ts says the emulator project is demo-sabeel; this app's is demo-sabeel-example, demo-sabeel-<name> from ci-tools.json",
      'functions/.env.demo-sabeel is for another project: the Functions emulator reads functions/.env.demo-sabeel-example',
    ]);
  });

  it("reports every place the version is written that disagrees with app.json's", () => {
    const { root, put } = app();
    put('app/app.json', { expo: { version: '0.2.2', android: { package: 'com.sabeelinstitute.example', versionCode: 39 }, ios: { bundleIdentifier: 'com.sabeelinstitute.example', buildNumber: '6' } } });
    put('app/android/app/build.gradle', SIGNING + '        versionCode 39\n        versionName "0.2.2"\n');
    put('docs/PHASE_STATUS.md', '## Deploy log\n\n### 2026-10-22 — The next release — v0.2.2\n\n### 2026-10-21 — The example release — v0.2.1\n');
    const found = problems(root);
    expect(found).toHaveLength(3);
    expect(found[0]).toMatch(/build\.gradle must derive the version from app\.json/);
    expect(found[1]).toMatch(/expo\.ios\.buildNumber is "6"; version 0\.2\.2's is "2002"/);
    expect(found[2]).toMatch(/USER-MANUAL\.md says "For app version 0\.2\.1", app\/app\.json 0\.2\.2/);
    put('app/android/app/build.gradle', SIGNING + '        versionCode computedVersionCode\n        versionName expoVersion\n');
    expect(problems(root)[0]).toMatch(/states android\.versionCode 39; remove it/);
    put('app/app.json', { expo: { version: '0.2.2-beta.1', android: { package: 'com.sabeelinstitute.example' }, ios: { bundleIdentifier: 'com.sabeelinstitute.example' } } });
    expect(problems(root)).toEqual([expect.stringMatching(/^app\/app\.json's expo\.version: "0\.2\.2-beta\.1" is not three/)]);
  });
});
