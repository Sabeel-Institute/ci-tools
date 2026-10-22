/**
 * App versions. app/app.json's expo.version, X.Y.Z, is the one place a version
 * is written; the numbers the stores need follow from it and are never typed:
 *
 *   Android versionCode   major * 1000000 + minor * 1000 + patch
 *                         (build.gradle computes it: computedVersionCode)
 *   iOS build number      the same number, as a string (expo.ios.buildNumber,
 *                         written by `sabeel-ci release` with the version)
 *
 * So both stores take one build per version, each higher than the last, and a
 * version that does not increase fails here rather than on a phone that will
 * not take the update.
 */

const SHAPE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The largest versionCode Google Play accepts. */
export const VERSION_CODE_MAX = 2100000000;

const code = (version) => {
  const [major, minor, patch] = version.split('.').map(Number);
  return major * 1000000 + minor * 1000 + patch;
};

/**
 * Every reason `version` cannot be an app version; empty when it can. Three
 * integers without leading zeros: `2026.07.01` is legal to Apple, but 07 and 7
 * are one number, so a date scheme can produce a version that does not
 * increase. Apple allows at most 18 characters; the versionCode gives minor and
 * patch three digits each and must stay within Play's ceiling.
 */
export function versionProblems(version) {
  if (typeof version !== 'string') return [`${JSON.stringify(version)} is not a version string.`];
  const problems = [];
  if (!SHAPE.test(version)) {
    problems.push(`"${version}" is not three period-separated integers (X.Y.Z) without leading zeros:\n`
      + '    no pre-release suffix, no fourth component, no leading "v", no "07".');
  }
  if (version.length > 18) problems.push(`"${version}" is longer than the 18 characters Apple allows.`);
  const [, minor, patch] = version.split('.').map(Number);
  if (SHAPE.test(version) && (minor > 999 || patch > 999 || code(version) > VERSION_CODE_MAX)) {
    problems.push(`"${version}" does not fit the versionCode scheme, major * 1000000 + minor * 1000 + patch:\n`
      + `    minor and patch at most 999, the code at most ${VERSION_CODE_MAX} (Play's limit).`);
  }
  return problems;
}

/** Android's versionCode for `version`; throws when it is not a version. */
export function versionCode(version) {
  const problems = versionProblems(version);
  if (problems.length) throw new Error(problems.join('\n'));
  return code(version);
}

/** The iOS build number for `version`: its versionCode, as Expo's string. */
export const buildNumber = (version) => String(versionCode(version));

/**
 * The package, versionName and versionCode a release bundle must carry, from
 * app.json's expo section and app/android/app/build.gradle. Gradle must derive
 * both from app.json, and app.json must not state a code of its own: a second
 * copy is a copy that drifts.
 */
export function androidIdentity(app, gradle) {
  if (!/^\s*versionCode\s+computedVersionCode\b/m.test(gradle) || !/^\s*versionName\s+expoVersion\b/m.test(gradle)) {
    throw new Error('app/android/app/build.gradle must derive the version from app.json ("versionCode computedVersionCode",\n'
      + '    "versionName expoVersion"), not state it');
  }
  if (app.android?.versionCode !== undefined) {
    throw new Error(`app/app.json states android.versionCode ${app.android.versionCode}; remove it: build.gradle computes the code from the version`);
  }
  return { packageName: app.android?.package, versionName: app.version, versionCode: versionCode(app.version) };
}
