import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuildInfo } from './build-info.mjs';
import { checkVersion, versionFailure } from './check-version.mjs';

/**
 * The web export, built the same way in every app: the app's `web:export`
 * (locally, in pre-merge builds and in Hosting's predeploy) runs this, and so
 * does `sabeel-ci ci-platform web` in CI.
 *
 *   sabeel-ci build-web                 # app/dist-web
 *   sabeel-ci build-web --source-maps   # with source maps beside it, for Sentry
 *
 * The version check first, so a web-only release that never runs Gradle still
 * meets it, then the commit stamp, then `expo export` with --clear, always:
 * Metro otherwise serves a cached bundle built under other EXPO_PUBLIC_* values,
 * and an emulator-mode bundle looks like any other. The export must carry the
 * stamped commit, or the sign-in label of what ships would be wrong.
 */
export const WEB_EXPORT = 'app/dist-web';

/** The export's JavaScript files, as paths under the working directory. */
export function exportedScripts(directory = WEB_EXPORT) {
  return readdirSync(directory, { recursive: true }).filter((path) => path.endsWith('.js')).map((path) => join(directory, path));
}

/** Check, stamp and export; returns the version and the stamped commit. */
export function buildWeb({ sourceMaps = false } = {}) {
  const version = checkVersion();
  const failure = versionFailure(version);
  if (failure) throw new Error(failure);
  const { commit } = writeBuildInfo();
  execFileSync('npx', ['--no-install', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist-web', '--clear',
    ...(sourceMaps ? ['--source-maps'] : [])], { cwd: 'app', stdio: 'inherit' });
  if (!exportedScripts().some((path) => readFileSync(path).includes(commit))) {
    throw new Error(`${WEB_EXPORT} does not carry the stamped commit ${commit}: the sign-in label would be wrong`);
  }
  return { version: version.version, commit };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--source-maps')) {
    console.error('usage: sabeel-ci build-web [--source-maps]');
    process.exit(2);
  }
  try {
    const { version, commit } = buildWeb({ sourceMaps: args[0] === '--source-maps' });
    console.log(`${WEB_EXPORT}: v${version} · ${commit}`);
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
