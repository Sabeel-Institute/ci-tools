import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidIdentity, versionProblems } from '../lib/version.mjs';

/**
 * The app version is a store contract. app/app.json's expo.version must stay
 * legal on every store the app may ship to, and Android's versionName and
 * versionCode must follow from it (lib/version.mjs holds the rules).
 *
 *   sabeel-ci check-version
 *
 * Apple's rules (Technical Note TN2420) are the strictest, and a breach shows
 * only at submission, after the version is tagged, released and installed.
 * Gradle holds the versionCode ceiling too, on purpose: Gradle must fail when
 * this did not run, and this must fail on a web release that never runs Gradle.
 */

/**
 * The validator proves itself on every run: the leading-zero hole existed
 * because the pattern was never pointed at a date, and a self-test that runs
 * only when someone remembers to run it is no self-test.
 */
const MUST_REJECT = [
  '1.2.3-beta.1', // pre-release suffix
  '1.2.3.4', // fourth component
  'v1.2.3', // a tag's prefix leaking into the bundle
  '2026.07.01', // leading zero: 07 and 7 are one number
  '01.2.3', // the same, in the major
  '1.2', // two components
  '0.1.1000', // overflows the versionCode's patch field
  '2100.0.1', // over Play's largest versionCode
  '1.2.3 ', // stray whitespace
  '', // empty
];
const MUST_ACCEPT = ['0.0.1', '0.1.33', '1.0.0', '2100.0.0'];

export function selfTest() {
  const wrong = [
    ...MUST_REJECT.filter((version) => !versionProblems(version).length),
    ...MUST_ACCEPT.filter((version) => versionProblems(version).length),
  ];
  if (wrong.length) throw new Error(`check-version's self-test failed on ${wrong.map((version) => JSON.stringify(version)).join(', ')}`);
}

/** The working directory's app: its version, versionCode and every problem with them. */
export function checkVersion() {
  selfTest();
  const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
  const problems = versionProblems(app.version);
  if (problems.length) return { version: app.version, problems };
  try {
    const { versionCode } = androidIdentity(app, readFileSync('app/android/app/build.gradle', 'utf8'));
    return { version: app.version, versionCode, problems: [] };
  } catch (error) {
    return { version: app.version, problems: [error.message] };
  }
}

/** checkVersion's problems as one message, or null. */
export function versionFailure({ problems }) {
  return problems.length ? `version check FAILED (app/app.json → expo.version)\n\n${problems.map((problem) => `  - ${problem}`).join('\n\n')}` : null;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('usage: sabeel-ci check-version');
    process.exit(2);
  }
  let result;
  try {
    result = checkVersion();
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const failure = versionFailure(result);
  if (failure) {
    console.error(`\n${failure}\n`);
    process.exit(1);
  }
  console.log(`version ok (${result.version}, store-legal, versionCode ${result.versionCode}; ${MUST_REJECT.length} bad shapes self-tested)`);
}
