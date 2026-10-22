// ci-tools' sabeel-ci as release.mjs sees it. deploy-notes reads the deploy log
// as the build branch's command does; the others record their call, and fail
// when the test asks.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { log } from './log.mjs';

const [command, ...args] = process.argv.slice(2);
log('sabeel-ci');
if (command === 'deploy-notes' && process.env.NO_DEPLOY_NOTES) {
  console.error('sabeel-ci: no command "deploy-notes"');
  process.exit(2);
} else if (command === 'deploy-notes') {
  const [version, flag] = args;
  const lines = readFileSync('docs/PHASE_STATUS.md', 'utf8').split('\n');
  const at = lines.findIndex((line) => new RegExp(`^###\\s+.*\\bv${version.replaceAll('.', '\\.')}\\b`).test(line));
  if (at < 0) {
    console.error(`no deploy-log entry for v${version}`);
    process.exit(1);
  }
  const summary = /^###\s+\S+\s+[—-]\s+(.*?)\s+[—-]\s+v/.exec(lines[at])?.[1].trim();
  const end = lines.findIndex((line, index) => index > at && /^#{1,3}\s/.test(line));
  console.log(flag ? (summary ? `v${version} — ${summary}` : `v${version}`) : lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim());
} else if (command === 'build-aab') {
  mkdirSync('app/android/app/build/outputs/bundle/release', { recursive: true });
  writeFileSync('app/android/app/build/outputs/bundle/release/app-release.aab', 'bundle');
} else if (command === 'check-release' && process.env.FAIL_CHECK_RELEASE) {
  process.exit(1);
} else if (command === 'publish-play' && process.env.FAIL_PUBLISH === args[0]) {
  console.error('Play said no');
  process.exit(1);
}
