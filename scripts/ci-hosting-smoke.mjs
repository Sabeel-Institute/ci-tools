import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { treeHashes } from './ci-platform.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function smokePlan(artifact, origin) {
  const build = JSON.parse(readFileSync(join(artifact, 'build-record.json'), 'utf8'));
  const site = join(artifact, 'site');
  if (JSON.stringify(treeHashes(site)) !== JSON.stringify(build.files)) {
    throw new Error('Web artifact checksum mismatch');
  }
  const paths = new Map([['/', 'index.html'], ['/privacy', 'privacy.html'], ['/support', 'support.html']]);
  const html = readFileSync(join(site, 'index.html'), 'utf8');
  let scripts = 0;
  for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    if (tag[1].toLowerCase() === 'link' && !/\brel=["']stylesheet["']/i.test(tag[0])) continue;
    const attribute = /\b(?:src|href)=["']([^"']+)["']/i.exec(tag[0]);
    if (!attribute) continue;
    const url = new URL(attribute[1].replaceAll('&amp;', '&'), origin);
    if (url.origin !== origin) continue;
    const file = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (!Object.hasOwn(build.files, file)) throw new Error('HTML references an asset missing from the artifact');
    paths.set(url.pathname + url.search, file);
    if (tag[1].toLowerCase() === 'script') scripts += 1;
  }
  if (!scripts) throw new Error('No same-origin application script found');
  for (const file of ['firebase-messaging-sw.js', 'get-app.html']) {
    if (Object.hasOwn(build.files, file)) paths.set('/' + file, file);
  }
  return [...paths].map(([path, file]) => {
    if (!Object.hasOwn(build.files, file)) throw new Error('Required page missing: ' + file);
    return { path, hash: build.files[file] };
  });
}

export function hostingChecks(input) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.project ?? '')) throw new Error('Invalid Firebase project ID');
  const build = JSON.parse(readFileSync(join(input.artifact, 'build-record.json'), 'utf8'));
  if (build.platform !== 'web' || build.ref !== 'refs/heads/main'
    || build.commit !== input.commit || build.repository !== input.repository
    || String(build.repositoryId) !== input.repositoryId || String(build.runId) !== input.runId) {
    throw new Error('Smoke test artifact provenance mismatch');
  }
  const origin = 'https://' + input.project + '.web.app';
  const checks = smokePlan(input.artifact, origin);
  return { origin, checks };
}

export async function verifyHosting(input, { request = fetch, pause = setTimeout } = {}) {
  const { origin, checks } = hostingChecks(input);
  await verifyChecks(origin, checks, input.runId, { request, pause });
  console.log('Read-only Hosting verification passed; no backend data was accessed or changed');
}

/** Each planned path, fetched from the live site, must be byte for byte the artifact's file. */
async function verifyChecks(origin, checks, tag, { request, pause }) {
  for (const check of checks) {
    let passed = false;
    let failure;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const url = new URL(check.path, origin);
        url.searchParams.set('sabeel_smoke', tag + '-' + Date.now() + '-' + attempt);
        const response = await request(url, {
          method: 'GET', redirect: 'error', credentials: 'omit',
          headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (digest(bytes) !== check.hash) throw new Error('Published content does not match the selected artifact');
        passed = true;
        break;
      } catch (error) {
        failure = error;
        if (attempt < 2) await pause(5000);
      }
    }
    if (!passed) throw new Error('Read-only Hosting check failed for ' + check.path + ': ' + failure.message);
    console.log('Verified GET ' + check.path);
  }
}

/**
 * The build commit build-info stamps into the scripts, `+` after it when built
 * from uncommitted changes, or null. The minifier keeps it as BUILD_INFO's
 * `commit:"<hash>"`, or folds it into the `v<version> · <hash>` label every app
 * shows, the dot then escaped.
 */
export function stampedCommit(scripts) {
  for (const text of scripts) {
    const match = /\bcommit\s*:\s*["']([0-9a-f]{7,40})(\+?)["']/.exec(text)
      ?? /(?:·|\\xb7|\\u00b7) ([0-9a-f]{7,40})(\+?)[`"']/.exec(text);
    if (match) return { commit: match[1], dirty: match[2] === '+' };
  }
  return null;
}

/**
 * The live site, between deploys: it must serve, byte for byte, the build CI
 * made of the commit its scripts are stamped with. `findBuild(commit)` names
 * that build's artifact directory (the Web workflow's web-hosting artifact),
 * or null when main has no successful Web build of the commit, which means
 * the site was published from somewhere else.
 */
export async function verifyLive(origin, findBuild, { request = fetch, pause = setTimeout } = {}) {
  const get = async (path) => {
    const url = new URL(path, origin);
    url.searchParams.set('sabeel_nightly', String(Date.now()));
    const response = await request(url, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return response.text();
  };
  const html = await get('/');
  const scripts = [];
  for (const tag of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const url = new URL(tag[1].replaceAll('&amp;', '&'), origin);
    if (url.origin === origin) scripts.push(await get(url.pathname + url.search));
  }
  if (!scripts.length) throw new Error(`${origin} serves no same-origin script: the app cannot start`);
  const stamp = stampedCommit(scripts);
  if (!stamp) throw new Error(`${origin}'s scripts carry no build commit stamp (build-info)`);
  if (stamp.dirty) throw new Error(`${origin} serves a build made from uncommitted changes (${stamp.commit}+), not one CI built`);
  const artifact = await findBuild(stamp.commit);
  if (!artifact) {
    throw new Error(`${origin} serves a build of ${stamp.commit}, which has no successful Web build on main: it was not published from CI's build`);
  }
  await verifyChecks(origin, smokePlan(artifact, origin), stamp.commit, { request, pause });
  console.log(`${origin} serves CI's build of ${stamp.commit}, every file checked; nothing was signed in to or changed`);
}

/** main's successful Web build of `commit`, downloaded with gh into a fresh directory, or null. */
function webBuildOf(commit) {
  const repository = process.env.GITHUB_REPOSITORY;
  const runs = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/workflows/web.yml/runs?branch=main&status=success&per_page=100`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).workflow_runs;
  const build = runs.find((run) => run.head_sha.startsWith(commit));
  if (!build) return null;
  const directory = mkdtempSync(join(tmpdir(), 'live-web-'));
  execFileSync('gh', ['run', 'download', String(build.id), '--repo', repository, '--name', `web-hosting-${build.head_sha}`, '--dir', directory],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  return directory;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url) && process.argv[2] === '--live') {
  const project = JSON.parse(readFileSync('.firebaserc', 'utf8')).projects?.default;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? '')) throw new Error('.firebaserc names no default project');
  await verifyLive(`https://${project}.web.app`, webBuildOf);
} else if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const input = {
    artifact: join(process.env.RUNNER_TEMP, 'hosting-artifact'),
    project: process.env.FIREBASE_PROJECT_ID,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    runId: process.env.BUILD_RUN_ID,
  };
  if (process.argv[2] === '--preflight') {
    hostingChecks(input);
    console.log('Hosting smoke-check plan validated without network access');
  } else {
    await verifyHosting(input);
  }
}
