// GitHub's CLI: records each call, with what a release would upload and the
// pull request's body, and answers as GitHub would. The Android build of the
// commit is run 41 (ANDROID_RUNS replaces its list); Publish Android has run
// 50 from before, and each dispatch is the next run from 51, which a listing
// leaves out PUBLISH_LAG times after its dispatch. Every run is stamped as
// started now, as a check run and the upload after it are within a minute;
// `run watch` fails for the runs FAIL_WATCH names. v<version> is a draft release when DRAFT_RELEASE is set, and none
// otherwise; FAIL_RELEASE names the `release` subcommand that fails.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from './log.mjs';

const args = process.argv.slice(2);
const extra = {};
const body = args.indexOf('--body-file');
if (body > 0) extra.body = readFileSync(args[body + 1], 'utf8');
const notes = args.indexOf('--notes-file');
if (notes > 0) {
  extra.notes = readFileSync(args[notes + 1], 'utf8');
  extra.assets = args.slice(notes + 2).map((path) => ({ path, exists: existsSync(path) }));
}
log('gh', extra);
const value = (flag) => args[args.indexOf(flag) + 1];
const dispatches = join(dirname(process.env.RELEASE_LOG), 'publish-dispatches');
const dispatched = () => (existsSync(dispatches) ? Number(readFileSync(dispatches, 'utf8')) : 0);
const lagged = join(dirname(process.env.RELEASE_LOG), 'publish-lagged');

if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/Sabeel-Institute/example/pull/7');
if (args[0] === 'run' && args[1] === 'list') {
  const workflow = value('--workflow');
  if (workflow === 'android.yml') {
    console.log(process.env.ANDROID_RUNS ?? JSON.stringify([{ databaseId: 41, status: 'completed', conclusion: 'success', event: 'push' }]));
  } else if (workflow === 'android-publish.yml') {
    const lag = Number(existsSync(lagged) ? readFileSync(lagged, 'utf8') : 0);
    const hidden = lag < Number(process.env.PUBLISH_LAG ?? 0) && dispatched() > 0;
    if (hidden) writeFileSync(lagged, String(lag + 1));
    const newest = 50 + dispatched() - (hidden ? 1 : 0);
    const createdAt = new Date().toISOString();
    console.log(JSON.stringify(Array.from({ length: newest - 49 }, (_, i) => ({ databaseId: newest - i, createdAt }))));
  } else {
    console.log(JSON.stringify([{ databaseId: 99 }]));
  }
}
if (args[0] === 'run' && args[1] === 'download' && !process.env.NO_BUNDLE) {
  mkdirSync(value('--dir'), { recursive: true });
  writeFileSync(join(value('--dir'), 'app-release.aab'), 'bundle');
}
if (args[0] === 'workflow' && args[1] === 'run' && args[2] === 'android-publish.yml') {
  writeFileSync(dispatches, String(dispatched() + 1));
  writeFileSync(lagged, '0');
}
if (args[0] === 'run' && args[1] === 'watch' && (process.env.FAIL_WATCH ?? '').split(',').includes(args[2])) process.exit(1);
if (args[0] === 'release' && args[1] === process.env.FAIL_RELEASE) process.exit(1);
if (args[0] === 'release' && args[1] === 'view') {
  if (!process.env.DRAFT_RELEASE) process.exit(1);
  console.log(JSON.stringify({ isDraft: true }));
}
