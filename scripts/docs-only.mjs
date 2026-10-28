import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether a pull request changes documentation alone.
 *
 *   sabeel-ci docs-only
 *
 * Prints the answer and, in GitHub Actions, writes `docs-only=true|false` to
 * the step's outputs. The CI, Native and Pre-merge workflows skip the jobs a
 * document cannot affect when it is true, and their gates accept those jobs
 * skipped then and only then. CI's quality job runs either way: its lint reads
 * every Markdown file, and unit tests read the user manual.
 *
 * Documentation is a Markdown or reStructuredText file anywhere, or any file
 * under docs/. The files are those the pull request's merge commit (the one
 * `actions/checkout` checks out, fetched with its parents: `fetch-depth: 2`)
 * changes on its first parent, the tip of the base branch. A rename counts as
 * the file deleted as well as the file added. Anything but a pull request, and
 * a pull request that changes nothing, is not documentation alone: main's
 * pushes run every job.
 */

export const DOCUMENTATION = /^docs\/|\.(md|rst)$/;

/** Whether `files`, the paths a change touches, are all documentation (and there is at least one). */
export const documentationOnly = (files) => files.length > 0 && files.every((file) => DOCUMENTATION.test(file));

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

/** The paths the merge commit at HEAD changes on its first parent. */
export function mergedFiles() {
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1);
  if (parents.length !== 2) {
    throw new Error(`HEAD has ${parents.length} parent(s), not the two of a pull request's merge commit; check it out with fetch-depth: 2`);
  }
  return git(['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD']).split('\0').filter(Boolean);
}

function main(args) {
  if (args.length) {
    console.error('usage: sabeel-ci docs-only');
    process.exit(2);
  }
  const event = process.env.GITHUB_EVENT_NAME;
  let answer = false;
  if (event === 'pull_request') {
    const files = mergedFiles();
    answer = documentationOnly(files);
    const shown = files.slice(0, 20).join(', ') + (files.length > 20 ? `, and ${files.length - 20} more` : '');
    console.log(`${files.length} file(s) changed: ${shown}`);
  } else {
    console.log(`a ${event ?? 'local'} run, not a pull request`);
  }
  console.log(`docs-only: ${answer}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs-only=${answer}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`docs-only: ${error.message}`);
    process.exit(1);
  }
}
