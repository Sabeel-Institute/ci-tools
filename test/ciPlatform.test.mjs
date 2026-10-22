import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { environmentValues, hostingConfig, treeHashes } from '../scripts/ci-platform.mjs';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import { vapidKey, webExport } from './fixtures/push.mjs';

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
    test.run('prepare-android', {
      ANDROID_KEYSTORE: Buffer.from('fixture key').toString('base64'),
      ANDROID_KEYSTORE_PROPERTIES: 'storeFile=/old/machine/key.jks\nstorePassword=fake-store\nkeyAlias=upload\nkeyPassword=fake-key\n',
    });
    const properties = readFileSync(join(test.directory, 'app/android/keystore.properties'), 'utf8');
    expect(properties).not.toContain('/old/machine');
    expect(properties).toContain(`storeFile=${test.directory}/android-signing.keystore`);
    expect(statSync(join(test.directory, 'android-signing.keystore')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(test.directory, 'github-env'), 'utf8')).toContain('SABEEL_LMS_KEYSTORE_PROPERTIES=');
  });

  it('checks every web export for its VAPID key before it becomes the artifact', () => {
    const test = fixture();
    test.put('bin/npm', '#!/bin/sh\nexit 0\n', 0o700);
    const env = { GITHUB_RUN_ID: '456', GITHUB_REF: 'refs/heads/main' };
    webExport(join(test.directory, 'app/dist-web'), { 'index-a1.js': 'var v="";' });
    expect(() => test.run('web', env)).toThrow(/check-web-push: no VAPID key/);
    expect(existsSync(join(test.directory, 'web-artifact'))).toBe(false);
    webExport(join(test.directory, 'app/dist-web'), { 'index-a1.js': `var v="${vapidKey()}";` });
    expect(test.run('web', env)).toContain('check-web-push: ok');
    expect(JSON.parse(readFileSync(join(test.directory, 'web-artifact/build-record.json'), 'utf8')).files)
      .toHaveProperty(['_expo/static/js/web/index-a1.js']);
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
    for (const name of ['android.yml', 'web.yml']) {
      expect(workflow(name)).toContain('branches: [main]');
    }
    expect(workflow('android.yml')).not.toMatch(/publish:play|publish-play|upload_to_play_store/);
    expect(workflow('android.yml')).toContain('packages: platform-tools');
  });
});
