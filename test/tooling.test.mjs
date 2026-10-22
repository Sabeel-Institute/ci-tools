import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, findRoot, validate } from '../lib/config.mjs';
import { portProblems, problems } from '../scripts/check-app.mjs';
import { drift, expand, renderAll } from '../scripts/workflows.mjs';
import { ports, suitePorts } from '../lib/ports.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import minimal from './fixtures/minimal.json' with { type: 'json' };

const bin = fileURLToPath(new URL('../bin/sabeel-ci.mjs', import.meta.url));
/** How build.gradle finds the release key: the one variable ci-platform sets. */
const SIGNING = "    def releaseKeyFile = file(System.getenv('SABEEL_KEYSTORE_PROPERTIES') ?: \"${System.getProperty('user.home')}/.config/example/keystore.properties\")\n";
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
  put('.gitignore', '.env.local\n.env.sentry-build-plugin\napp/android/keystore.properties\napp/src/build-info.ts\n');
  put('app/app.json', { expo: { version: '0.2.1', android: { package: 'com.sabeelinstitute.example' }, ios: { bundleIdentifier: 'com.sabeelinstitute.example', buildNumber: '2001' } } });
  put('app/android/app/build.gradle', SIGNING + '        versionCode computedVersionCode\n        versionName expoVersion\n');
  put('docs/PHASE_STATUS.md', '## Deploy log\n\n### 2026-10-21 — The example release — v0.2.1\n');
  put('docs/USER-MANUAL.md', '# Manual\n\n*For app version 0.2.1 · October 2026*\n');
  put('functions/package.json', { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } });
  put('functions/package-lock.json', { packages: { '': { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } } } });
  put('functions/.env.demo-example', 'MEDIA_BUCKET=local\n');
  for (const [name, text] of renderAll(full)) put(`.github/workflows/${name}`, text);
  put('firebase.json', { emulators: FIREBASE_EMULATORS });
  put('app/src/env.ts', ENV_TS);
  put('packages/shared/src/constants.ts', "export const EMULATOR_PROJECT_ID = 'demo-example';\n");
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
    expect(() => validate({ ...minimal, name: '' })).toThrow(/invalid value/);
    expect(() => validate({ ...minimal, ci: { ...minimal.ci, mediaStroe: true } })).toThrow(/unknown key ci\.mediaStroe/);
    expect(() => validate({ ...minimal, ci: { ...minimal.ci, browserSuites: ['test:e2e'] } })).toThrow(/ci\.browserSuites/);
    expect(() => validate({ ...minimal, ci: { ...minimal.ci, emulatorSecrets: { SENTRY_DSN: "it's" } } })).toThrow(/ci\.emulatorSecrets/);
    const { build: _build, ...buildless } = minimal;
    expect(() => validate(buildless)).toThrow(/build is required/);
    expect(() => validate({ ...minimal, build: {} })).toThrow(/build\.sentryDsnVariable is required/);
    expect(() => validate({ ...minimal, build: { ...minimal.build, sentryDsn: 'x' } })).toThrow(/unknown key build\.sentryDsn;/);
    expect(() => validate({ ...minimal, build: { sentryDsnVariable: 'SENTRY_DSN' } })).toThrow(/build\.sentryDsnVariable has an invalid value/);
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

  it('is required, with a base and a project', () => {
    const { emulators: _emulators, ...portless } = minimal;
    expect(() => validate(portless)).toThrow(/emulators is required/);
    expect(() => validate({ ...minimal, emulators: { base: 61900 } })).toThrow(/emulators\.project is required/);
    expect(() => validate({ ...minimal, emulators: { project: 'demo-example' } })).toThrow(/emulators\.base is required/);
    expect(validate(minimal)).toEqual(minimal);
    expect(validate(full)).toEqual(full);
  });

  it('takes a whole block above the ephemeral range as the base', () => {
    for (const base of [61950, 60900, 65500, '61900', 1024]) {
      expect(() => validate(settings({ base })), String(base)).toThrow(/emulators\.base must be a multiple of 100 from 61000 to 65400/);
    }
  });

  it('takes only a demo- project, so the emulators never reach a real one', () => {
    expect(() => validate(settings({ project: 'oursabeel-lms' }))).toThrow(/emulators\.project must be a demo- project id/);
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
    expect(() => validate(settings({ base: 61200 }))).toThrow(/61200 is the block of demo-sabeel-kanban, not of demo-example/);
    expect(() => validate(settings({ base: 61100 }))).toThrow(/legacy sabeel-recording-app/);
    expect(() => validate(settings({ base: 61900, project: 'demo-sabeel' }))).toThrow(/demo-sabeel owns the block at 61000, not 61900/);
    expect(validate(settings({ base: 61000, project: 'demo-sabeel' })).emulators.base).toBe(61000);
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
    const found = problems(root);
    expect(found).toHaveLength(5);
    expect(found[0]).toMatch(/does not cover app\/android\/keystore\.properties/);
    expect(found[1]).toMatch(/does not cover app\/src\/build-info\.ts, which every build writes/);
    expect(found[2]).toMatch(/identifier/);
    expect(found[3]).toMatch(/no deploy-log entry for v0\.3\.0/);
    expect(found[4]).toMatch(/out of step/);
    expect(readFileSync(join(root, 'ci-tools.json'), 'utf8')).toContain('example');
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

  it('reports a flow that does not take its app from native-e2e', () => {
    const { root, put } = app();
    put('maestro/board.yaml', 'appId: ${APP_ID}\n---\n- launchApp\n');
    put('maestro/common/back.yaml', 'appId: ${APP_ID}\n---\n- back\n');
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
      "scripts/lib/stack.sh passes --project demo-sabeel-kanban; this app's emulator project is demo-example",
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
      'packages/shared/src/constants.ts says the emulator project is demo-sabeel; ci-tools.json emulators.project is demo-example',
      'functions/.env.demo-sabeel is for another project: the Functions emulator reads functions/.env.demo-example',
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
