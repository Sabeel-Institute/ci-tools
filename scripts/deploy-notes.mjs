import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The release notes for a version, from the app's deploy log.
 *
 *   sabeel-ci deploy-notes <version>           # the entry's body
 *   sabeel-ci deploy-notes <version> --title   # "v<version> — <summary>"
 *
 * The deploy log is docs/PHASE_STATUS.md, one entry per release headed
 * `### <date> — <summary> — v<version>`, newest first. It is the one record of
 * what a release holds and why, so it is written before the build, not after it
 * from memory: `build-aab` refuses to build a version it has no entry for, and
 * `check-app` says so on the pull request that bumps the version. Release
 * tooling takes the GitHub release's title and notes from it.
 */
export const DEPLOY_LOG = 'docs/PHASE_STATUS.md';

const VERSION = /^\d+\.\d+\.\d+$/;

/** The newest entry for `version` in the deploy log's text: { title, body }, or null. */
export function deployNotes(markdown, version) {
  const lines = markdown.split('\n');
  // `v0.12.2`, not the start of `v0.12.20` or `v0.12.2.1`.
  const heading = new RegExp(`^###\\s+.*\\bv${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\.?\\w)`);
  const at = lines.findIndex((line) => heading.test(line));
  if (at < 0) return null;
  const summary = /^###\s+\S+\s+[—-]\s+(.*?)\s+[—-]\s+v/.exec(lines[at])?.[1].trim();
  const end = lines.findIndex((line, index) => index > at && /^#{1,3}\s/.test(line));
  return {
    title: summary ? `v${version} — ${summary}` : `v${version}`,
    body: lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim(),
  };
}

/** Why the deploy log of the app at `root` has nothing for `version`, or null when it has. */
export function deployNotesProblem(version, root = '.') {
  const log = join(root, DEPLOY_LOG);
  if (!existsSync(log)) return `${DEPLOY_LOG} is missing: it is the deploy log, which holds every release's notes`;
  if (deployNotes(readFileSync(log, 'utf8'), version)) return null;
  return `${DEPLOY_LOG} has no deploy-log entry for v${version} ("### <date> — <summary> — v${version}").\n`
    + '    Write it with the version bump: it is the release notes, and the only record of why.';
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [version, flag, ...rest] = process.argv.slice(2);
  if (!VERSION.test(version ?? '') || (flag !== undefined && flag !== '--title') || rest.length) {
    console.error('usage: sabeel-ci deploy-notes <X.Y.Z> [--title]');
    process.exit(2);
  }
  const problem = deployNotesProblem(version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const notes = deployNotes(readFileSync(DEPLOY_LOG, 'utf8'), version);
  console.log(flag ? notes.title : notes.body);
}
