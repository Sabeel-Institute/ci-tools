import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentationOnly } from '../scripts/docs-only.mjs';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };

const script = fileURLToPath(new URL('../scripts/docs-only.mjs', import.meta.url));
const fixtures = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('documentationOnly', () => {
  it('is true when every file is Markdown, reStructuredText or under docs/', () => {
    expect(documentationOnly(['README.md', 'docs/DEPLOY.md', 'docs/brand/mark.png', 'CHANGELOG.rst', 'app/README.md'])).toBe(true);
  });

  it('is false when any file is not, or when there are none', () => {
    expect(documentationOnly(['README.md', 'app/src/App.tsx'])).toBe(false);
    expect(documentationOnly(['package-lock.json'])).toBe(false);
    expect(documentationOnly(['app/docs/notes.ts', 'notes.mdx', 'LICENSE'])).toBe(false);
    expect(documentationOnly([])).toBe(false);
  });
});

describe('sabeel-ci docs-only', () => {
  /** A repository whose HEAD merges a branch that changes `files` into main, as GitHub's merge ref does. */
  function merged(files, { rename } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'docs-only-'));
    fixtures.push(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    const put = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'ci@example.com');
    git('config', 'user.name', 'CI');
    put('app/src/App.tsx', 'export {};\n');
    put('README.md', '# App\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'topic');
    for (const file of files) put(file, `${file}\n`);
    if (rename) {
      mkdirSync(dirname(join(root, rename[1])), { recursive: true });
      git('mv', ...rename);
    }
    git('add', '.');
    git('commit', '-qm', 'topic');
    git('checkout', '-q', 'main');
    put('functions/src/index.ts', 'export const other = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'main moves on');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'topic');
    return { root, git };
  }
  const run = (root, env) => {
    const output = join(root, '.output');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output, ...env } });
    return { ...result, output: readFileSync(output, 'utf8') };
  };

  it("answers for the files the pull request's merge changes, not main's own", () => {
    const docs = merged(['docs/DEPLOY.md', 'README.md']);
    expect(run(docs.root, { GITHUB_EVENT_NAME: 'pull_request' }).output).toBe('docs-only=true\n');
    const code = merged(['docs/DEPLOY.md', 'app/src/App.tsx']);
    const result = run(code.root, { GITHUB_EVENT_NAME: 'pull_request' });
    expect(result.output).toBe('docs-only=false\n');
    expect(result.stdout).toContain('2 file(s) changed: app/src/App.tsx, docs/DEPLOY.md');
  });

  it('counts a file renamed into docs/ as the file it was', () => {
    const { root } = merged([], { rename: ['app/src/App.tsx', 'docs/App.tsx'] });
    expect(run(root, { GITHUB_EVENT_NAME: 'pull_request' }).output).toBe('docs-only=false\n');
  });

  it('is false for anything but a pull request', () => {
    const { root } = merged(['README.md']);
    for (const event of ['push', 'workflow_dispatch']) {
      const result = run(root, { GITHUB_EVENT_NAME: event });
      expect(result.status).toBe(0);
      expect(result.output).toBe('docs-only=false\n');
    }
  });

  it('fails, and answers nothing, on a checkout that is not a merge commit', () => {
    const { root, git } = merged(['README.md']);
    git('checkout', '-q', 'topic');
    const result = run(root, { GITHUB_EVENT_NAME: 'pull_request' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fetch-depth: 2');
    expect(result.output).toBe('');
  });
});

describe('the gates on a documentation-only pull request', () => {
  const rendered = renderAll(full);
  /** A job's text, from its key to the next job's. */
  const job = (workflow, name) => workflow.split(/\n(?= {2}[a-z0-9-]+:\n)/).find((part) => part.startsWith(`  ${name}:\n`));
  /** The gate's script, run on `jobs`: whether it passes. */
  const passes = (workflow, gate, jobs) => {
    const text = job(rendered.get(workflow), gate);
    const code = text.slice(text.indexOf("node -e '") + "node -e '".length, text.lastIndexOf("'"));
    const result = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, JOB_RESULTS: JSON.stringify(jobs) } });
    return result.status === 0;
  };
  const results = (names, docsOnly, overrides = {}) => Object.fromEntries(names.map((name) => [name, {
    result: overrides[name] ?? 'success',
    outputs: name === 'changes' ? { 'docs-only': String(docsOnly) } : name === 'fingerprint' ? { 'android-compiled': 'false', 'ios-compiled': 'false' } : {},
  }]));
  const GATES = [
    ['ci.yml', 'build-test', ['workflow-validation', 'changes', 'quality', 'integration', 'browser'], ['integration', 'browser']],
    ['native.yml', 'native', ['changes', 'android', 'ios'], ['android', 'ios']],
    ['premerge.yml', 'premerge-builds', ['changes', 'compatibility', 'fingerprint', 'javascript', 'android', 'ios'],
      ['compatibility', 'fingerprint', 'javascript', 'android', 'ios']],
  ];

  for (const [workflow, gate, names, skippable] of GATES) {
    describe(`${workflow}'s ${gate}`, () => {
      const skipped = Object.fromEntries(skippable.map((name) => [name, 'skipped']));

      it('needs the changes job and every job it may pass over', () => {
        expect(job(rendered.get(workflow), gate)).toContain(`needs: [${names.join(', ')}]`);
      });

      it('passes every job passed, and the skippable ones skipped on documentation alone', () => {
        expect(passes(workflow, gate, results(names, false))).toBe(true);
        expect(passes(workflow, gate, results(names, true))).toBe(true);
        expect(passes(workflow, gate, results(names, true, skipped))).toBe(true);
      });

      it('fails them skipped on anything else, or anything failed, cancelled or missing', () => {
        expect(passes(workflow, gate, results(names, false, { [skippable[0]]: 'skipped' }))).toBe(false);
        expect(passes(workflow, gate, results(names, true, { ...skipped, [skippable[0]]: 'failure' }))).toBe(false);
        expect(passes(workflow, gate, results(names, true, { ...skipped, [skippable.at(-1)]: 'cancelled' }))).toBe(false);
        const failedChanges = results(names, true, { ...skipped, changes: 'failure' });
        expect(passes(workflow, gate, failedChanges)).toBe(false);
        expect(passes(workflow, gate, results(names, true, { ...skipped, changes: 'skipped' }))).toBe(false);
        const missing = results(names, true, skipped);
        delete missing[skippable[0]];
        expect(passes(workflow, gate, missing)).toBe(false);
      });

      it('never passes over a job a document can affect', () => {
        for (const name of names.filter((name) => name !== 'changes' && !skippable.includes(name))) {
          expect(passes(workflow, gate, results(names, true, { ...skipped, [name]: 'skipped' }))).toBe(false);
        }
      });
    });
  }

  it('skips exactly those jobs, each on the changes job', () => {
    const condition = "if: needs.changes.outputs.docs-only != 'true'";
    for (const [workflow, , , skippable] of GATES) {
      const text = rendered.get(workflow);
      const changes = job(text, 'changes');
      expect(changes).toMatch(/fetch-depth: 2\n/);
      expect(changes).toContain('run: sabeel-ci docs-only');
      // The jobs that need nothing else wait on the changes job; the rest wait on them.
      const direct = { 'ci.yml': ['integration', 'browser'], 'native.yml': ['android', 'ios'], 'premerge.yml': ['compatibility', 'fingerprint'] }[workflow];
      for (const name of direct) expect(job(text, name)).toContain(condition);
      for (const name of skippable) expect(job(text, name)).toMatch(/\n {4}needs: (changes|\[changes, [a-z, ]+\]|compatibility|\[compatibility, fingerprint\])\n/);
    }
    expect(job(rendered.get('ci.yml'), 'quality')).not.toContain('needs:');
    expect(job(rendered.get('ci.yml'), 'workflow-validation')).not.toContain('needs:');
  });
});
