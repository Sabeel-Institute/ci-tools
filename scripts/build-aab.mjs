import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { writeBuildInfo } from './build-info.mjs';
import { checkVersion } from './check-version.mjs';
import { deployNotesProblem } from './deploy-notes.mjs';
import { dsnProblem, nativeBuildEnv, sentryGradleProblem, tokenProblem } from './lib/sentry.mjs';

/**
 * The signed Android App Bundle for Google Play, built the same way in every
 * app: `npm run build:aab` on a release machine, and `sabeel-ci ci-platform
 * android` in CI, which then checks the certificate and the commit and records
 * the build's provenance.
 *
 *   sabeel-ci build-aab           # check, stamp, build, check the signature
 *   sabeel-ci build-aab --check   # the checks before the build only; builds nothing
 *
 * Before Gradle starts:
 *  - the version is store-legal and Android's version follows from it
 *    (`check-version`);
 *  - the deploy log already has this version's entry (`deploy-notes`). It is
 *    the release notes and the only record of why, so it comes first, not
 *    afterwards from memory;
 *  - Sentry is set up (scripts/lib/sentry.mjs): app/.env.local carries
 *    EXPO_PUBLIC_SENTRY_DSN_NATIVE, app/.env.sentry-build-plugin a
 *    SENTRY_AUTH_TOKEN, and build.gradle applies sentry.gradle when that file
 *    is there. Both files are gitignored, so a fresh clone would build a
 *    release that reports nothing, or nothing anyone can read, and looks the
 *    same.
 * Then `build-info` stamps the commit and `./gradlew bundleRelease` runs, with
 * ci-tools.json's Sentry org and native project in its environment, so
 * sentry.gradle uploads the bundle's source map there. The bundle must come
 * out signed, and not with the debug key: that keystore is committed in each
 * public repository, and Play refuses it, so the answer is known before an
 * upload rather than after.
 */
export const BUNDLE = 'app/android/app/build/outputs/bundle/release/app-release.aab';
const GRADLE = 'app/android/app/build.gradle';

/** The checks before a release build: the version, its versionCode and every problem found. */
export function releaseChecks() {
  const version = checkVersion();
  const gradle = existsSync(GRADLE) ? sentryGradleProblem(readFileSync(GRADLE, 'utf8')) : `${GRADLE} is missing`;
  const problems = [...version.problems, deployNotesProblem(version.version), dsnProblem('native'), tokenProblem(), gradle];
  return { ...version, problems: problems.filter(Boolean) };
}

/** The certificate subject that signed `bundle`, or '' when it is unsigned or unreadable. */
export function bundleSigner(bundle) {
  try {
    const output = execFileSync('jarsigner', ['-verify', '-verbose:summary', '-certs', bundle],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return /Signed by "([^"]+)"/.exec(output)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** Why `signer` must not go to Play, or null. */
export function signerProblem(signer) {
  const fix = "\n    The release signing configuration is missing or wrong. Restore the app's EXISTING upload\n"
    + '    keystore and its properties (docs/SECRETS.md); never generate a new one, which Play refuses.';
  if (!signer) return `${BUNDLE} is not signed, or jarsigner could not read its signature.${fix}`;
  if (/CN=Android Debug/i.test(signer)) return `${BUNDLE} is signed with the DEBUG key (${signer}).${fix}`;
  return null;
}

const refusal = (problems) => `not building the release bundle:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`;

/** Check, stamp, build and check the signature; returns what was built. */
export function buildAab(settings) {
  const checks = releaseChecks();
  if (checks.problems.length) throw new Error(refusal(checks.problems));
  const { commit } = writeBuildInfo();
  execFileSync('./gradlew', ['bundleRelease', '--no-daemon'], { cwd: 'app/android', stdio: 'inherit', env: nativeBuildEnv(settings) });
  if (!existsSync(BUNDLE)) throw new Error(`bundleRelease produced no bundle at ${BUNDLE}`);
  const signer = bundleSigner(BUNDLE);
  const problem = signerProblem(signer);
  if (problem) throw new Error(`REFUSING: ${problem}`);
  return { bundle: BUNDLE, version: checks.version, versionCode: checks.versionCode, commit, signer };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: sabeel-ci build-aab [--check]');
    process.exit(2);
  }
  try {
    if (args[0] === '--check') {
      config(); // the build reads it, so a broken one fails the check too
      const { version, problems } = releaseChecks();
      if (problems.length) throw new Error(refusal(problems));
      console.log(`build-aab --check: v${version} may be built; nothing was built`);
    } else {
      const built = buildAab(config());
      console.log([
        '',
        `AAB        ${built.bundle}`,
        `size       ${(statSync(built.bundle).size / 1024 / 1024).toFixed(1)} MB`,
        `version    ${built.version} (versionCode ${built.versionCode})`,
        `commit     ${built.commit}`,
        `signed by  ${built.signer}`,
        '',
        built.commit.endsWith('+')
          ? 'Built from uncommitted changes, so not a build to publish. Commit, then build again.'
          : 'Upload it with: npx sabeel-ci publish-play --check, then npx sabeel-ci publish-play --internal',
      ].join('\n'));
    }
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
