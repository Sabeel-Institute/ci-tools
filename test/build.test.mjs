import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { selfTest } from '../scripts/check-version.mjs';
import { controlByte } from '../scripts/check-text-sources.mjs';
import { deployNotes } from '../scripts/deploy-notes.mjs';
import { foreignHolders } from '../scripts/preflight-metro.mjs';
import { vapidKey } from './fixtures/push.mjs';
import full from './fixtures/full.json' with { type: 'json' };

const scripts = resolve(import.meta.dirname, '../scripts');
const dsn = 'https://fixturekey@sentry.example.test/1';
const certificate = 'ab'.repeat(32);
const fixtures = [];
const children = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const git = (root, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
  '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();

/**
 * An app repository, committed and clean, ready for every build check, with
 * Gradle, Expo's export and the JDK's tools faked. The faked Gradle and export
 * bundle app/src/build-info.ts as it stands, as Metro would; calls.log records
 * what ran.
 */
function app({ version = '0.2.0' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-tools-build-')));
  fixtures.push(root);
  const put = (path, value, mode = 0o644) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode });
  };
  put('ci-tools.json', full);
  put('.gitignore', 'app/src/build-info.ts\napp/.env.local\napp/dist-web/\napp/android/app/build/\nbin/\ncalls.log\nrunner/\n');
  put('app/app.json', { expo: { version, android: { package: 'com.sabeelinstitute.example' } } });
  put('app/android/app/build.gradle', 'versionCode computedVersionCode\nversionName expoVersion\n');
  put('app/src/App.tsx', "import { BUILD_INFO } from './build-info';\n");
  put('docs/PHASE_STATUS.md', `# Phase status\n\n## Deploy log\n\n### 2026-10-21 — The fixture release — v${version}\n\nWhat ${version} holds.\n\n### 2026-10-01 — The one before — v0.1.9\n\nOlder.\n`);
  put('app/.env.local', `EXPO_PUBLIC_SENTRY_DSN_NATIVE=${dsn}\n`);
  put('app/android/gradlew', `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('../../calls.log', 'gradlew ' + process.argv.slice(2).join(' ') + '\\n');
fs.mkdirSync('app/build/outputs/bundle/release', { recursive: true });
fs.writeFileSync('app/build/outputs/bundle/release/app-release.aab', fs.readFileSync('../src/build-info.ts'));
`, 0o755);
  put('bin/npx', `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('../calls.log', 'npx ' + process.argv.slice(2).join(' ') + '\\n');
fs.mkdirSync('dist-web/_expo/static/js/web', { recursive: true });
fs.writeFileSync('dist-web/index.html', '<div id="root"></div><script src="/_expo/static/js/web/entry.js" defer></script>');
const vapid = process.env.FAKE_NO_VAPID ? '' : ${JSON.stringify(vapidKey())};
fs.writeFileSync('dist-web/_expo/static/js/web/entry.js', (process.env.FAKE_STALE ? 'stale' : fs.readFileSync('src/build-info.ts')) + 'var v="' + vapid + '";');
`, 0o755);
  put('bin/jarsigner', `#!/usr/bin/env node
const signer = process.env.FAKE_SIGNER ?? 'CN=Sabeel Institute, O=Sabeel Institute';
if (process.argv.includes('-certs') && signer) process.stdout.write('- Signed by "' + signer + '"\\n');
`, 0o755);
  put('bin/keytool', `#!/usr/bin/env node\nprocess.stdout.write('SHA256: ${certificate.toUpperCase()}\\n');\n`, 0o755);
  put('bin/unzip', "#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(process.argv[3]));\n", 0o755);
  git(root, 'init', '--quiet');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  const run = (script, args = [], env = {}) => spawnSync(process.execPath, [join(scripts, `${script}.mjs`), ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: join(root, 'runner'), ...env },
  });
  const calls = () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n') : []);
  const read = (path) => readFileSync(join(root, path), 'utf8');
  return { root, put, run, calls, read, commit: () => git(root, 'rev-parse', '--short', 'HEAD') };
}

describe('build-info', () => {
  it("stamps app.json's version and HEAD's commit, marking a dirty tree", () => {
    const test = app();
    expect(test.run('build-info').status).toBe(0);
    const stamp = test.read('app/src/build-info.ts');
    expect(stamp).toContain(`export const BUILD_INFO = { version: "0.2.0", commit: "${test.commit()}" } as const;`);
    test.put('app/src/App.tsx', '// edited\n');
    test.run('build-info');
    expect(test.read('app/src/build-info.ts')).toContain(`commit: "${test.commit()}+"`);
  });

  it('stamps dev outside a Git checkout, and quotes whatever app.json holds', () => {
    const test = app();
    rmSync(join(test.root, '.git'), { recursive: true });
    test.put('app/app.json', { expo: { version: "0.2.0' } as never; //", android: { package: 'x' } } });
    test.run('build-info');
    expect(test.read('app/src/build-info.ts')).toContain('{ version: "0.2.0\' } as never; //", commit: "dev" }');
  });

  it('leaves an unchanged stamp alone, so nothing rebuilds for it', () => {
    const test = app();
    test.run('build-info');
    const path = join(test.root, 'app/src/build-info.ts');
    utimesSync(path, 1e9, 1e9);
    test.run('build-info');
    expect(statSync(path).mtimeMs).toBe(1e12);
  });
});

describe('check-version', () => {
  it('proves its own rules before it judges the app', () => {
    expect(() => selfTest()).not.toThrow();
  });

  it('passes a good app and names what is wrong with a bad one', () => {
    const test = app();
    const good = test.run('check-version');
    expect(good.status).toBe(0);
    expect(good.stdout).toMatch(/version ok \(0\.2\.0, store-legal, versionCode 2000; 10 bad shapes self-tested\)/);
    test.put('app/app.json', { expo: { version: '0.3.0-beta.1', android: { package: 'x' } } });
    const bad = test.run('check-version');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/version check FAILED[\s\S]*"0\.3\.0-beta\.1" is not three period-separated integers/);
    test.put('app/app.json', { expo: { version: '0.3.0', android: { package: 'x', versionCode: 5 } } });
    expect(test.run('check-version').stderr).toMatch(/app\/app\.json states android\.versionCode 5; remove it/);
    expect(test.run('check-version', ['--strict']).status).toBe(2);
  });
});

describe('deploy-notes', () => {
  const log = '## Deploy log\n\n### 2026-10-21 — Maintenance — v0.12.20\n\nNot this one.\n\n'
    + '### 2026-10-17 — Android stops waiting — v0.12.2\n\n- one\n- two\n#### Detail\nkept\n\n### 2026-10-16 — Older — v0.12.1\n\nolder\n';

  it("finds a version's newest entry, its title and its body", () => {
    expect(deployNotes(log, '0.12.2')).toEqual({ title: 'v0.12.2 — Android stops waiting', body: '- one\n- two\n#### Detail\nkept' });
    expect(deployNotes(log, '0.12.1').body).toBe('older');
    expect(deployNotes(log, '0.12')).toBeNull();
    expect(deployNotes('### 2026-10-21 — Patch — v0.12.2.\n', '0.12.2')).toEqual({ title: 'v0.12.2 — Patch', body: '' });
    expect(deployNotes(log, '0.1.2')).toBeNull();
  });

  it('prints the notes, and refuses a version without an entry or a malformed request', () => {
    const test = app();
    expect(test.run('deploy-notes', ['0.2.0']).stdout.trim()).toBe('What 0.2.0 holds.');
    expect(test.run('deploy-notes', ['0.2.0', '--title']).stdout.trim()).toBe('v0.2.0 — The fixture release');
    const missing = test.run('deploy-notes', ['0.3.0']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no deploy-log entry for v0\.3\.0/);
    for (const args of [[], ['v0.2.0'], ['0.2.0', '--titel'], ['0.2.0', '--title', 'x']]) expect(test.run('deploy-notes', args).status).toBe(2);
  });
});

describe('check-text-sources', () => {
  it('finds the first control byte, and allows tab, LF, VT, FF and CR', () => {
    expect(controlByte(Buffer.from('a\tb\r\n\v\fc'))).toBeNull();
    expect(controlByte(Buffer.from('ab\0c'))).toEqual({ index: 2, byte: 0 });
    expect(controlByte(Buffer.from('a\x1bb'))).toEqual({ index: 1, byte: 0x1b });
  });

  it('fails on a tracked source with a NUL, naming its line, and ignores what Git does not track', () => {
    const test = app();
    expect(test.run('check-text-sources').stdout).toMatch(/files, all plain text/);
    test.put('notes.txt', 'binary\0 is fine here\n');
    test.put('scratch.ts', 'untracked\0\n');
    expect(test.run('check-text-sources').status).toBe(0);
    test.put('app/src/keys.ts', 'const a = 1;\nconst b = 2;\nconst separator = "\0";\n');
    git(test.root, 'add', 'app/src/keys.ts');
    const result = test.run('check-text-sources');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('app/src/keys.ts:3  byte 0x00');
  });
});

describe('preflight-metro', () => {
  it("counts a holder outside the app, or one it cannot read, as another project's", () => {
    const cwd = { 1: '/repo/app', 2: '/repo/app/src', 3: '/repo/application', 4: '/other/app', 5: null };
    expect(foreignHolders(['1', '2', '3', '4', '5'], '/repo/app', (pid) => cwd[pid]).map(({ pid }) => pid)).toEqual(['3', '4', '5']);
  });

  it.skipIf(process.platform === 'darwin')('refuses a port 8081 held from elsewhere, and lets its own Metro be', () => {
    const test = app();
    const ours = spawn('sleep', ['30'], { cwd: join(test.root, 'app') });
    children.push(ours);
    const ss = (pid) => test.put('bin/ss', `#!/bin/sh\necho 'LISTEN 0 511 *:8081 *:* users:(("node",pid=${pid},fd=20))'\n`, 0o755);
    ss(ours.pid);
    expect(test.run('preflight-metro').status).toBe(0);
    ss(process.pid);
    const elsewhere = test.run('preflight-metro');
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stderr).toContain(`pid ${process.pid}  ${process.cwd()}`);
    ss(2 ** 22 + 1);
    expect(test.run('preflight-metro').stderr).toMatch(/working directory unreadable/);
  });
});

describe('build-aab', () => {
  it('checks, stamps the commit, builds, and reads the signature', () => {
    const test = app();
    const result = test.run('build-aab');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(test.calls()).toEqual(['gradlew bundleRelease --no-daemon']);
    expect(test.read('app/android/app/build/outputs/bundle/release/app-release.aab')).toContain(`commit: "${test.commit()}"`);
    expect(result.stdout).toMatch(/version {4}0\.2\.0 \(versionCode 2000\)/);
    expect(result.stdout).toContain('signed by  CN=Sabeel Institute');
  });

  it('refuses before Gradle runs, naming every problem, and never prints the DSN', () => {
    const test = app();
    test.put('app/app.json', { expo: { version: '0.3.0', android: { package: 'x' } } });
    test.put('app/.env.local', `EXPO_PUBLIC_SENTRY_DSN_WEB=${dsn}\n`);
    const result = test.run('build-aab');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no deploy-log entry for v0\.3\.0[\s\S]*has no EXPO_PUBLIC_SENTRY_DSN_NATIVE/);
    expect(result.stderr).not.toContain('fixturekey');
    expect(test.calls()).toEqual([]);
    test.put('app/.env.local', 'EXPO_PUBLIC_SENTRY_DSN_NATIVE="not-a-dsn-secret"\n');
    const malformed = test.run('build-aab', ['--check']);
    expect(malformed.stderr).toMatch(/does not look like a Sentry DSN/);
    expect(malformed.stderr + malformed.stdout).not.toMatch(/not-a-dsn-secret|fixturekey/);
    rmSync(join(test.root, 'app/.env.local'));
    expect(test.run('build-aab', ['--check']).stderr).toMatch(/app\/\.env\.local has no EXPO_PUBLIC_SENTRY_DSN_NATIVE/);
    expect(test.calls()).toEqual([]);
  });

  it('with --check, checks and builds nothing', () => {
    const test = app();
    const result = test.run('build-aab', ['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/v0\.2\.0 may be built; nothing was built/);
    expect(test.calls()).toEqual([]);
    expect(existsSync(join(test.root, 'app/src/build-info.ts'))).toBe(false);
    expect(test.run('build-aab', ['--chek']).status).toBe(2);
  });

  it('refuses a bundle that is unsigned or signed with the debug key', () => {
    const test = app();
    const debug = test.run('build-aab', [], { FAKE_SIGNER: 'CN=Android Debug, O=Android, C=US' });
    expect(debug.status).toBe(1);
    expect(debug.stderr).toMatch(/REFUSING: .* is signed with the DEBUG key \(CN=Android Debug[\s\S]*never generate a new one/);
    expect(test.run('build-aab', [], { FAKE_SIGNER: '' }).stderr).toMatch(/is not signed/);
  });
});

describe('build-web', () => {
  it('checks the version, stamps the commit and exports with a cleared cache', () => {
    const test = app();
    const result = test.run('build-web');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`app/dist-web: v0.2.0 · ${test.commit()}`);
    test.run('build-web', ['--source-maps']);
    expect(test.calls()).toEqual([
      'npx --no-install expo export --platform web --output-dir dist-web --clear',
      'npx --no-install expo export --platform web --output-dir dist-web --clear --source-maps',
    ]);
    expect(test.run('build-web', ['--maps']).status).toBe(2);
  });

  it('refuses an illegal version before exporting, and an export without the stamp after', () => {
    const test = app();
    test.put('app/app.json', { expo: { version: 'v1.0.0', android: { package: 'x' } } });
    expect(test.run('build-web').stderr).toMatch(/version check FAILED/);
    expect(test.calls()).toEqual([]);
    test.put('app/app.json', { expo: { version: '0.2.0', android: { package: 'x' } } });
    const stale = test.run('build-web', [], { FAKE_STALE: '1' });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/does not carry the stamped commit/);
  });
});

describe('ci-platform builds', () => {
  const env = {
    ANDROID_SIGNING_CERT_SHA256: certificate, GITHUB_REPOSITORY: 'Sabeel-Institute/test', GITHUB_REPOSITORY_ID: '123',
    GITHUB_RUN_ID: '456', GITHUB_REF: 'refs/heads/main',
  };

  it('build the Android bundle through build-aab and record it', () => {
    const test = app();
    const result = test.run('ci-platform', ['android'], env);
    expect(result.stderr).toBe('');
    expect(test.calls()).toEqual(['gradlew bundleRelease --no-daemon']);
    const record = JSON.parse(test.read('runner/android-artifact/build-record.json'));
    expect(record).toMatchObject({ platform: 'android', commit: git(test.root, 'rev-parse', 'HEAD'), signingCertificate: certificate });
  });

  it("refuse an Android build that misses build-aab's checks, or is dirty", () => {
    const test = app();
    test.put('docs/PHASE_STATUS.md', '## Deploy log\n');
    git(test.root, 'commit', '--quiet', '-am', 'no notes');
    expect(test.run('ci-platform', ['android'], env).stderr).toMatch(/no deploy-log entry for v0\.2\.0/);
    expect(test.calls()).toEqual([]);
    test.put('docs/PHASE_STATUS.md', '### 2026-10-21 — Notes — v0.2.0\n');
    expect(test.run('ci-platform', ['android'], env).stderr).toMatch(/AAB is marked as built from uncommitted changes/);
    expect(existsSync(join(test.root, 'runner/android-artifact/build-record.json'))).toBe(false);
  });

  it('build the web export through build-web and check its commit', () => {
    const test = app();
    expect(test.run('ci-platform', ['web'], env).stderr).toBe('');
    const record = JSON.parse(test.read('runner/web-artifact/build-record.json'));
    expect(Object.keys(record.files)).toEqual(['_expo/static/js/web/entry.js', 'index.html']);
    test.put('app/src/App.tsx', '// edited\n');
    expect(test.run('ci-platform', ['web'], env).stderr).toMatch(/Web export is marked as built from uncommitted changes/);
  });

  it('checks every web export for its VAPID key before it becomes the artifact', () => {
    const test = app();
    const result = test.run('ci-platform', ['web'], { ...env, FAKE_NO_VAPID: '1' });
    expect(result.stderr).toMatch(/check-web-push: no VAPID key/);
    expect(existsSync(join(test.root, 'runner/web-artifact'))).toBe(false);
    expect(test.run('ci-platform', ['web'], env).stdout).toContain('check-web-push: ok');
  });
});
