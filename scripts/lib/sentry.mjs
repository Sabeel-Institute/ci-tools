import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Sentry, set up the same way in every app.
 *
 * The DSNs are client values in app/.env.local (APP_ENV_LOCAL in CI), under
 * the same two names in every app: Android and iOS report to the native
 * project, the web to the web one. The org and project slugs are public and
 * live in ci-tools.json's `sentry`. The one secret is the auth token, in
 * app/.env.sentry-build-plugin (BUILD_ENV in CI), which the native builds
 * upload their source maps and symbols with; Deploy Web uploads the web
 * build's with it.
 *
 * A release built without any of these looks no different and reports
 * crashes nobody can read, or none at all, so every release build refuses to
 * run without them. Pull-request builds have none of them and need none.
 *
 * Node built-ins only: ci-platform imports this before `npm ci`.
 */

export const DSN_VARIABLES = { native: 'EXPO_PUBLIC_SENTRY_DSN_NATIVE', web: 'EXPO_PUBLIC_SENTRY_DSN_WEB' };
export const ENV_LOCAL = 'app/.env.local';
export const BUILD_ENV_FILE = 'app/.env.sentry-build-plugin';

/**
 * The line build.gradle applies sentry.gradle under: exactly when the build
 * machine's file is there, so a release uploads its source maps and a
 * pull-request build, which never has the file, applies nothing.
 */
export const SENTRY_GRADLE_GATE = 'if (file("$projectRoot/.env.sentry-build-plugin").exists()) {';

const readEnv = (root, path) => (existsSync(join(root, path)) ? parseEnv(readFileSync(join(root, path), 'utf8')) : {});

/** Why app/.env.local has no usable DSN for `platform` ('native' or 'web'), or null. The value is never printed. */
export function dsnProblem(platform, root = '.') {
  const variable = DSN_VARIABLES[platform];
  const value = readEnv(root, ENV_LOCAL)[variable];
  if (!value) {
    return `${ENV_LOCAL} has no ${variable}, so this build would ship with crash reporting OFF.\n`
      + '    The file is gitignored, so a fresh clone never has it; on GitHub it comes from the\n'
      + "    APP_ENV_LOCAL secret. Add the DSN from Sentry (the project's Client Keys).";
  }
  if (!/^https:\/\/[^@\s]+@\S+$/.test(value)) return `${variable} in ${ENV_LOCAL} does not look like a Sentry DSN (https://<key>@<host>/<project>).`;
  return null;
}

/** Why the build machine's file has no Sentry auth token, or null. The value is never printed. */
export function tokenProblem(root = '.') {
  if (readEnv(root, BUILD_ENV_FILE).SENTRY_AUTH_TOKEN) return null;
  return `${BUILD_ENV_FILE} has no SENTRY_AUTH_TOKEN, so this release would upload no source maps and its\n`
    + '    crashes would reach Sentry as minified frames. The file is gitignored; on GitHub it comes\n'
    + '    from the BUILD_ENV secret.';
}

/** Expo's line in build.gradle that the gate's `$projectRoot` reads. */
export const PROJECT_ROOT = 'def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()';

/**
 * Why build.gradle's text does not apply sentry.gradle under SENTRY_GRADLE_GATE,
 * below the `def projectRoot` the gate reads, or null. Above it, or with none,
 * Gradle stops: "Could not get unknown property 'projectRoot'".
 */
export function sentryGradleProblem(gradle) {
  const lines = gradle.split('\n').map((line) => line.trim());
  const applies = lines.flatMap((line, index) => (/^apply from:.*\bsentry\.gradle\b/.test(line) ? [index] : []));
  const gate = applies.length === 1 ? lines.slice(0, applies[0]).findLastIndex((line) => line !== '') : -1;
  if (gate !== -1 && lines[gate] === SENTRY_GRADLE_GATE) {
    const defined = lines.findIndex((line) => /^def\s+projectRoot\s*=/.test(line));
    if (defined !== -1 && defined < gate) return null;
    return `app/android/app/build.gradle's Sentry gate reads $projectRoot on line ${gate + 1}, but `
      + (defined === -1 ? 'build.gradle never defines projectRoot' : `projectRoot is defined only on line ${defined + 1}, after it`)
      + `: Gradle stops with "Could not get unknown property 'projectRoot'".\n`
      + `    Put the gate below Expo's\n        ${PROJECT_ROOT}`;
  }
  return 'app/android/app/build.gradle must apply sentry.gradle exactly when app/.env.sentry-build-plugin exists,\n'
    + '    so a release uploads its source maps and a pull-request build applies nothing:\n'
    + `        ${SENTRY_GRADLE_GATE}\n`
    + '            apply from: new File(["node", "--print", "require.resolve(\'@sentry/react-native/package.json\')"]'
    + '.execute(null, rootDir).text.trim(), "../sentry.gradle")\n'
    + '        }';
}

/**
 * The environment a native release build runs in: sentry-cli takes the org
 * and the native project from here, and the token from the build machine's
 * file (sentry.gradle hands it over as SENTRY_DOTENV_PATH).
 */
export function nativeBuildEnv(settings, env = process.env) {
  return { ...env, SENTRY_ORG: settings.sentry.org, SENTRY_PROJECT: settings.sentry.projects.native };
}

/** The scripts Metro wrote into a web export, relative to it. */
export function metroScripts(site) {
  const directory = join(site, '_expo/static/js');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true }).map(String).filter((path) => path.endsWith('.js'))
    .map((path) => join('_expo/static/js', path)).sort();
}

/**
 * What stops Sentry matching a crash in the web export at `site` to its
 * source: each script Metro wrote must carry its debug id, the snippet that
 * hands the id to the SDK at run time (which getSentryExpoConfig adds), and a
 * source map beside it with the same id.
 */
export function debugIdProblems(site) {
  const scripts = metroScripts(site);
  if (!scripts.length) return [`${site} holds no scripts under _expo/static/js`];
  const config = 'app/metro.config.js must build on getSentryExpoConfig from @sentry/react-native/metro';
  return scripts.flatMap((path) => {
    const text = readFileSync(join(site, path), 'utf8');
    const id = /^\/\/# debugId=([0-9a-f-]{36})\s*$/m.exec(text)?.[1];
    if (!id) return [`${path} carries no debug id, so Sentry cannot match its crashes to a source map`];
    if (!text.includes(`sentry-dbid-${id}`)) return [`${path} does not hand its debug id to the Sentry SDK: ${config}`];
    const map = join(site, `${path}.map`);
    if (!existsSync(map)) return [`${path} has no source map beside it (${path}.map)`];
    const mapped = JSON.parse(readFileSync(map, 'utf8'));
    return (mapped.debugId ?? mapped.debug_id) === id ? [] : [`${path}.map does not carry ${path}'s debug id ${id}`];
  });
}
