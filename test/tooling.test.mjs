import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, findRoot, validate } from '../lib/config.mjs';
import { problems } from '../scripts/check-app.mjs';
import { drift, expand, renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import minimal from './fixtures/minimal.json' with { type: 'json' };

const bin = fileURLToPath(new URL('../bin/sabeel-ci.mjs', import.meta.url));
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
  put('app/app.json', { expo: { version: '0.2.0', android: { package: 'com.sabeelinstitute.example' }, ios: { bundleIdentifier: 'com.sabeelinstitute.example' } } });
  put('docs/PHASE_STATUS.md', '## Deploy log\n\n### 2026-10-21 — The example release — v0.2.0\n');
  put('functions/package.json', { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } });
  put('functions/package-lock.json', { packages: { '': { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } } } });
  for (const [name, text] of renderAll(full)) put(`.github/workflows/${name}`, text);
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
    const { root, put } = app();
    put('ci-tools.json', '{ not json');
    expect(() => config(root)).toThrow(/cannot read/);
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
    put('app/app.json', { expo: { version: '0.3.0', android: { package: 'com.example.app' }, ios: { bundleIdentifier: '<key>bad</key>' } } });
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

  it('reports a signing secret read outside release-build, in the app\'s own workflows too', () => {
    const { root, put } = app();
    put('.github/workflows/app-only.yml', 'on: push\njobs:\n  test:\n    steps:\n      - run: x\n        env:\n          K: ${{ secrets.ASC_KEY_P8 }}\n');
    expect(problems(root)).toEqual(['app-only.yml job test reads ASC_KEY_P8 without entering the release-build environment']);
  });
});
