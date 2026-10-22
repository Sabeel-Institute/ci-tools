import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, findRoot, validate } from '../lib/config.mjs';
import { problems } from '../scripts/check-app.mjs';
import { drift, expand, renderAll } from '../scripts/workflows.mjs';

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
  put('ci-tools.json', { name: 'example' });
  put('.gitignore', '.env.local\napp/android/keystore.properties\n');
  put('app/app.json', { expo: { android: { package: 'com.sabeelinstitute.example' }, ios: { bundleIdentifier: 'com.sabeelinstitute.example' } } });
  put('functions/package.json', { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } });
  put('functions/package-lock.json', { packages: { '': { dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } } } });
  for (const [name, text] of renderAll()) put(`.github/workflows/${name}`, text);
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
    expect(validate({ name: 'lms' })).toEqual({ name: 'lms' });
    expect(() => validate({})).toThrow(/name is required/);
    expect(() => validate({ name: 'lms', nmae: 'x' })).toThrow(/unknown key nmae/);
    expect(() => validate({ name: '' })).toThrow(/invalid value/);
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

  it('name where they come from, and leave no directive unexpanded', () => {
    for (const [name, text] of renderAll()) {
      expect(text.startsWith(`# Rendered from Sabeel-Institute/ci-tools workflows/${name} by\n`)).toBe(true);
      expect(text).not.toMatch(/# ci-tools:/);
    }
  });

  it('fetch ci-tools before any job runs it, at the pinned commit and only from main', () => {
    for (const [name, text] of renderAll()) {
      for (const job of text.split(/\n(?= {2}[a-z0-9-]+:\n)/).slice(1)) {
        if (!job.includes('sabeel-ci ')) continue;
        const fetch = job.indexOf('ci-tools, at the commit package-lock.json pins');
        expect(fetch, `${name}: ${job.slice(0, 40)}`).toBeGreaterThan(-1);
        expect(fetch).toBeLessThan(job.indexOf('sabeel-ci '));
      }
    }
    const step = renderAll().get('android.yml');
    expect(step).toContain('merge-base --is-ancestor "$sha" origin/main');
    expect(step).toContain('--ignore-scripts');
  });

  it('report every drifted, missing or orphaned file', () => {
    const { root, put } = app();
    expect(drift(root)).toEqual([]);
    put('.github/workflows/web.yml', 'edited by hand\n');
    rmSync(join(root, '.github/workflows/android.yml'));
    put('.github/workflows/old.yml', '# Rendered from Sabeel-Institute/ci-tools workflows/old.yml by\n');
    put('.github/workflows/ci.yml', 'the app\'s own\n');
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

  it('reports a secret file Git would pick up, bad identifiers and a stale functions lock', () => {
    const { root, put } = app();
    put('.gitignore', '.env.local\n');
    put('app/app.json', { expo: { android: { package: 'com.example.app' }, ios: { bundleIdentifier: '<key>bad</key>' } } });
    put('functions/package.json', { dependencies: { a: '^1.1.0' }, devDependencies: { b: '^2.0.0' } });
    const found = problems(root);
    expect(found).toHaveLength(3);
    expect(found[0]).toMatch(/does not cover app\/android\/keystore\.properties/);
    expect(found[1]).toMatch(/identifier/);
    expect(found[2]).toMatch(/out of step/);
    expect(readFileSync(join(root, 'ci-tools.json'), 'utf8')).toContain('example');
  });
});
