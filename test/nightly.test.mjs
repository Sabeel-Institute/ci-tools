import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { treeHashes } from '../scripts/ci-platform.mjs';
import { stampedCommit, verifyLive } from '../scripts/ci-hosting-smoke.mjs';
import { failures } from '../scripts/nightly-issue.mjs';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

const ORIGIN = 'https://demo-sabeel-test.web.app';

/** CI's build of a commit, and a live site serving `served` (CI's files, unless changed). */
function site(script, changes = {}) {
  const artifact = temporary('nightly-build-');
  const files = {
    'index.html': '<script src="/_expo/static/js/web/index-1.js" defer></script>',
    '_expo/static/js/web/index-1.js': script,
    'privacy.html': 'Privacy', 'support.html': 'Support',
  };
  mkdirSync(join(artifact, 'site/_expo/static/js/web'), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(artifact, 'site', name), content);
  writeFileSync(join(artifact, 'build-record.json'), JSON.stringify({ files: treeHashes(join(artifact, 'site')) }));
  const served = { ...files, ...changes };
  const request = async (url, options) => {
    expect(url.origin).toBe(ORIGIN);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
    const name = { '/': 'index.html', '/privacy': 'privacy.html', '/support': 'support.html' }[url.pathname] ?? url.pathname.slice(1);
    return new Response(served[name] ?? 'Not found', { status: served[name] ? 200 : 404 });
  };
  return { artifact, request, pause: async () => {} };
}

describe('the live web app, nightly', () => {
  it('reads the build commit as BUILD_INFO keeps it, or folded into the label', () => {
    expect(stampedCommit(['x', 'a={version:"0.2.1",commit:"abc1234"}'])).toEqual({ commit: 'abc1234', dirty: false });
    expect(stampedCommit(['const o=`v${n.version} \\xb7 f66ae31`'])).toEqual({ commit: 'f66ae31', dirty: false });
    expect(stampedCommit(['"v0.2.1 · f66ae31+"'])).toEqual({ commit: 'f66ae31', dirty: true });
    expect(stampedCommit(['commit(){return this._verifyNotCommitted()}'])).toBeNull();
  });

  it('passes when the site is, byte for byte, CI\'s build of its stamped commit', async () => {
    const { artifact, request, pause } = site('console.log({commit:"abc1234"})');
    const asked = [];
    await verifyLive(ORIGIN, async (commit) => (asked.push(commit), artifact), { request, pause });
    expect(asked).toEqual(['abc1234']);
  });

  it('fails a site published from anything but CI\'s build', async () => {
    const { artifact, request, pause } = site('console.log({commit:"abc1234"})');
    await expect(verifyLive(ORIGIN, async () => null, { request, pause })).rejects.toThrow(/serves a build of abc1234, which has no successful Web build on main/);
    const dirty = site('console.log({commit:"abc1234+"})');
    await expect(verifyLive(ORIGIN, async () => dirty.artifact, dirty)).rejects.toThrow(/uncommitted changes \(abc1234\+\)/);
    const unstamped = site('console.log("no stamp")');
    await expect(verifyLive(ORIGIN, async () => unstamped.artifact, unstamped)).rejects.toThrow(/carry no build commit stamp/);
    const changed = site('console.log({commit:"abc1234"})', { 'privacy.html': 'Edited by hand' });
    await expect(verifyLive(ORIGIN, async () => artifact, changed)).rejects.toThrow(/check failed for \/privacy: Published content does not match/);
    const empty = site('', { 'index.html': '<p>Down for maintenance</p>' });
    await expect(verifyLive(ORIGIN, async () => artifact, empty)).rejects.toThrow(/serves no same-origin script/);
  });
});

/** nightly-issue with a gh that records its calls and has `open` as the open issue, if any. */
function issue(args, open) {
  const base = temporary('nightly-issue-');
  const log = join(base, 'gh.log');
  mkdirSync(join(base, 'bin'));
  writeFileSync(join(base, 'bin/gh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'issue' && process.argv[3] === 'list') console.log(JSON.stringify(${JSON.stringify(open ? [{ number: open }] : [])}));
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../scripts/nightly-issue.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: join(base, 'bin') + ':' + process.env.PATH,
      GITHUB_REPOSITORY: 'Sabeel-Institute/test', GITHUB_RUN_ID: '77', GITHUB_SERVER_URL: 'https://github.com' },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { result, calls: calls.map((call) => call.slice(0, 3).join(' ')), all: calls };
}

describe('the nightly issue', () => {
  it('counts every check that did not succeed, a step that never ran included', () => {
    expect(failures(['web=success', 'functions=success'])).toEqual([]);
    expect(failures(['web=failure', 'functions=skipped'])).toEqual([{ name: 'web', outcome: 'failure' }, { name: 'functions', outcome: 'skipped' }]);
    expect(() => failures(['push=failure'])).toThrow(/no check named push/);
  });

  it('opens one labelled issue naming what failed, and fails the run', () => {
    const { result, calls, all } = issue(['web=failure', 'functions=success']);
    expect(result.status).toBe(1);
    expect(calls).toEqual(['issue list --label', 'label create nightly', 'issue create --title']);
    const body = all[2][all[2].indexOf('--body') + 1];
    expect(body).toContain('- the live web app serves the build CI made: failed');
    expect(body).not.toContain('every callable');
    expect(body).toContain('https://github.com/Sabeel-Institute/test/actions/runs/77');
  });

  it('comments on the open issue rather than opening another', () => {
    const { result, calls } = issue(['web=success', 'functions=failure'], 12);
    expect(result.status).toBe(1);
    expect(calls).toEqual(['issue list --label', 'issue comment 12']);
  });

  it('closes the open issue on a night that passes, and passes', () => {
    expect(issue(['web=success', 'functions=success'], 12)).toMatchObject({ result: { status: 0 }, calls: ['issue list --label', 'issue close 12'] });
    expect(issue(['web=success', 'functions=success'])).toMatchObject({ result: { status: 0 }, calls: ['issue list --label'] });
  });
});

describe('the Nightly workflow', () => {
  const workflow = renderAll(full).get('nightly.yml');

  it('runs both checks every night, whatever the first finds, and then the issue', () => {
    expect(workflow).toMatch(/schedule:\n {4}- cron: "23 10 \* \* \*"/);
    expect(workflow).toMatch(/id: web\n {8}continue-on-error: true[\s\S]*run: sabeel-ci ci-hosting-smoke --live/);
    expect(workflow).toMatch(/id: functions\n {8}continue-on-error: true\n {8}run: sabeel-ci ci-functions health/);
    expect(workflow).toMatch(/if: always\(\)[\s\S]*run: sabeel-ci nightly-issue "web=\$WEB" "functions=\$FUNCTIONS"/);
  });

  it('signs in to nothing: no secret, no cloud identity, no environment', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n {2}actions: read\n {2}issues: write\n/m);
    for (const forbidden of ['secrets.', 'id-token', 'google-github-actions/auth', 'environment:', 'firebase deploy'])
      expect(workflow).not.toContain(forbidden);
  });

  it('can find the live build: the Web workflow keeps its artifact 90 days', () => {
    expect(renderAll(full).get('web.yml')).toMatch(/name: web-hosting-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 90/);
  });
});
