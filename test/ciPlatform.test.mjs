import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { environmentValues, hostingConfig, treeHashes } from '../scripts/ci-platform.mjs';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };

const script = resolve(import.meta.dirname, '../scripts/ci-platform.mjs');
const commit = 'a'.repeat(40);
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-platform-'));
  fixtures.push(directory);
  const put = (path, value, mode = 0o600) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), value, { mode });
  };
  const run = (task, env = {}) => execFileSync(process.execPath, [script, task], {
    cwd: directory, encoding: 'utf8', stdio: 'pipe',
    env: {
      ...process.env, RUNNER_TEMP: directory, GITHUB_ENV: join(directory, 'github-env'),
      GITHUB_OUTPUT: join(directory, 'github-output'), APP_ENV_LOCAL: 'EXPO_PUBLIC_TEST=value\n',
      GITHUB_REPOSITORY: 'Sabeel-Institute/test', GITHUB_REPOSITORY_ID: '123', BUILD_RUN_ID: '456',
      PATH: `${join(directory, 'bin')}:${process.env.PATH}`, ...env,
    },
  });
  const api = (successfulCI = true) => {
    put('responses.json', JSON.stringify({
      run: { workflow_id: 789, status: 'completed', conclusion: 'success', head_branch: 'main',
        head_repository: { id: 123 }, event: 'push', head_sha: commit },
      workflow: { id: 789 },
      checks: { workflow_runs: [{ conclusion: successfulCI ? 'success' : 'failure', event: 'push',
        head_branch: 'main', head_repository: { id: 123 } }] },
    }));
    put('bin/gh', `#!/usr/bin/env node
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync('responses.json', 'utf8'));
const path = process.argv[3];
process.stdout.write(JSON.stringify(path.includes('ci.yml/runs') ? data.checks : path.endsWith('.yml') ? data.workflow : data.run));
`, 0o700);
  };
  put('bin/git', `#!/usr/bin/env node\nprocess.stdout.write('${commit}');\n`, 0o700);
  return { directory, put, run, api };
}

describe('platform build and deployment safety', () => {
  it('extracts quoted dotenv values without comments for masking', () => {
    expect(environmentValues('A="first=value"\nB=second # comment\n# ignored\nEMPTY=\n')).toEqual(['first=value', 'second']);
  });

  it('hashes files deterministically and rejects symlinks', () => {
    const test = fixture();
    test.put('site/index.html', 'site');
    test.put('site/assets/app.js', 'javascript');
    expect(Object.keys(treeHashes(join(test.directory, 'site')))).toEqual(['assets/app.js', 'index.html']);
    symlinkSync(join(test.directory, 'site/index.html'), join(test.directory, 'site/link'));
    expect(() => treeHashes(join(test.directory, 'site'))).toThrow(/symlink/);
  });

  it('isolates Hosting and never retains build/deploy hooks', () => {
    const configuration = hostingConfig({
      functions: { source: 'functions' }, firestore: { rules: 'firestore.rules' },
      hosting: { public: 'app/dist-web', predeploy: ['npm run build'], postdeploy: ['unsafe'], rewrites: [{ source: '**', destination: '/index.html' }] },
    }, '/tmp/prebuilt-site');
    expect(configuration).toEqual({
      hosting: { public: '/tmp/prebuilt-site', rewrites: [{ source: '**', destination: '/index.html' }] },
    });
    expect(() => hostingConfig({ hosting: [] }, '/tmp/site')).toThrow();
  });

  it('restores signing with private permissions and replaces machine-specific paths', () => {
    const test = fixture();
    const output = test.run('prepare-android', {
      ANDROID_KEYSTORE: Buffer.from('fixture key').toString('base64'),
      ANDROID_KEYSTORE_PROPERTIES: 'storeFile=/old/machine/key.jks\nstorePassword=fake-store\nkeyAlias=upload\nkeyPassword=fake-key\n',
      BUILD_ENV: 'SENTRY_AUTH_TOKEN=fixture-token\n',
    });
    // sentry.gradle uploads the bundle's source map with the token in this file.
    expect(readFileSync(join(test.directory, 'app/.env.sentry-build-plugin'), 'utf8')).toBe('SENTRY_AUTH_TOKEN=fixture-token\n');
    expect(statSync(join(test.directory, 'app/.env.sentry-build-plugin')).mode & 0o777).toBe(0o600);
    expect(output).toContain('::add-mask::fixture-token\n');
    const path = join(test.directory, 'android-keystore.properties');
    const properties = readFileSync(path, 'utf8');
    expect(properties).not.toContain('/old/machine');
    expect(properties).toContain(`storeFile=${test.directory}/android-signing.keystore`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(test.directory, 'android-signing.keystore')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(test.directory, 'github-env'), 'utf8')).toBe(`SABEEL_KEYSTORE_PROPERTIES=${path}\n`);
    expect(existsSync(join(test.directory, 'app/android/keystore.properties'))).toBe(false);
  });

  it('refuses an Android release build without the build machine\'s values', () => {
    const test = fixture();
    expect(() => test.run('prepare-android', {})).toThrow(/Missing BUILD_ENV/);
  });

  it("uploads the selected web build's source maps to the app's web project, the token in sentry-cli's environment only", () => {
    const test = fixture();
    test.put('ci-tools.json', JSON.stringify(full));
    test.put('hosting-artifact/site/index.html', 'site');
    test.put('hosting-artifact/sourcemaps/_expo/static/js/web/entry.js', 'code');
    test.put('hosting-artifact/sourcemaps/_expo/static/js/web/entry.js.map', '{"debugId":"x"}');
    const record = {
      platform: 'web', commit, repository: 'Sabeel-Institute/test', repositoryId: '123', runId: '456',
      files: treeHashes(join(test.directory, 'hosting-artifact/site')),
      sourceMaps: treeHashes(join(test.directory, 'hosting-artifact/sourcemaps')),
    };
    test.put('hosting-artifact/build-record.json', JSON.stringify(record));
    test.put('bin/sentry-cli', `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(join(test.directory, 'sentry-cli.json'))}, JSON.stringify({ args: process.argv.slice(2),
  token: process.env.SENTRY_AUTH_TOKEN, dotenv: process.env.SENTRY_LOAD_DOTENV, buildEnv: process.env.BUILD_ENV ?? null }));
`, 0o700);
    const upload = { BUILD_ENV: 'SENTRY_AUTH_TOKEN=fixture-token\nASC_KEY_ID=ABC123DEF4\n', SENTRY_CLI: join(test.directory, 'bin/sentry-cli') };
    const output = test.run('sourcemaps', upload);
    expect(output).toContain('::add-mask::fixture-token\n');
    expect(JSON.parse(readFileSync(join(test.directory, 'sentry-cli.json'), 'utf8'))).toEqual({
      args: ['sourcemaps', 'upload', '--org', 'example-org', '--project', 'example-web', join(test.directory, 'hosting-artifact/sourcemaps')],
      token: 'fixture-token', dotenv: '0', buildEnv: null,
    });
    expect(() => test.run('sourcemaps', { ...upload, BUILD_ENV: 'ASC_KEY_ID=ABC123DEF4\n' })).toThrow(/BUILD_ENV has no SENTRY_AUTH_TOKEN/);
    test.put('hosting-artifact/sourcemaps/_expo/static/js/web/entry.js.map', '{"debugId":"y"}');
    expect(() => test.run('sourcemaps', upload)).toThrow(/Source map checksum mismatch/);
    test.put('hosting-artifact/build-record.json', JSON.stringify({ ...record, sourceMaps: undefined }));
    expect(() => test.run('sourcemaps', upload)).toThrow(/recorded no source maps/);
    test.put('hosting-artifact/build-record.json', JSON.stringify({ ...record, runId: '999' }));
    expect(() => test.run('sourcemaps', upload)).toThrow(/provenance/);
  });

  it('rejects production builds configured to use Firebase emulators', () => {
    const test = fixture();
    expect(() => test.run('prepare-web', { APP_ENV_LOCAL: 'EXPO_PUBLIC_USE_EMULATORS=1\n' })).toThrow();
  });

  it('resolves only successful main Web builds with passing CI', () => {
    const test = fixture();
    test.api();
    test.run('resolve-build');
    expect(readFileSync(join(test.directory, 'github-output'), 'utf8')).toContain(`sha=${commit}`);
    test.api(false);
    expect(() => test.run('resolve-build')).toThrow(/CI must pass/);
  });

  it('rejects builds from another repository', () => {
    const test = fixture();
    test.api();
    const path = join(test.directory, 'responses.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.run.head_repository.id = 999;
    writeFileSync(path, JSON.stringify(data));
    expect(() => test.run('resolve-build')).toThrow(/this repository main branch/);
  });

  it('resolves Android builds with the same exact-commit CI gate', () => {
    const test = fixture();
    test.api();
    test.run('resolve-android-build');
    expect(readFileSync(join(test.directory, 'github-output'), 'utf8')).toContain(`sha=${commit}`);
    test.api(false);
    expect(() => test.run('resolve-android-build')).toThrow(/CI must pass/);
  });

  it('verifies downloaded artifacts before creating a Hosting-only configuration', () => {
    const test = fixture();
    test.put('hosting-artifact/site/index.html', 'verified site');
    const record = {
      platform: 'web', commit, repository: 'Sabeel-Institute/test', repositoryId: '123', runId: '456',
      files: treeHashes(join(test.directory, 'hosting-artifact/site')),
    };
    test.put('hosting-artifact/build-record.json', JSON.stringify(record));
    test.put('firebase.json', JSON.stringify({ functions: {}, hosting: { public: 'ignored', predeploy: ['unsafe'] } }));
    test.run('deploy-config');
    const configuration = JSON.parse(readFileSync(join(test.directory, 'firebase-hosting.json'), 'utf8'));
    expect(Object.keys(configuration)).toEqual(['hosting']);
    expect(configuration.hosting.predeploy).toBeUndefined();
    test.put('hosting-artifact/site/index.html', 'changed after build');
    expect(() => test.run('deploy-config')).toThrow(/checksum mismatch/);
    test.put('hosting-artifact/build-record.json', JSON.stringify({ ...record, runId: '999' }));
    expect(() => test.run('deploy-config')).toThrow(/provenance/);
  });

  it('keeps publication manual and platform builds automatic', () => {
    const workflows = renderAll(full);
    const workflow = (name) => workflows.get(name);
    const deploy = workflow('web-deploy.yml');
    expect(deploy).toContain('workflow_dispatch:');
    expect(deploy).not.toMatch(/^ {2}(push|pull_request|workflow_run):/m);
    expect(deploy).toContain('if: inputs.deploy');
    expect(deploy).toContain('default: false');
    for (const name of ['android.yml', 'web.yml', 'ios.yml']) {
      expect(workflow(name)).toContain('branches: [main]');
    }
    expect(workflow('ios.yml')).toContain("if: github.event_name == 'workflow_dispatch' && inputs.testflight");
    expect(workflow('android.yml')).not.toMatch(/publish:play|publish-play|upload_to_play_store/);
    expect(workflow('android.yml')).toContain('packages: platform-tools');
  });

  it('restores the iOS build configuration with private permissions, every value masked', () => {
    const test = fixture();
    test.put('app/app.json', JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.sabeelinstitute.example' } } }));
    const plist = '<plist><dict><key>BUNDLE_ID</key><string>com.sabeelinstitute.example</string></dict></plist>\n';
    const output = test.run('prepare-ios', {
      APP_ENV_LOCAL: 'EXPO_PUBLIC_SENTRY_DSN_NATIVE="https://dsn@example.invalid/1"\n',
      BUILD_ENV: '# the build machine\nSENTRY_AUTH_TOKEN="token=value"\r\nIOS_TEAM_ID=TEAM123456\nASC_KEY_ID=\n',
      GOOGLE_SERVICE_INFO_PLIST: Buffer.from(plist).toString('base64'),
    });
    expect(output.split('\n').filter((line) => line.startsWith('::add-mask::')).sort())
      .toEqual(['::add-mask::TEAM123456', '::add-mask::https://dsn@example.invalid/1', '::add-mask::token=value']);
    for (const path of ['app/.env.local', 'app/.env.sentry-build-plugin', 'app/GoogleService-Info.plist']) {
      expect(statSync(join(test.directory, path)).mode & 0o777, path).toBe(0o600);
    }
    expect(readFileSync(join(test.directory, 'app/.env.sentry-build-plugin'), 'utf8')).toContain('IOS_TEAM_ID=TEAM123456');
    expect(readFileSync(join(test.directory, 'app/GoogleService-Info.plist'), 'utf8')).toBe(plist);
  });

  it('writes the iOS Firebase configuration only for this app, and only when there is one', () => {
    const test = fixture();
    test.put('app/app.json', JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.sabeelinstitute.example' } } }));
    test.run('prepare-ios', { BUILD_ENV: 'IOS_TEAM_ID=TEAM123456\n' });
    expect(existsSync(join(test.directory, 'app/GoogleService-Info.plist'))).toBe(false);
    const other = Buffer.from('<key>BUNDLE_ID</key><string>com.sabeelinstitute.other</string>').toString('base64');
    expect(() => test.run('prepare-ios', { BUILD_ENV: 'IOS_TEAM_ID=TEAM123456\n', GOOGLE_SERVICE_INFO_PLIST: other })).toThrow(/wrong bundle id/);
    expect(() => test.run('prepare-ios', {})).toThrow(/Missing BUILD_ENV/);
    expect(() => test.run('prepare-ios', { APP_ENV_LOCAL: 'EXPO_PUBLIC_USE_EMULATORS=1\n', BUILD_ENV: 'A=1\n' })).toThrow(/emulators/);
  });

  it('puts the App Store Connect key where Apple\'s tools look, and its ids in the job', () => {
    const test = fixture();
    const key = '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----';
    const settings = 'ASC_KEY_ID=ABC123DEF4\nASC_ISSUER_ID=00000000-0000-0000-0000-000000000000\nSENTRY_AUTH_TOKEN=token\n';
    const output = test.run('asc-key', { HOME: test.directory, BUILD_ENV: settings, ASC_KEY_P8: key });
    expect(output).toContain('::add-mask::token');
    const path = join(test.directory, '.appstoreconnect/private_keys/AuthKey_ABC123DEF4.p8');
    expect(readFileSync(path, 'utf8')).toBe(key + '\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(test.directory, 'github-env'), 'utf8')).toBe('ASC_KEY_ID=ABC123DEF4\nASC_ISSUER_ID=00000000-0000-0000-0000-000000000000\n');
    expect(() => test.run('asc-key', { HOME: test.directory, BUILD_ENV: 'ASC_KEY_ID=../../x\nASC_ISSUER_ID=00000000-0000-0000-0000-000000000000\n', ASC_KEY_P8: key }))
      .toThrow(/must set ASC_KEY_ID/);
    expect(() => test.run('asc-key', { HOME: test.directory, BUILD_ENV: 'ASC_KEY_ID=ABC123DEF4\n', ASC_KEY_P8: key })).toThrow(/ASC_ISSUER_ID/);
    expect(() => test.run('asc-key', { HOME: test.directory, BUILD_ENV: settings, ASC_KEY_P8: 'not a key' })).toThrow(/not a \.p8 private key/);
  });
});
