import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Nightly workflow's one issue, labelled `nightly`:
 *
 *   sabeel-ci nightly-issue web=<outcome> functions=<outcome>
 *
 * Each argument is a check and its step's outcome. When any did not succeed
 * (a failure, or a step that never ran) it opens the issue, or comments on the
 * open one, naming them, and exits 1 so the run fails too; when all succeeded
 * it closes the open issue, if there is one. GitHub's CLI, as GITHUB_TOKEN.
 */

export const LABEL = 'nightly';
export const CHECKS = { web: 'the live web app serves the build CI made', functions: 'every callable answers for itself' };

/** The checks that did not succeed, from `name=outcome` arguments. */
export function failures(args) {
  return args.map((arg) => {
    const [name, outcome] = arg.split('=');
    if (!Object.hasOwn(CHECKS, name)) throw new Error(`nightly-issue: no check named ${name}; the checks are ${Object.keys(CHECKS).join(', ')}`);
    return { name, outcome };
  }).filter(({ outcome }) => outcome !== 'success');
}

function main(args) {
  if (!args.length) throw new Error('usage: sabeel-ci nightly-issue <check>=<outcome>…');
  const repository = process.env.GITHUB_REPOSITORY;
  const run = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const gh = (...ghArgs) => execFileSync('gh', [...ghArgs, '--repo', repository], { encoding: 'utf8' }).trim();
  const open = JSON.parse(gh('issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number', '--limit', '1'))[0]?.number;
  const failed = failures(args);
  if (!failed.length) {
    if (open) gh('issue', 'close', String(open), '--comment', `The nightly checks pass again: ${run}`);
    console.log('Every nightly check passed');
    return 0;
  }
  const body = ['The nightly production checks found a problem:', '',
    ...failed.map(({ name, outcome }) => `- ${CHECKS[name]}: ${outcome === 'failure' ? 'failed' : `did not run (${outcome})`}`),
    '', `What each found is in the run's log: ${run}`].join('\n');
  if (open) {
    gh('issue', 'comment', String(open), '--body', body);
  } else {
    gh('label', 'create', LABEL, '--color', 'B60205', '--description', 'The nightly production checks failed', '--force');
    gh('issue', 'create', '--title', 'Nightly production checks failed', '--label', LABEL, '--body', body);
  }
  console.log(`Nightly checks that did not pass: ${failed.map(({ name }) => name).join(', ')}`);
  return 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
