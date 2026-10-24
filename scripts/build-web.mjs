import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuildInfo } from './build-info.mjs';
import { checkVersion, versionFailure } from './check-version.mjs';
import { EMULATOR_FLAG, emulatorFlagProblem } from './lib/emulator-flag.mjs';
import { debugIdProblems } from './lib/sentry.mjs';

/**
 * The web export, built the same way in every app: the app's `web:export`
 * (locally, in pre-merge builds and in Hosting's predeploy) runs this, and so
 * does `sabeel-ci ci-platform web` in CI.
 *
 *   sabeel-ci build-web                 # app/dist-web
 *   sabeel-ci build-web --source-maps   # with source maps beside it, for Sentry
 *   sabeel-ci build-web --emulators     # pointed at the Firebase emulators, on purpose
 *
 * It refuses while EXPO_PUBLIC_USE_EMULATORS is set in the shell or in a
 * dotenv file in app/ (scripts/lib/emulator-flag.mjs): Metro would inline it,
 * and a Hosting deploy from a terminal left over from the dev loop would point
 * the live site at 127.0.0.1. `--emulators` is the one way to build for the
 * emulators, and sets the flag itself.
 *
 * The version check first, so a web-only release that never runs Gradle still
 * meets it, then the commit stamp, then `expo export` with --clear, always:
 * Metro otherwise serves a cached bundle built under other EXPO_PUBLIC_* values,
 * and an emulator-mode bundle looks like any other. The export must carry the
 * stamped commit, or the sign-in label of what ships would be wrong. With
 * source maps, each script Metro wrote must carry its debug id into the Sentry
 * SDK and match its map (debugIdProblems), as the release build requires.
 *
 * Every export is tree-shaken (TREE_SHAKING), the emulator build included, so
 * the browser suites run the code that ships. Without it Metro bundles every
 * module an import reaches, used or not: all of Sentry, its session replay and
 * feedback widget among it, though the apps report errors only. Measured on
 * Kanban, it took the bundle from 904 KB to 622 KB gzipped together with
 * named Sentry imports. Expo still calls the switches unstable; the apps'
 * browser suites passed in full on tree-shaken builds before it was turned
 * on, and they run on one in CI from then on.
 */
export const WEB_EXPORT = 'app/dist-web';

/** Expo's tree shaking, which needs its graph optimisation too. */
export const TREE_SHAKING = { EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH: '1', EXPO_UNSTABLE_TREE_SHAKING: '1' };

/** The export's JavaScript files, as paths under the working directory. */
export function exportedScripts(directory = WEB_EXPORT) {
  return readdirSync(directory, { recursive: true }).filter((path) => path.endsWith('.js')).map((path) => join(directory, path));
}

const list = (problems) => problems.map((problem) => `  - ${problem}`).join('\n');

/** Check, stamp and export; returns the version and the stamped commit. */
export function buildWeb({ sourceMaps = false, emulators = false } = {}) {
  const flag = emulators ? null : emulatorFlagProblem();
  if (flag) throw new Error(`not exporting the web app:\n${list([flag])}\n    To build for the emulators on purpose: sabeel-ci build-web --emulators`);
  const version = checkVersion();
  const failure = versionFailure(version);
  if (failure) throw new Error(failure);
  const { commit } = writeBuildInfo();
  execFileSync('npx', ['--no-install', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist-web', '--clear',
    ...(sourceMaps ? ['--source-maps'] : [])], { cwd: 'app', stdio: 'inherit',
    env: { ...process.env, ...TREE_SHAKING, ...(emulators ? { [EMULATOR_FLAG]: '1' } : {}) } });
  if (!exportedScripts().some((path) => readFileSync(path).includes(commit))) {
    throw new Error(`${WEB_EXPORT} does not carry the stamped commit ${commit}: the sign-in label would be wrong`);
  }
  const ids = sourceMaps ? debugIdProblems(WEB_EXPORT) : [];
  if (ids.length) throw new Error(`the web export cannot be read in Sentry:\n${list(ids)}`);
  return { version: version.version, commit };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--source-maps', '--emulators'].includes(args[0]))) {
    console.error('usage: sabeel-ci build-web [--source-maps | --emulators]');
    process.exit(2);
  }
  const emulators = args[0] === '--emulators';
  try {
    const { version, commit } = buildWeb({ sourceMaps: args[0] === '--source-maps', emulators });
    console.log(`${WEB_EXPORT}: v${version} · ${commit}${emulators ? ' · for the emulators' : ''}`);
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
