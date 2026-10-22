import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appScheme, backendEndpoints, firebaseFixtures, podVersions } from '../scripts/ci-premerge.mjs';
import { compatibleVersion, sdkProblems } from '../scripts/lib/ci-sdk.mjs';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const premerge = renderAll(full).get('premerge.yml');

describe('pre-merge SDK compatibility', () => {
  it.each([
    ['0.86.3', '0.86.0', true],
    ['0.88.0', '0.86.0', false],
    ['0.86.0', '0.86.3', false],
    ['19.2.4', '19.2.3', true],
    ['19.3.1', '19.2.3', false],
    ['5.10.1', '~5.7.0', false],
    ['4.7.1', '4.5.0', false],
    ['0.13.0', '0.10.1', false],
    ['15.1.1', '^15.0.2', true],
    ['16.0.0', '^15.0.2', false],
    ['0.3.3', '^0.3.2', true],
    ['0.0.3', '^0.0.2', false],
    ['3.1.1', '2.2.0', false],
    ['8.31.0', '~7.11.0', false],
    ['19.3.0-rc.1', '19.2.3', false],
  ])('checks installed %s against SDK %s', (installed, recommended, expected) => {
    expect(compatibleVersion(installed, recommended)).toBe(expected);
  });
  it('reports incompatible managed packages without rejecting unrelated dependencies', () => {
    expect(sdkProblems({ 'react-native': '0.86.0' }, {
      'react-native': '0.88.0', 'other-package': '3.0.0',
    })).toEqual(['react-native 0.88.0 is outside the Expo SDK recommendation 0.86.0']);
  });
});

describe('secret-free native compilation', () => {
  it('uses demo Firebase fixtures matching the app identifiers', () => {
    const configuration = { android: { package: 'com.sabeelinstitute.example' }, ios: { bundleIdentifier: 'com.sabeelinstitute.example' } };
    const fixtures = firebaseFixtures(configuration);
    expect(fixtures.android.project_info.project_id).toBe('demo-sabeel-ci');
    expect(fixtures.android.client[0].client_info.android_client_info.package_name).toBe(configuration.android.package);
    expect(fixtures.ios).toContain('<string>' + configuration.ios.bundleIdentifier + '</string>');
    expect(fixtures.ios).toContain('<string>demo-sabeel-ci</string>');
    expect(JSON.stringify(fixtures)).not.toContain('AIza');
  });
  it('rejects injected application identifiers in generated XML/config', () => {
    expect(() => firebaseFixtures({
      android: { package: 'com.example.app' }, ios: { bundleIdentifier: '<key>bad</key>' },
    })).toThrow('identifier');
  });
  it('refuses fixture preparation outside an isolated runner before editing any files', () => {
    const app = mkdtempSync(join(tmpdir(), 'ci-premerge-'));
    try {
      expect(() => execFileSync(process.execPath, [new URL('../scripts/ci-premerge.mjs', import.meta.url).pathname, 'prepare'], {
        cwd: app, env: { ...process.env, GITHUB_ACTIONS: 'false' }, stdio: 'pipe',
      })).toThrow();
      expect(readdirSync(app)).toEqual([]);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
  it('checks the app scheme instead of building an arbitrary pod', () => {
    expect(appScheme({ schemes: ['AppTests', 'OurApp'] }, 'OurApp')).toBe('OurApp');
    expect(() => appScheme({ schemes: ['AppAuth', 'OtherApp'] }, 'OurApp')).toThrow('exactly one');
  });
  it('requires existing pinned native pod versions', () => {
    expect(podVersions('PODS:\n  - App (1.0)\nDEPENDENCIES:\n  - App\nCHECKSUM: 1\n'))
      .toBe('PODS:\n  - App (1.0)\n');
    expect(() => podVersions('PODS: []')).toThrow('dependency versions');
  });
});

describe('mandatory build and deployment contracts', () => {
  it('never exposes secrets, signing keys, publishing or release artifacts to PR jobs', () => {
    const workflow = premerge;
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('contents: read');
    for (const forbidden of ['secrets.', 'id-token: write', 'pull_request_target:', 'upload-artifact',
      'firebase deploy', 'publish:play', 'environment: production']) expect(workflow).not.toContain(forbidden);
    expect(workflow).toContain('EXPO_NO_DOTENV: "1"');
    expect(workflow).toContain('SENTRY_DISABLE_AUTO_UPLOAD: "true"');
  });
  it('requires every platform and compatibility job and fails closed', () => {
    const workflow = premerge;
    const gate = workflow.slice(workflow.indexOf('  premerge-builds:'));
    expect(gate).toContain('needs: [compatibility, web, android, ios]');
    expect(gate).toContain('if: always()');
    expect(gate).toContain('jobs.length !== 4');
    expect(gate).toContain('job.result !== "success"');
    expect(workflow).toContain('sabeel-ci ci-premerge backend');
    expect(workflow).toContain('npm run web:export -w @sabeel/app');
  });
  it('validates release-mode native application products without release credentials', () => {
    const helper = read('scripts/ci-premerge.mjs');
    for (const required of [':app:bundleRelease', 'signingConfig = null', 'arm64-v8a',
      'CODE_SIGNING_ALLOWED=NO', "'Release'", 'generic/platform=iOS', 'main.jsbundle',
      'base/assets/index.android.bundle', '_CodeSignature']) expect(helper).toContain(required);
    expect(helper).not.toContain('allowProvisioningUpdates');
    expect(helper).not.toContain('-exportArchive');
  });
  it('installs the backend from its own lock, without dev packages, before loading it', () => {
    const helper = read('scripts/ci-premerge.mjs');
    for (const required of ["'functions', file", "'ci', '--omit=dev'", 'require("./lib/index.js")'])
      expect(helper).toContain(required);
  });
  it('fails a backend bundle that registers no functions', () => {
    expect(backendEndpoints({ acceptRules: { __endpoint: true }, helper: {} })).toEqual(['acceptRules']);
    expect(() => backendEndpoints({ helper: {} })).toThrow('no functions');
  });
});
