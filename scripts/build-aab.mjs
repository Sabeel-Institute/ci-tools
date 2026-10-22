import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { config } from '../lib/config.mjs';
import { writeBuildInfo } from './build-info.mjs';
import { checkVersion } from './check-version.mjs';
import { deployNotesProblem } from './deploy-notes.mjs';

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
 *  - app/.env.local carries the native Sentry DSN, in the variable
 *    ci-tools.json's build.sentryDsnVariable names. The file is gitignored, so
 *    a fresh clone builds a release that reports nothing and looks the same.
 * Then `build-info` stamps the commit and `./gradlew bundleRelease` runs. The
 * bundle must come out signed, and not with the debug key: that keystore is
 * committed in each public repository, and Play refuses it, so the answer is
 * known before an upload rather than after.
 */
export const BUNDLE = 'app/android/app/build/outputs/bundle/release/app-release.aab';
const ENV_LOCAL = 'app/.env.local';

/** Why app/.env.local has no usable DSN in `variable`, or null. The value is never printed. */
export function sentryDsnProblem(variable) {
  const value = existsSync(ENV_LOCAL) ? parseEnv(readFileSync(ENV_LOCAL, 'utf8'))[variable] : undefined;
  if (!value) {
    return `${ENV_LOCAL} has no ${variable}, so this build would ship with crash reporting silently off.\n`
      + '    The file is gitignored, so a fresh clone never has it; on GitHub it comes from the\n'
      + "    APP_ENV_LOCAL secret. Add the DSN from Sentry (the project's Client Keys).";
  }
  if (!/^https:\/\/[^@\s]+@\S+$/.test(value)) return `${variable} in ${ENV_LOCAL} does not look like a Sentry DSN (https://<key>@<host>/<project>).`;
  return null;
}

/** The checks before a release build: the version, its versionCode and every problem found. */
export function releaseChecks(settings) {
  const version = checkVersion();
  const problems = [...version.problems, deployNotesProblem(version.version), sentryDsnProblem(settings.build.sentryDsnVariable)];
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
  const checks = releaseChecks(settings);
  if (checks.problems.length) throw new Error(refusal(checks.problems));
  const { commit } = writeBuildInfo();
  execFileSync('./gradlew', ['bundleRelease', '--no-daemon'], { cwd: 'app/android', stdio: 'inherit' });
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
      const { version, problems } = releaseChecks(config());
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
          : 'Upload it with: npm run publish:play -- --check, then npm run publish:play -- --internal',
      ].join('\n'));
    }
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
