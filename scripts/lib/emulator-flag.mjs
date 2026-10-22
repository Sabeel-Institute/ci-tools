import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * The flag that points an app at the Firebase emulators. Metro inlines every
 * EXPO_PUBLIC_* it finds when it bundles, from the shell and from the dotenv
 * files in app/, so a terminal or a file still carrying the dev loop's flag
 * builds a bundle that talks to 127.0.0.1, and nothing in a deploy says so.
 * A production build refuses while either sets it.
 *
 * Node built-ins only: build-web and build-aab import this before `npm ci`.
 */
export const EMULATOR_FLAG = 'EXPO_PUBLIC_USE_EMULATORS';

/** Where the flag is set: 'this shell', then each dotenv file in app/ that sets it. Values are never read out. */
export function emulatorFlagSources(env = process.env, root = '.') {
  const found = env[EMULATOR_FLAG] ? ['this shell'] : [];
  const app = join(root, 'app');
  for (const name of readdirSync(app).filter((entry) => entry.startsWith('.env')).sort()) {
    const path = join(app, name);
    if (statSync(path).isFile() && parseEnv(readFileSync(path, 'utf8'))[EMULATOR_FLAG]) found.push(`app/${name}`);
  }
  return found;
}

/** Why a production build here would point at the emulators, with what to do about each place the flag is set; or null. */
export function emulatorFlagProblem(env = process.env, root = '.') {
  const sources = emulatorFlagSources(env, root);
  if (!sources.length) return null;
  return `${EMULATOR_FLAG} would point this build at the Firebase emulators, and nothing in it would say so:\n`
    + sources.map((source) => (source === 'this shell'
      ? '      - set in this shell: unset it, or use a fresh terminal'
      : `      - set in ${source}: remove the line (the dev loop passes the flag on its own command line)`)).join('\n');
}
