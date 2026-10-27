import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The cache keys of the app's native builds: the Expo fingerprint of the
 * native inputs each platform's build compiles, per platform.
 *
 *   sabeel-ci native-fingerprint debug     # the debug apps native-build makes for the flows
 *   sabeel-ci native-fingerprint release   # the release builds ci-premerge compiles
 *
 * Prints one key per platform and, in GitHub Actions, writes them to the
 * step's outputs as `android` and `ios`. A debug build loads its JavaScript
 * from Metro, so two commits with one fingerprint make the same debug app: the
 * Native workflow keeps it under the key and builds it only when the key is
 * new. A release build of a fingerprint that compiled once compiles again: the
 * Pre-merge workflow records the key when it compiled and leaves the native
 * half of a later commit with that key to the JavaScript check.
 *
 * The fingerprint is @expo/fingerprint's, from the app's own install, over
 * `app/` for one platform: app.json, `app/android/`, config plugins,
 * autolinking and the native code of every linked package. Two things it
 * cannot see are added: `app/Podfile.lock` for iOS, which pins the pods from
 * outside node_modules, and the recipe below. Runs after `npm ci`.
 */

/** Raise one when native-build (debug) or ci-premerge's compile (release) changes what it makes. */
export const RECIPES = { debug: 1, release: 1 };
export const PLATFORMS = ['android', 'ios'];

/** The fingerprint options for one kind of build on one platform; paths are under app/. */
export function fingerprintOptions(kind, platform) {
  if (!(kind in RECIPES)) throw new Error(`no build kind "${kind}"; the kinds are ${Object.keys(RECIPES).join(', ')}`);
  if (!PLATFORMS.includes(platform)) throw new Error(`no platform "${platform}"`);
  const extraSources = [{
    type: 'contents', id: 'ci-tools:recipe', contents: `${kind} ${platform} ${RECIPES[kind]}`, reasons: ['ci-tools recipe'],
  }];
  if (platform === 'ios') extraSources.push({ type: 'file', filePath: 'Podfile.lock', reasons: ['app/Podfile.lock'] });
  return { platforms: [platform], extraSources, silent: true };
}

export const cacheKey = (kind, platform, hash) => `native-${kind}-${platform}-${hash}`;

async function main(args) {
  const [kind] = args;
  if (args.length !== 1 || !(kind in RECIPES)) {
    console.error(`usage: sabeel-ci native-fingerprint ${Object.keys(RECIPES).join('|')}`);
    process.exit(2);
  }
  const { createFingerprintAsync } = createRequire(resolve('app/package.json'))('@expo/fingerprint');
  for (const platform of PLATFORMS) {
    const { hash, sources } = await createFingerprintAsync(resolve('app'), fingerprintOptions(kind, platform));
    const key = cacheKey(kind, platform, hash);
    console.log(`${platform}: ${key} (${sources.length} sources)`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${platform}=${key}\n`);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
