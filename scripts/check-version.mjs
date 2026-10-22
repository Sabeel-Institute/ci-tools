import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The app version is a store contract. app/app.json's expo.version must stay
 * legal on every store the app may ship to, and Android's versionName and
 * versionCode must follow from it.
 *
 *   sabeel-ci check-version
 *
 * Apple's rules (Technical Note TN2420) are the strictest, and a breach shows
 * only at submission, after the version is tagged, released and installed:
 * digits and periods, at most three components, at most 18 characters, always
 * increasing. Here that is three integers without leading zeros: `2026.07.01`
 * is legal to Apple, but 07 and 7 are one number, so a date scheme can produce
 * a version that does not increase.
 *
 * Android's versionCode is major * 1000000 + minor * 1000 + patch where Gradle
 * computes it (`computedVersionCode`, `expoVersion` in build.gradle), or a
 * literal there equal to app.json's android.versionCode; versionName is the
 * version either way. Every version must fit the computed scheme: minor and
 * patch at most 999, the code at most Play's 2100000000. Gradle holds the same
 * ceiling on purpose: Gradle must fail when this did not run, and this must
 * fail on a web release that never runs Gradle.
 */

const SHAPE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** The largest versionCode Google Play accepts. */
export const VERSION_CODE_MAX = 2100000000;

const computedCode = (version) => {
  const [major, minor, patch] = version.split('.').map(Number);
  return major * 1000000 + minor * 1000 + patch;
};

/** Every reason `version` cannot be an app version; empty when it can. */
export function versionProblems(version) {
  if (typeof version !== 'string') return [`${JSON.stringify(version)} is not a version string.`];
  const problems = [];
  if (!SHAPE.test(version)) {
    problems.push(`"${version}" is not three period-separated integers (X.Y.Z) without leading zeros.\n`
      + '    No pre-release suffix, no fourth component, no leading "v", no "07". App Store\n'
      + '    Connect rejects the first three; the last is legal to Apple, but 07 and 7 are\n'
      + '    the same version.');
  }
  if (version.length > 18) problems.push(`"${version}" is longer than the 18 characters Apple allows.`);
  const [, minor, patch] = version.split('.').map(Number);
  if (SHAPE.test(version) && (minor > 999 || patch > 999 || computedCode(version) > VERSION_CODE_MAX)) {
    problems.push(`"${version}" does not fit the Android versionCode scheme, major * 1000000 + minor * 1000\n`
      + `    + patch: minor and patch at most 999, the code at most ${VERSION_CODE_MAX} (Play's limit).\n`
      + '    A larger scheme means raising the multipliers in app/android/app/build.gradle together\n'
      + '    with this check, and only ever upward, or codes stop increasing.');
  }
  return problems;
}

/**
 * Package, versionName and versionCode the release bundle must carry, from
 * app.json and build.gradle; throws where the two disagree.
 */
export function androidIdentity(app, gradle) {
  const literalCode = /^\s*versionCode\s+(\d+)\b/m.exec(gradle)?.[1];
  const literalName = /^\s*versionName\s+"([^"]+)"/m.exec(gradle)?.[1];
  let versionCode;
  if (literalCode && literalName) {
    if (literalName !== app.version) {
      throw new Error(`Android native and app versions differ: build.gradle's versionName is ${literalName}, app.json's version ${app.version}`);
    }
    versionCode = Number(literalCode);
  } else {
    if (!/versionCode\s+computedVersionCode\b/.test(gradle) || !/versionName\s+expoVersion\b/.test(gradle)) {
      throw new Error('Unsupported Android version configuration: build.gradle sets neither a literal versionCode and versionName nor computedVersionCode and expoVersion');
    }
    const problems = versionProblems(app.version);
    if (problems.length) throw new Error(`Unsupported Android version for the computed versionCode: ${problems.join('\n')}`);
    versionCode = computedCode(app.version);
  }
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > VERSION_CODE_MAX) {
    throw new Error(`Invalid Android versionCode ${versionCode}: it must be between 1 and ${VERSION_CODE_MAX}`);
  }
  if (app.android.versionCode !== undefined && app.android.versionCode !== versionCode) {
    throw new Error(`Inconsistent Android versionCode: build.gradle gives ${versionCode}, app.json's android.versionCode is ${app.android.versionCode}`);
  }
  return { packageName: app.android.package, versionName: app.version, versionCode };
}

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
