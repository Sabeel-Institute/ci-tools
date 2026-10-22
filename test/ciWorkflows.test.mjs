import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import minimal from './fixtures/minimal.json' with { type: 'json' };

/** One job's text, from its key to the next job's. */
const job = (workflow, name) => workflow.split(/\n(?= {2}[a-z0-9-]+:\n)/).find((part) => part.startsWith(`  ${name}:\n`));

describe('CI', () => {
  const ci = renderAll(full).get('ci.yml');

  it('keeps a fail-closed aggregate over independent jobs', () => {
    const jobs = [...ci.matchAll(/^ {2}([a-z-]+):\n(?= {4}if:)/gm)].map((match) => match[1]);
    const gate = ci.slice(ci.indexOf('  build-test:'));
    for (const name of ['workflow-validation', 'quality', 'integration', 'browser', 'build-test']) expect(jobs).toContain(name);
    for (const name of jobs.filter((name) => name !== 'build-test')) expect(gate).toContain(name);
    expect(gate).toContain('if: always()');
    expect(gate).toContain('job.result !== "success"');
  });

  it('lints the workflows with a checksum-pinned actionlint and shellcheck', () => {
    expect(ci).toContain('actionlint_1.7.12_linux_amd64.tar.gz');
    expect(ci).toContain('sha256sum -c -');
    expect(ci).toContain('shellcheck --version');
  });

  it("holds the app to ci-tools' assumptions before its own tests", () => {
    const quality = job(ci, 'quality');
    expect(quality.indexOf('run: sabeel-ci check-app')).toBeGreaterThan(-1);
    expect(quality.indexOf('run: sabeel-ci check-app')).toBeLessThan(quality.indexOf('run: npm test'));
  });

  it("runs each of the app's browser suites, and the screens report on every sweep", () => {
    expect(ci).toContain('suite: ["test:screens","test:e2e"]');
    expect(ci).toContain('run: npm run "$SUITE"');
    expect(ci).toContain("if: always() && matrix.suite == 'test:screens'");
    expect(ci).toContain('sabeel-ci screens-report shots/screens --baseline-from-main');
    expect(ci).toMatch(/name: screens-report\n {10}path: \$\{\{ runner\.temp \}\}\/screens-report/);
  });

  it('installs the media tools and the dead-code audit only for an app that asks', () => {
    const lean = renderAll(minimal).get('ci.yml');
    for (const step of ['Dead-code audit', 'Install ffmpeg', 'Install SeaweedFS']) {
      expect(ci).toContain(`name: ${step}`);
      expect(lean).not.toContain(`name: ${step}`);
    }
    expect(ci).toContain('31fb804858885f9e7f18b6d3b1da09e824baac3e6a55b5a62c3c4c77e6ed6d7d');
  });

  it("writes the emulators' secret placeholders from ci-tools.json, never from secrets", () => {
    // test-emulator writes them itself; the browser suites start their own stack.
    expect(job(ci, 'browser')).toContain('- name: Emulator secret placeholders\n        run: sabeel-ci emulator-secrets\n');
    expect(job(ci, 'integration')).not.toContain('emulator-secrets');
    expect(ci).not.toContain('secrets.');
  });

  it('gives up on a stuck Chromium install in minutes, not at the job timeout', () => {
    expect(job(ci, 'browser')).toContain('- name: Install Chromium\n        timeout-minutes: 12\n'
      + '        run: timeout 300 npx playwright install --with-deps chromium || timeout 300 npx playwright install --with-deps chromium\n');
  });
});

describe('actions', () => {
  const repo = new URL('..', import.meta.url);
  const read = (directory) => readdirSync(new URL(directory, repo)).filter((name) => name.endsWith('.yml'))
    .map((name) => [`${directory}${name}`, readFileSync(new URL(`${directory}${name}`, repo), 'utf8')]);
  const uses = (files) => files.flatMap(([file, text]) => [...text.matchAll(/^\s*-?\s*uses: ([^@\s]+)@(\S+)/gm)]
    .map((match) => ({ file, action: match[1], ref: match[2] })));

  it('are named only in whole workflows, the files Dependabot reads', () => {
    expect(uses(read('workflows/partials/'))).toEqual([]);
    const dependabot = readFileSync(new URL('.github/dependabot.yml', repo), 'utf8');
    expect(dependabot).toContain('directories: ["/", "/workflows"]');
  });

  it('each run at one version, in the templates and in these workflows', () => {
    const named = uses([...read('workflows/'), ...read('.github/workflows/')]);
    expect(named.length).toBeGreaterThan(0);
    const split = [...Map.groupBy(named, (use) => use.action)].map(([action, all]) => [action, Map.groupBy(all, (use) => use.ref)])
      .filter(([, refs]) => refs.size > 1)
      .map(([action, refs]) => `${action}: ${[...refs].map(([ref, at]) => `${ref} in ${[...new Set(at.map((use) => use.file))].join(', ')}`).join('; ')}`);
    expect(split).toEqual([]);
  });
});

describe('CodeQL', () => {
  it('scans JavaScript and TypeScript without builds or deployment secrets', () => {
    const codeql = renderAll(full).get('codeql.yml');
    expect(codeql).toContain('languages: javascript-typescript');
    expect(codeql).toContain('build-mode: none');
    expect(codeql).toContain('schedule:');
    expect(codeql).not.toContain('secrets.');
    expect(codeql).not.toContain('pull_request_target');
  });
});
