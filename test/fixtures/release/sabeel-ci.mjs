// ci-tools' sabeel-ci as release.mjs sees it. deploy-notes reads the deploy log
// as the build branch's command does, and render-manual checks and renders as
// the real one does; the others record their call, and fail when the test asks.
import { readFileSync, writeFileSync } from 'node:fs';
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
} else if (command === 'render-manual') {
  // As the real one does: refuse a manual whose version line disagrees with
  // app.json, and render the PDF with app.json's version.
  const { version } = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
  const stated = /^\*For app version (\S+) · /m.exec(readFileSync('docs/USER-MANUAL.md', 'utf8'))?.[1];
  if (stated !== version) {
    console.error(`render-manual: docs/USER-MANUAL.md says version ${stated}, app/app.json ${version}`);
    process.exit(1);
  }
  writeFileSync('docs/USER-MANUAL.pdf', `PDF ${version}\n`);
} else if (command === 'play-apk') {
  if (process.env.FAIL_PLAY_APK) process.exit(1);
  writeFileSync(args[0], 'PK apk');
} else if (command === 'check-release' && process.env.FAIL_CHECK_RELEASE) {
  process.exit(1);
}
