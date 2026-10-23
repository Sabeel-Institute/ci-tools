import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidIdentity, buildNumber, versionCode, versionProblems } from '../lib/version.mjs';

/**
 * Release an app, the same way for every app, in two steps, because main takes
 * changes only by pull request and only the owner merges and tags:
 *
 *   sabeel-ci release <X.Y.Z> [--notes <entry.md>] [--dry-run]   # 1. open the release pull request
 *   sabeel-ci release --ship                                      # 2. on main, once the owner has merged it
 *
 * Step 1 works from origin/main in a worktree of its own, leaving the checkout
 * it runs in as it is. It writes the version where it lives: app.json's
 * expo.version, and the iOS build number that follows from it (lib/version.mjs);
 * Gradle derives Android's. It moves the manual's "For app version" line,
 * renders docs/USER-MANUAL.pdf (`sabeel-ci render-manual`), and adds the deploy-log entry --notes holds to
 * docs/PHASE_STATUS.md, unless main already has the version's entry. That is
 * committed as `chore(release): v<version>` on release/v<version>, which is
 * pushed, and the pull request into main is opened. It never pushes main.
 * --dry-run does all of it but the commit, shows the change and leaves nothing
 * behind.
 *
 * Step 2 releases the merged commit, without building or signing anything on
 * this machine:
 *
 *  - Play gets the bundle CI built from that commit: the Android workflow's,
 *    signed in its release-build environment, its gates passed (`build-aab`)
 *    and cold-started five times on an emulator. Step 2 waits for that run if
 *    it is still going and refuses one that failed, then has Publish Android
 *    check the bundle and Play's permission, and upload it to Play internal
 *    testing;
 *  - the APK on the GitHub release is the universal one Play generated from
 *    that bundle, signed exactly as Play installs it (`sabeel-ci play-apk`,
 *    refusing any signer but release.appSigningCertificate), so a sideloaded
 *    install and Play's update each other. It is cold-started on an emulator
 *    (`sabeel-ci check-release`);
 *  - last, the GitHub release v<version> at that commit, with the APK and the
 *    manual, titled and described by the version's deploy-log entry: made as
 *    a draft, then published, which creates the tag, which only the owner
 *    may. The tag comes last because the APK exists only once Play has the
 *    bundle: a tagged release therefore always has its notes, its APK and its
 *    manual, and names a version testers have. Until then a failure leaves
 *    no tag, and shipping again resumes: Publish Android does not upload a
 *    bundle Play already holds, and a draft left behind is replaced.
 *
 * Then it prints the runs that release the same commit to the web (Deploy Web,
 * with this commit's Web build) and to iPhones (the iOS workflow on the tag).
 *
 * Before anything is built, pushed or tagged it refuses: a version that is not
 * X.Y.Z (lib/version.mjs); one whose versionCode is not above main's and every
 * released tag's, since Android refuses an upgrade that does not increase and
 * Play spends a code once; a tag or release branch that exists; a ship from
 * anything but a clean main that matches origin; and version numbers or a
 * manual that disagree with app.json.
 */

const MANUAL = 'docs/USER-MANUAL.md';
const MANUAL_PDF = 'docs/USER-MANUAL.pdf';
const MANUAL_LINE = /^(\*For app version )(\S+)( · )/m;
const DEPLOY_LOG = 'docs/PHASE_STATUS.md';
const DEPLOY_LOG_SECTION = '## Deploy log';
const USAGE = `usage: sabeel-ci release <X.Y.Z> [--notes <entry.md>] [--dry-run]   open the release pull request
       sabeel-ci release --ship                                      on main, once the owner has merged it`;

const run = (program, args, options = {}) => (execFileSync(program, args, {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], ...options,
}) ?? '').trim();
const show = (program, args, options = {}) => execFileSync(program, args, { stdio: 'inherit', ...options });
const git = (...args) => run('git', args);
const list = (problems) => problems.map((problem) => `  - ${problem}`).join('\n');

/** A sibling command, through the sabeel-ci that started this one; its own output says why it stopped. */
function sabeelCi(args, options = {}) {
  try {
    return run(process.execPath, [join(process.env.CI_TOOLS, 'bin/sabeel-ci.mjs'), ...args], options);
  } catch {
    throw new Error(`sabeel-ci ${args.join(' ')} stopped the release; it says why above.`);
  }
}

/**
 * Where the app's version is written, disagreeing with app.json's expo.version:
 * build.gradle stating its own, the iOS build number, the manual's line.
 * `check-app` asks this on every pull request, and step 2 before it builds.
 */
export function versionedFileProblems(root = '.') {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const app = JSON.parse(read('app/app.json')).expo;
  const problems = versionProblems(app.version).map((problem) => `app/app.json's expo.version: ${problem}`);
  if (problems.length) return problems;
  try {
    androidIdentity(app, read('app/android/app/build.gradle'));
  } catch (error) {
    problems.push(error.message);
  }
  if (app.ios && app.ios.buildNumber !== buildNumber(app.version)) {
    problems.push(`app/app.json's expo.ios.buildNumber is ${JSON.stringify(app.ios.buildNumber)}; version ${app.version}'s is "${buildNumber(app.version)}",\n`
      + '    its versionCode. `sabeel-ci release` writes it with the version.');
  }
  const stated = existsSync(join(root, MANUAL)) ? MANUAL_LINE.exec(read(MANUAL))?.[2] : undefined;
  if (stated !== app.version) {
    problems.push(stated === undefined
      ? `${MANUAL} has no "*For app version <X.Y.Z> · <Month YYYY>*" line`
      : `${MANUAL} says "For app version ${stated}", app/app.json ${app.version}. \`sabeel-ci release\` moves the line and renders the PDF with the version.`);
  }
  return problems;
}

/** The deploy log with `entry` added as its newest entry, above the others in the Deploy log section. */
export function addEntry(log, entry) {
  const lines = log.replace(/\n$/, '').split('\n');
  const section = lines.findIndex((line) => line.trim() === DEPLOY_LOG_SECTION);
  if (section < 0) throw new Error(`${DEPLOY_LOG} has no "${DEPLOY_LOG_SECTION}" section to add the entry to.`);
  let end = lines.findIndex((line, index) => index > section && /^##? /.test(line));
  if (end < 0) end = lines.length;
  const newest = lines.findIndex((line, index) => index > section && index < end && line.startsWith('### '));
  const at = newest >= 0 ? newest : end;
  const before = lines[at - 1]?.trim() === '' ? [] : [''];
  return [...lines.slice(0, at), ...before, ...entry.trim().split('\n'), '', ...lines.slice(at)].join('\n') + '\n';
}

/** origin as GitHub's owner/name. Releases are made in the Institute's own repositories only. */
function githubRepository() {
  const url = git('config', '--get', 'remote.origin.url');
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (match?.[1] !== 'Sabeel-Institute') throw new Error(`origin is ${url}, not a Sabeel-Institute repository on GitHub; releases are made only there.`);
  return `${match[1]}/${match[2]}`;
}

/** The release tags on origin, as versions, newest first. A tag that is not X.Y.Z (an old pre-release) is not a release. */
function releasedVersions() {
  return git('ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*').split('\n').filter(Boolean)
    .map((line) => line.split('refs/tags/v')[1])
    .filter((version) => versionProblems(version).length === 0)
    .sort((a, b) => versionCode(b) - versionCode(a));
}

/** Why `version` cannot follow the released versions (newest first), or null. */
function releasedProblem(version, released) {
  if (released.includes(version)) return `v${version} is already released.`;
  const code = versionCode(version);
  if (released[0] && code <= versionCode(released[0])) {
    return `v${version} (versionCode ${code}) is not above the last release, v${released[0]} (${versionCode(released[0])}):\n`
      + '    Android refuses an upgrade that does not increase, and Play takes each code once.';
  }
  return null;
}

/** Step 1: the version, as a pull request into main. */
function prepare(version, notesPath, dryRun) {
  const shape = versionProblems(version);
  if (shape.length) throw new Error(`Not releasing "${version}":\n${list(shape)}`);
  let entry = null;
  if (notesPath !== undefined) {
    try {
      entry = readFileSync(notesPath, 'utf8');
    } catch {
      throw new Error(`--notes ${notesPath}: no such file (a path from the app's root).`);
    }
  }
  if (entry !== null && !/^### \S/.test(entry.trimStart())) {
    throw new Error(`${notesPath} is the deploy-log entry, so its first line is its heading:\n    ### <YYYY-MM-DD> — <summary> — v${version}`);
  }
  const repository = githubRepository();
  show('git', ['fetch', '--quiet', 'origin', 'main']);
  const main = JSON.parse(git('show', 'origin/main:app/app.json')).expo.version;
  if (versionProblems(main).length) throw new Error(`main's app/app.json holds "${main}", which is not a version; fix that first.`);
  if (versionCode(version) <= versionCode(main)) {
    throw new Error(`v${version} (versionCode ${versionCode(version)}) is not above main's ${main} (${versionCode(main)}).`);
  }
  const problem = releasedProblem(version, releasedVersions());
  if (problem) throw new Error(problem);
  const branch = `release/v${version}`;
  if (git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) throw new Error(`${branch} is already on origin; its pull request: gh pr view ${branch}`);
  if (!dryRun) {
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    } catch {
      throw new Error('gh is not signed in to GitHub, which opens the pull request: gh auth login');
    }
  }

  const tree = mkdtempSync(join(tmpdir(), `release-v${version}-`));
  try {
    git('worktree', 'add', '--quiet', '--detach', tree, 'origin/main');
    const notes = (...args) => sabeelCi(['deploy-notes', version, ...args], { cwd: tree });
    // deploy-notes exits 1 when the log has no entry for the version; anything
    // else is a failure of its own, which it has explained.
    const probe = spawnSync(process.execPath, [join(process.env.CI_TOOLS, 'bin/sabeel-ci.mjs'), 'deploy-notes', version],
      { cwd: tree, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (probe.status !== 0 && probe.status !== 1) throw new Error(`${probe.stderr.trim()}\nsabeel-ci deploy-notes stopped the release.`);
    const logged = probe.status === 0;
    if (logged && entry !== null) throw new Error(`main's ${DEPLOY_LOG} already has v${version}'s entry; drop --notes.`);
    if (!logged && entry === null) {
      throw new Error(`main's ${DEPLOY_LOG} has no entry for v${version}. Pass --notes <file> holding it:\n`
        + `    ### <YYYY-MM-DD> — <summary> — v${version}, then the release notes.`);
    }
    if (entry !== null) writeFileSync(join(tree, DEPLOY_LOG), addEntry(readFileSync(join(tree, DEPLOY_LOG), 'utf8'), entry));

    const appJson = join(tree, 'app/app.json');
    const manifest = JSON.parse(readFileSync(appJson, 'utf8'));
    manifest.expo.version = version;
    if (manifest.expo.ios) manifest.expo.ios.buildNumber = buildNumber(version);
    writeFileSync(appJson, JSON.stringify(manifest, null, 2) + '\n');
    const manual = readFileSync(join(tree, MANUAL), 'utf8');
    if (!MANUAL_LINE.test(manual)) throw new Error(`${MANUAL} has no "*For app version <X.Y.Z> · <Month YYYY>*" line to move.`);
    writeFileSync(join(tree, MANUAL), manual.replace(MANUAL_LINE, `$1${version}$3`));
    sabeelCi(['render-manual'], { cwd: tree, stdio: 'inherit' });
    const problems = versionedFileProblems(tree);
    if (problems.length) throw new Error(`Not releasing v${version}:\n${list(problems)}`);
    let title;
    try {
      title = notes('--title');
    } catch {
      throw new Error(`The deploy-log entry does not name v${version} in its heading: ### <YYYY-MM-DD> — <summary> — v${version}`);
    }
    const body = join(tree, '.release-notes.md');
    writeFileSync(body, notes() + '\n');

    const code = versionCode(version);
    if (dryRun) {
      show('git', ['-C', tree, 'diff', '--stat']);
      console.log(`\nDry run: v${version}, versionCode and iOS build ${code}, "${title}". Nothing was committed or pushed.`);
      return;
    }
    git('-C', tree, 'add', '--', 'app/app.json', MANUAL, MANUAL_PDF, DEPLOY_LOG);
    git('-C', tree, 'commit', '--quiet', '-m', `chore(release): v${version}`, '-m', `versionCode and iOS build ${code}.`);
    show('git', ['-C', tree, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    const url = run('gh', ['pr', 'create', '--repo', repository, '--base', 'main', '--head', branch, '--title', title, '--body-file', body]).split('\n').at(-1);
    console.log(`\nThe release pull request for v${version}: ${url}\n`
      + `Once its checks pass, the owner merges it (gh pr merge ${url} --merge --admin). Then, on main:\n`
      + '  git switch main && git pull --ff-only\n'
      + '  npx sabeel-ci release --ship');
  } finally {
    try {
      git('worktree', 'remove', '--force', tree);
    } catch {
      // A worktree never added leaves only the directory, removed below.
    }
    rmSync(tree, { recursive: true, force: true });
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `gh run watch` on a run until it ends; false when it failed. */
function watched(repository, id) {
  try {
    show('gh', ['run', 'watch', String(id), '--repo', repository, '--exit-status', '--interval', '30']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Android workflow's run that built `sha` from main, once it has passed:
 * its bundle is the one Play gets. Waits for a run still going; a merge
 * starts one, which can take a minute to appear.
 */
function androidBuild(repository, sha) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const runs = JSON.parse(run('gh', ['run', 'list', '--repo', repository, '--workflow', 'android.yml', '--branch', 'main',
      '--commit', sha, '--json', 'databaseId,status,conclusion,event', '--limit', '5']))
      .filter((build) => ['push', 'workflow_dispatch'].includes(build.event));
    const passed = runs.find((build) => build.conclusion === 'success');
    if (passed) return passed.databaseId;
    const going = runs.find((build) => build.status !== 'completed');
    if (going) {
      console.log(`Waiting for the Android build of ${sha.slice(0, 7)} (run ${going.databaseId}), whose bundle Play gets…`);
      if (watched(repository, going.databaseId)) return going.databaseId;
    }
    if (runs.length) {
      const failed = (going ?? runs[0]).databaseId;
      throw new Error(`The Android build of ${sha.slice(0, 7)} did not pass (run ${failed}), and Play gets only a bundle that did.\n`
        + `    Rerun it (gh run rerun ${failed} --repo ${repository} --failed), then ship again.`);
    }
    sleep(30_000);
  }
  throw new Error(`The Android workflow has not built ${sha.slice(0, 7)}. Start it, then ship again:\n`
    + `    gh workflow run android.yml --repo ${repository} --ref main`);
}

/** Whether v<version> is a draft GitHub release, as a failed ship leaves one; a draft has no tag. */
function draftRelease(repository, version) {
  try {
    return JSON.parse(run('gh', ['release', 'view', `v${version}`, '--repo', repository, '--json', 'isDraft'],
      { stdio: ['ignore', 'pipe', 'ignore'] })).isDraft === true;
  } catch {
    return false;
  }
}

/**
 * Publish Android on CI's bundle from Android run `id`: with `publish`
 * false it checks the bundle and Play's permission and uploads nothing.
 * Returns whether the run passed.
 */
function publishAndroid(repository, id, publish) {
  // GitHub's clock, not this machine's, stamps the run; allow for a minute between them.
  const since = Date.now() - 60_000;
  run('gh', ['workflow', 'run', 'android-publish.yml', '--repo', repository, '--ref', 'main',
    '-f', `build_run_id=${id}`, '-f', `publish=${publish}`]);
  for (let attempt = 0; attempt < 24; attempt++) {
    const dispatched = JSON.parse(run('gh', ['run', 'list', '--repo', repository, '--workflow', 'android-publish.yml',
      '--event', 'workflow_dispatch', '--json', 'databaseId,createdAt', '--limit', '5']))
      .find((started) => Date.parse(started.createdAt) >= since);
    if (dispatched) return watched(repository, dispatched.databaseId);
    sleep(5_000);
  }
  throw new Error('Publish Android was started but no run of it appeared; see the repository\'s Actions tab.');
}

/** The Web workflow's successful run for `sha`, or null. */
function webBuild(repository, sha) {
  try {
    return JSON.parse(run('gh', ['run', 'list', '--repo', repository, '--workflow', 'web.yml', '--commit', sha, '--status', 'success', '--json', 'databaseId', '--limit', '1'],
      { stdio: ['ignore', 'pipe', 'ignore'] }))[0]?.databaseId ?? null;
  } catch {
    return null;
  }
}

/** Step 2: release the merged commit: CI's bundle to Play, Play's APK checked, then the tag. */
function ship() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Error(`Ship from main, not ${branch}: once the owner has merged the release pull request,\n    git switch main && git pull --ff-only`);
  const repository = githubRepository();
  if (git('status', '--porcelain')) throw new Error('The working tree has uncommitted changes, and a release is built from a commit. Commit or stash them.');
  const sha = git('rev-parse', 'HEAD');
  const origin = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
  if (sha !== origin) {
    throw new Error(`main here is ${sha.slice(0, 7)}, origin's is ${origin.slice(0, 7)}. A release tags a commit GitHub has:\n    git pull --ff-only, until they agree.`);
  }
  const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
  const { version, slug } = app;
  const problems = versionedFileProblems();
  if (!slug) problems.push("app/app.json has no expo.slug, which names the APK");
  if (problems.length) throw new Error(`Not releasing v${version}:\n${list(problems)}`);
  const released = releasedVersions();
  if (released.includes(version)) {
    throw new Error(`v${version} is already released. If Play did not take it, run Publish Android on its Android build:\n`
      + `    gh workflow run android-publish.yml --repo ${repository} --ref main -f build_run_id=<the Android run> -f publish=true\n`
      + 'Otherwise open the next version: npx sabeel-ci release <X.Y.Z> --notes <entry.md>');
  }
  const problem = releasedProblem(version, released);
  if (problem) throw new Error(problem);
  const title = sabeelCi(['deploy-notes', version, '--title']);
  const notes = sabeelCi(['deploy-notes', version]);

  const inherit = { stdio: 'inherit' };
  const out = mkdtempSync(join(tmpdir(), `release-v${version}-`));
  const android = androidBuild(repository, sha);
  if (!publishAndroid(repository, android, false)) {
    throw new Error(`Publish Android's check of run ${android}'s bundle failed (above); nothing was tagged or uploaded.`);
  }
  const rerun = 'Nothing was tagged. Once that is fixed, ship again: npx sabeel-ci release --ship\n'
    + '    (Publish Android finds the bundle Play already holds and does not upload it twice)';
  if (!publishAndroid(repository, android, true)) throw new Error(`Play internal testing did not take run ${android}'s bundle (above). ${rerun}`);
  const onPlay = `v${version} is on Play internal testing, but`;
  const apk = join(out, `${slug}-universal.apk`);
  try {
    sabeelCi(['play-apk', apk], inherit);
    sabeelCi(['check-release', apk, '--commit', sha, '--out', join(out, 'release-check')], inherit);
  } catch (error) {
    throw new Error(`${onPlay} ${error.message}\n${rerun}`);
  }

  // A draft holds the notes, the APK and the manual; publishing it creates the
  // tag, so a tagged release always has all three. A draft a failed ship left
  // behind is replaced.
  if (draftRelease(repository, version)) run('gh', ['release', 'delete', `v${version}`, '--repo', repository, '--yes']);
  const notesFile = join(out, 'notes.md');
  writeFileSync(notesFile, notes + '\n');
  try {
    show('gh', ['release', 'create', `v${version}`, '--repo', repository, '--draft', '--target', sha, '--title', title, '--notes-file', notesFile, apk, MANUAL_PDF]);
  } catch {
    throw new Error(`${onPlay} its GitHub release could not be made (above). ${rerun}`);
  }
  try {
    show('gh', ['release', 'edit', `v${version}`, '--repo', repository, '--draft=false']);
  } catch {
    throw new Error(`${onPlay} its draft GitHub release, which holds the notes, Play's APK and the manual, was not published (above).\n`
      + `Publishing it creates the tag: gh release edit v${version} --repo ${repository} --draft=false`);
  }
  const web = webBuild(repository, sha);
  console.log(`\nv${version} is released at ${sha.slice(0, 7)}: Play internal testing with CI's bundle (Android run ${android}), and the GitHub release`
    + ` with the APK Play signs. The release check's screens are in ${join(out, 'release-check')}.\nThe same commit to the web and to iPhones:\n`
    + `  gh workflow run web-deploy.yml --repo ${repository} -f build_run_id=${web ?? `<the Web run for ${sha.slice(0, 7)}, once it has passed>`} -f deploy=true\n`
    + `  gh workflow run ios.yml --repo ${repository} --ref v${version} -f testflight=true`);
}

function main(args) {
  if (!process.env.CI_TOOLS) throw new Error('Run this as `npx sabeel-ci release`, which names ci-tools in CI_TOOLS.');
  if (args.length === 1 && args[0] === '--ship') return ship();
  let version;
  let notes;
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--dry-run' && !dryRun) dryRun = true;
    else if (args[index] === '--notes' && notes === undefined && args[index + 1]) notes = args[++index];
    else if (version === undefined && !args[index].startsWith('-')) version = args[index];
    else version = null;
  }
  if (!version) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  prepare(version, notes, dryRun);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  }
}
