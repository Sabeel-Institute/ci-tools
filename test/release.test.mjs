import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { addEntry } from '../scripts/release.mjs';
import full from './fixtures/full.json' with { type: 'json' };

const script = resolve(import.meta.dirname, '../scripts/release.mjs');
const stand = (name) => `import ${JSON.stringify(resolve(import.meta.dirname, 'fixtures/release', name))};\n`;
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const LOG = `# Phase status

## Deploy log

### 2026-10-01 — The first release — v0.2.0

Notes for 0.2.0.

## Decision log

- 2026-09-01 — A decision.
`;
const ENTRY = '### 2026-10-22 — Faster sign-in — v0.2.1\n\nSign-in takes one tap.\n';

/**
 * An app repository with its origin (a bare repository standing in for
 * GitHub), released at 0.2.0 and tagged, and stand-ins for ci-tools' other
 * commands and gh, each recording its calls.
 * sabeel-ci's render-manual checks the manual's version line and writes the PDF.
 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'release-'));
  fixtures.push(base);
  const root = join(base, 'app');
  const origin = join(base, 'origin.git');
  const put = (path, value, mode = 0o644) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode });
  };
  const outside = (path, value, mode = 0o755) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), value, { mode });
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = (...args) => execFileSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const app = (version, buildNumber = String(Number(version.split('.')[1]) * 1000 + Number(version.split('.')[2]))) => ({
    expo: {
      name: 'Example', slug: 'sabeel-example', version,
      ios: { bundleIdentifier: 'com.sabeelinstitute.example', buildNumber },
      android: { package: 'com.sabeelinstitute.example' },
    },
  });
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  mkdirSync(root);
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.test');
  // origin is the Institute's repository on GitHub, as Git reaches it here.
  git('remote', 'add', 'origin', 'https://github.com/Sabeel-Institute/example.git');
  git('config', `url.${origin}.insteadOf`, 'https://github.com/Sabeel-Institute/example.git');
  put('ci-tools.json', full);
  put('.gitignore', 'app/android/app/build/\n');
  put('app/app.json', app('0.2.0'));
  put('app/android/app/build.gradle', '        versionCode computedVersionCode\n        versionName expoVersion\n');
  put('docs/USER-MANUAL.md', '# Manual\n\n*For app version 0.2.0 · October 2026*\n\nHow to use it.\n');
  put('docs/USER-MANUAL.pdf', 'PDF 0.2.0\n');
  put('docs/PHASE_STATUS.md', LOG);
  git('add', '-A');
  git('commit', '--quiet', '-m', 'v0.2.0');
  git('tag', 'v0.2.0');
  git('push', '--quiet', 'origin', 'main', 'v0.2.0');
  outside('bin/gh', '#!/usr/bin/env node\n' + stand('gh.mjs'));
  outside('tools/bin/sabeel-ci.mjs', stand('sabeel-ci.mjs'));
  outside('entry.md', ENTRY);
  // The release's own scratch directories land in base, which afterEach removes.
  mkdirSync(join(base, 'tmp'));
  const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, PATH: join(base, 'bin') + ':' + process.env.PATH, CI_TOOLS: join(base, 'tools'),
      RELEASE_LOG: join(base, 'calls.log'), ANDROID_HOME: '', TMPDIR: join(base, 'tmp'), ...env,
    },
  });
  const calls = () => (existsSync(join(base, 'calls.log'))
    ? readFileSync(join(base, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  const said = () => calls().map((call) => [call.tool, ...call.args].join(' '));
  /** main as the owner leaves it by merging the release pull request for `version`. */
  const merged = (version, buildNumber) => {
    put('app/app.json', app(version, buildNumber));
    put('docs/USER-MANUAL.md', `# Manual\n\n*For app version ${version} · October 2026*\n\nHow to use it.\n`);
    put('docs/PHASE_STATUS.md', addEntry(LOG, ENTRY.replace('v0.2.1', `v${version}`)));
    git('commit', '--quiet', '-am', `chore(release): v${version}`);
    git('push', '--quiet', 'origin', 'main');
    return git('rev-parse', 'HEAD');
  };
  return { base, root, put, git, remote, run, calls, said, merged, entry: join(base, 'entry.md') };
}

describe('release, step 1: the release pull request', () => {
  it('opens it from origin/main, leaving main and this checkout alone', () => {
    const test = fixture();
    test.git('switch', '--quiet', '-c', 'work');
    test.put('docs/USER-MANUAL.md', 'unfinished edits\n');
    const main = test.remote('rev-parse', 'main');
    const result = test.run(['0.2.1', '--notes', test.entry]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    expect(test.remote('rev-parse', 'main')).toBe(main);
    expect(test.remote('rev-parse', 'release/v0.2.1^')).toBe(main);
    expect(test.remote('log', '-1', '--format=%B', 'release/v0.2.1')).toBe('chore(release): v0.2.1\n\nversionCode and iOS build 2001.');
    expect(test.remote('diff', '--name-only', 'main', 'release/v0.2.1').split('\n'))
      .toEqual(['app/app.json', 'docs/PHASE_STATUS.md', 'docs/USER-MANUAL.md', 'docs/USER-MANUAL.pdf']);
    const shipped = (path) => execFileSync('git', ['--git-dir', join(test.base, 'origin.git'), 'show', `release/v0.2.1:${path}`], { encoding: 'utf8' });
    expect(JSON.parse(shipped('app/app.json')).expo).toMatchObject({ version: '0.2.1', ios: { buildNumber: '2001' } });
    expect(shipped('docs/USER-MANUAL.md')).toContain('*For app version 0.2.1 · October 2026*');
    expect(shipped('docs/USER-MANUAL.pdf')).toBe('PDF 0.2.1\n');
    expect(shipped('docs/PHASE_STATUS.md')).toBe(LOG.replace('### 2026-10-01', `${ENTRY}\n### 2026-10-01`));

    expect(test.said()).toContain('sabeel-ci render-manual');
    expect(test.said()).toContain('gh auth status');
    const pr = test.calls().find((call) => call.tool === 'gh' && call.args[0] === 'pr');
    expect(pr.args).toEqual(['pr', 'create', '--repo', 'Sabeel-Institute/example', '--base', 'main', '--head', 'release/v0.2.1', '--title', 'v0.2.1 — Faster sign-in', '--body-file', expect.any(String)]);
    expect(pr.body).toBe('Sign-in takes one tap.\n');
    expect(result.stdout).toContain('gh pr merge https://github.com/Sabeel-Institute/example/pull/7 --merge --admin');

    expect(test.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('work');
    expect(test.git('status', '--porcelain')).toBe('M docs/USER-MANUAL.md');
    expect(test.git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it.each([
    ['0.2.1-beta.1', /Not releasing "0\.2\.1-beta\.1":\n {2}- "0\.2\.1-beta\.1" is not three/],
    ['0.2.0', /v0\.2\.0 \(versionCode 2000\) is not above main's 0\.2\.0 \(2000\)/],
    ['v0.2.1', /"v0\.2\.1" is not three period-separated integers \(X\.Y\.Z\) without leading zeros:\n {4}no pre-release suffix, no fourth component, no leading "v"/],
  ])('refuses %s before changing anything', (version, message) => {
    const test = fixture();
    const result = test.run([version, '--notes', test.entry]);
    expect(result.stderr).toMatch(message);
    expect(result.status).toBe(1);
    expect(test.remote('branch', '--list')).toBe('* main');
    expect(test.said().filter((call) => call.startsWith('gh '))).toEqual([]);
  });

  it('refuses a version that is released, or not above the last release, or already proposed', () => {
    const test = fixture();
    test.git('tag', 'v0.3.0');
    test.git('push', '--quiet', 'origin', 'v0.3.0');
    expect(test.run(['0.2.5', '--notes', test.entry]).stderr).toMatch(/v0\.2\.5 \(versionCode 2005\) is not above the last release, v0\.3\.0 \(3000\)/);
    expect(test.run(['0.3.0', '--notes', test.entry]).stderr).toContain('v0.3.0 is already released.');
    test.git('push', '--quiet', 'origin', 'main:refs/heads/release/v0.3.1');
    expect(test.run(['0.3.1', '--notes', test.entry]).stderr).toContain('release/v0.3.1 is already on origin');
    expect(test.said().filter((call) => call.startsWith('gh '))).toEqual([]);
  });

  it("takes the notes from --notes or from main's deploy log, never both", () => {
    const test = fixture();
    expect(test.run(['0.2.1', '--notes', test.entry], { NO_DEPLOY_NOTES: '1' }).stderr)
      .toContain('sabeel-ci: no command "deploy-notes"\nsabeel-ci deploy-notes stopped the release.');
    expect(test.run(['0.2.1']).stderr).toMatch(/main's docs\/PHASE_STATUS\.md has no entry for v0\.2\.1\. Pass --notes <file>/);
    writeFileSync(join(test.base, 'bare.md'), 'Sign-in takes one tap.\n');
    expect(test.run(['0.2.1', '--notes', join(test.base, 'bare.md')]).stderr).toMatch(/its first line is its heading:\n {4}### <YYYY-MM-DD> — <summary> — v0\.2\.1/);
    writeFileSync(join(test.base, 'other.md'), ENTRY.replace('v0.2.1', 'v0.2.2'));
    expect(test.run(['0.2.1', '--notes', join(test.base, 'other.md')]).stderr).toContain('The deploy-log entry does not name v0.2.1 in its heading');
    expect(test.remote('branch', '--list')).toBe('* main');

    test.put('docs/PHASE_STATUS.md', addEntry(LOG, ENTRY));
    test.git('commit', '--quiet', '-am', 'docs: v0.2.1 in the deploy log');
    test.git('push', '--quiet', 'origin', 'main');
    expect(test.run(['0.2.1', '--notes', test.entry]).stderr).toContain("main's docs/PHASE_STATUS.md already has v0.2.1's entry; drop --notes.");
    expect(test.run(['0.2.1']).status).toBe(0);
    expect(test.remote('diff', '--name-only', 'main', 'release/v0.2.1')).not.toContain('PHASE_STATUS');
  });

  it('--dry-run shows the change and leaves nothing behind', () => {
    const test = fixture();
    const result = test.run(['0.2.1', '--notes', test.entry, '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run: v0.2.1, versionCode and iOS build 2001, "v0.2.1 — Faster sign-in". Nothing was committed or pushed.');
    expect(test.remote('branch', '--list')).toBe('* main');
    expect(test.said().filter((call) => call.startsWith('gh '))).toEqual([]);
    expect(test.git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('refuses an app whose build.gradle states its own version', () => {
    const test = fixture();
    test.put('app/android/app/build.gradle', '        versionCode 38\n        versionName "0.2.0"\n');
    test.git('commit', '--quiet', '-am', 'a literal version');
    test.git('push', '--quiet', 'origin', 'main');
    const result = test.run(['0.2.1', '--notes', test.entry]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Not releasing v0\.2\.1:\n {2}- app\/android\/app\/build\.gradle must derive the version from app\.json/);
    expect(test.remote('branch', '--list')).toBe('* main');
  });

  it('adds an entry above the newest in the Deploy log section, and nowhere else', () => {
    expect(addEntry('## Deploy log\n\n## Decision log\n', ENTRY)).toBe(`## Deploy log\n\n${ENTRY}\n## Decision log\n`);
    expect(addEntry('## Deploy log\nIntro.\n', ENTRY)).toBe(`## Deploy log\nIntro.\n\n${ENTRY}\n`);
    expect(() => addEntry('## Verification log\n', ENTRY)).toThrow(/has no "## Deploy log" section/);
  });
});

const REPO = '--repo Sabeel-Institute/example';
const PUBLISH_RUNS = `gh run list ${REPO} --workflow android-publish.yml --event workflow_dispatch --json databaseId --limit 10`;
/** Publish Android dispatched with `flag`, found as run `id` among those listed `lists` times after, and watched. */
const publishAndroid = (flag, id, lists = 1) => [
  PUBLISH_RUNS,
  `gh workflow run android-publish.yml ${REPO} --ref main -f build_run_id=41 -f publish=${flag}`,
  ...Array(lists).fill(PUBLISH_RUNS),
  `gh run watch ${id} ${REPO} --exit-status --interval 30`,
];
/** Each recorded call, with ship's scratch directory as <out>. */
const shipped = (test) => test.said().map((call) => call.replace(/ \S*\/release-v0\.2\.1-\w+\//g, ' <out>/'));

describe('release, step 2: --ship', () => {
  it('publishes CI\'s bundle, checks the APK Play signs, then tags, in that order', () => {
    const test = fixture();
    const sha = test.merged('0.2.1');
    // A tag left in this clone that origin does not have is not a release.
    test.git('tag', 'v0.7.1');
    const refs = test.remote('show-ref');
    const result = test.run(['--ship']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(shipped(test)).toEqual([
      'sabeel-ci deploy-notes 0.2.1 --title',
      'sabeel-ci deploy-notes 0.2.1',
      `gh run list ${REPO} --workflow android.yml --branch main --commit ${sha} --json databaseId,status,conclusion,event --limit 5`,
      ...publishAndroid(false, 51),
      ...publishAndroid(true, 52),
      'sabeel-ci play-apk <out>/sabeel-example-universal.apk',
      `sabeel-ci check-release <out>/sabeel-example-universal.apk --commit ${sha} --out <out>/release-check`,
      `gh release view v0.2.1 ${REPO} --json isDraft`,
      `gh release create v0.2.1 ${REPO} --draft --target ${sha} --title v0.2.1 — Faster sign-in --notes-file <out>/notes.md <out>/sabeel-example-universal.apk docs/USER-MANUAL.pdf`,
      `gh release edit v0.2.1 ${REPO} --draft=false`,
      `gh run list ${REPO} --workflow web.yml --commit ${sha} --status success --json databaseId --limit 1`,
    ]);
    // Nothing on this machine builds, signs or uploads anything: Play gets CI's bundle, and the APK is Play's.
    expect(test.said().some((call) => /build-aab|build-info|publish-play|gradlew|apksigner|keytool/.test(call))).toBe(false);
    const release = test.calls().find((call) => call.args[0] === 'release' && call.args[1] === 'create');
    expect(release.notes).toBe('Sign-in takes one tap.\n');
    expect(release.assets.map((asset) => asset.path.replace(/^\S*\/release-v0\.2\.1-\w+\//, '<out>/'))).toEqual(['<out>/sabeel-example-universal.apk', 'docs/USER-MANUAL.pdf']);
    expect(release.assets.every((asset) => asset.exists)).toBe(true);
    expect(result.stdout).toContain("Play internal testing with CI's bundle (Android run 41), and the GitHub release with the APK Play signs");
    expect(result.stdout).toContain('gh workflow run web-deploy.yml --repo Sabeel-Institute/example -f build_run_id=99 -f deploy=true');
    expect(result.stdout).toContain('gh workflow run ios.yml --repo Sabeel-Institute/example --ref v0.2.1 -f testflight=true');
    // Nothing is pushed: the tag is GitHub's, made by publishing the release.
    expect(test.remote('show-ref')).toBe(refs);
  });

  it('replaces a draft release a failed ship left behind', () => {
    const test = fixture();
    test.merged('0.2.1');
    const result = test.run(['--ship'], { DRAFT_RELEASE: '1' });
    expect(result.status).toBe(0);
    const said = shipped(test);
    expect(said.indexOf(`gh release delete v0.2.1 ${REPO} --yes`)).toBe(said.findIndex((call) => call.startsWith('gh release create')) - 1);
  });

  it('watches the run its dispatch started, not the check run GitHub still lists newest', () => {
    const test = fixture();
    const sha = test.merged('0.2.1');
    const result = test.run(['--ship'], { PUBLISH_LAG: '1' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(shipped(test).slice(3, 13)).toEqual([...publishAndroid(false, 51, 2), ...publishAndroid(true, 52, 2)]);
    expect(test.said()).not.toContain(`gh run watch 50 ${REPO} --exit-status --interval 30`);
    expect(shipped(test)[2]).toContain(sha);
  }, 30_000);

  it('waits for the Android build still going, then publishes its bundle', () => {
    const test = fixture();
    test.merged('0.2.1');
    const result = test.run(['--ship'], { ANDROID_RUNS: JSON.stringify([{ databaseId: 41, status: 'in_progress', conclusion: '', event: 'push' }]) });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Waiting for the Android build of');
    const said = test.said();
    expect(said.indexOf('gh run watch 41 --repo Sabeel-Institute/example --exit-status --interval 30'))
      .toBeLessThan(said.findIndex((call) => call.startsWith('gh workflow run android-publish.yml')));
  });

  it('ships only a clean main that origin has', () => {
    const test = fixture();
    test.merged('0.2.1');
    test.git('switch', '--quiet', '-c', 'work');
    expect(test.run(['--ship']).stderr).toContain('Ship from main, not work');
    test.git('switch', '--quiet', 'main');
    test.put('docs/USER-MANUAL.md', 'unfinished edits\n');
    expect(test.run(['--ship']).stderr).toContain('The working tree has uncommitted changes');
    test.git('commit', '--quiet', '-am', 'local only');
    expect(test.run(['--ship']).stderr).toMatch(/main here is \w{7}, origin's is \w{7}/);
    expect(test.calls()).toEqual([]);
  });

  it('refuses a released version, one below the last release, and numbers that disagree', () => {
    const test = fixture();
    test.merged('0.2.1');
    test.git('tag', 'v0.2.1');
    test.git('push', '--quiet', 'origin', 'v0.2.1');
    let result = test.run(['--ship']);
    expect(result.stderr).toContain('v0.2.1 is already released. If Play did not take it, run Publish Android on its Android build:');
    test.git('push', '--quiet', 'origin', ':refs/tags/v0.2.1', 'main:refs/tags/v0.3.0');
    expect(test.run(['--ship']).stderr).toContain('is not above the last release, v0.3.0');
    test.git('push', '--quiet', 'origin', ':refs/tags/v0.3.0');
    test.merged('0.2.2', '17');
    result = test.run(['--ship']);
    expect(result.stderr).toMatch(/Not releasing v0\.2\.2:\n {2}- app\/app\.json's expo\.ios\.buildNumber is "17"; version 0\.2\.2's is "2002"/);
    expect(test.calls()).toEqual([]);
  });

  it.each([
    ['the Android build', { ANDROID_RUNS: JSON.stringify([{ databaseId: 41, status: 'completed', conclusion: 'failure', event: 'push' }]) },
      /The Android build of \w{7} did not pass \(run 41\), and Play gets only a bundle that did\.\n {4}Rerun it \(gh run rerun 41/],
    ['the Android build still going', { ANDROID_RUNS: JSON.stringify([{ databaseId: 41, status: 'in_progress', conclusion: '', event: 'push' }]), FAIL_WATCH: '41' },
      /did not pass \(run 41\)/],
    ["Publish Android's check", { FAIL_WATCH: '51' }, /Publish Android's check of run 41's bundle failed \(above\); nothing was tagged or uploaded/],
  ])('stops before Play when %s fails', (_, env, message) => {
    const test = fixture();
    test.merged('0.2.1');
    const result = test.run(['--ship'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(test.said().filter((call) => call.endsWith('publish=true') || call.startsWith('gh release'))).toEqual([]);
  });

  it.each([
    ['the Play upload', { FAIL_WATCH: '52' }, /^Play internal testing did not take run 41's bundle \(above\)\. Nothing was tagged/m, 'gh run watch 52'],
    ["Play's APK", { FAIL_PLAY_APK: '1' }, /^v0\.2\.1 is on Play internal testing, but sabeel-ci play-apk .* stopped the release[\s\S]*Nothing was tagged/m, 'sabeel-ci play-apk'],
    ['the cold start of Play\'s APK', { FAIL_CHECK_RELEASE: '1' }, /^v0\.2\.1 is on Play internal testing, but sabeel-ci check-release .* stopped the release[\s\S]*Nothing was tagged/m, 'sabeel-ci check-release'],
    ['the draft release', { FAIL_RELEASE: 'create' }, /^v0\.2\.1 is on Play internal testing, but its GitHub release could not be made \(above\)\. Nothing was tagged/m, 'gh release create'],
  ])('leaves no tag when %s fails, and says to ship again', (_, env, message, last) => {
    const test = fixture();
    test.merged('0.2.1');
    const result = test.run(['--ship'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain('ship again: npx sabeel-ci release --ship\n    (Publish Android finds the bundle Play already holds and does not upload it twice)');
    expect(shipped(test).at(-1)).toMatch(new RegExp(`^${last}`));
    expect(test.said().some((call) => call.startsWith('gh release edit'))).toBe(false);
  });

  it('says how to publish the draft when publishing it fails, the one step after which the tag exists', () => {
    const test = fixture();
    test.merged('0.2.1');
    const result = test.run(['--ship'], { FAIL_RELEASE: 'edit' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('v0.2.1 is on Play internal testing, but its draft GitHub release, which holds the notes, Play\'s APK and the manual, was not published (above).');
    expect(result.stderr).toContain(`Publishing it creates the tag: gh release edit v0.2.1 ${REPO} --draft=false`);
  });

  it("releases only in the Institute's own repositories", () => {
    const test = fixture();
    test.merged('0.2.1');
    test.git('config', `url.${join(test.base, 'origin.git')}.insteadOf`, 'git@github.com:someone/example.git');
    test.git('remote', 'set-url', 'origin', 'git@github.com:someone/example.git');
    for (const args of [['--ship'], ['0.2.2', '--notes', test.entry]]) {
      expect(test.run(args).stderr).toContain('origin is git@github.com:someone/example.git, not a Sabeel-Institute repository on GitHub');
    }
    expect(test.calls()).toEqual([]);
  });

  it('takes no other arguments', () => {
    const test = fixture();
    for (const args of [['--ship', '--dry-run'], [], ['--notes'], ['0.2.1', '0.2.2']]) {
      expect(test.run(args).status, args.join(' ')).toBe(2);
    }
  });
});
