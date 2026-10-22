import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * May this build go to TestFlight?
 *
 *   sabeel-ci testflight-check <bundle-id> <version> <build-number> <commit>
 *
 * Two questions, both asked before anything is uploaded.
 *
 * 1. Is this the release? A version is spent the moment it is published, and
 *    publishing it tags v<version> on GitHub. An upload carrying that version
 *    must be built from exactly that commit, or iPhones and Android phones run
 *    different code under one number, and the stamp on the sign-in screen
 *    says so.
 * 2. Is the build number free? Apple takes each once per version, each higher
 *    than the last, and says so only after an upload has run its course.
 *
 * Exit 0: both yes. 1: no, and what to do about it. 2: bad arguments, or
 * GitHub or App Store Connect did not answer.
 *
 * Authenticates with the App Store Connect API key named by ASC_KEY_ID and
 * ASC_ISSUER_ID, read from ASC_KEY_PATH, else
 * ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8. Reads only.
 */

const API = 'https://api.appstoreconnect.apple.com';

/** A refusal (code 1) or a question that could not be asked (code 2). */
export class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The commit `git ls-remote --tags origin <ref> <ref>^{}` says v<version> is.
 * An annotated tag lists twice, and its peeled `^{}` line is the commit.
 */
export function taggedCommit(listing, version) {
  const ref = `refs/tags/v${version}`;
  const lines = listing.split('\n').map((line) => line.split('\t'));
  return (lines.find(([, name]) => name === `${ref}^{}`) ?? lines.find(([, name]) => name === ref))?.[0];
}

/** Whether `commit` (full or abbreviated) is the released one; a Stop if not. */
export function checkRelease(tagged, version, commit) {
  if (!tagged) {
    throw new Stop(1, `Version ${version} has not been released: there is no v${version} tag on GitHub.\n`
      + `Tag the release first, then run the iOS workflow on the tag: gh workflow run ios.yml --ref v${version} -f testflight=true`);
  }
  if (!tagged.startsWith(commit)) {
    throw new Stop(1, `This build is commit ${commit.slice(0, 12)}, but v${version} is ${tagged.slice(0, 12)}.\n`
      + `Build from the release: run the iOS workflow on the tag v${version}.`);
  }
}

/**
 * App Store Connect's token: ES256 over the key (a KeyObject), at most 20
 * minutes long, in JOSE's raw r||s form (node's default DER is refused).
 */
export function appStoreToken({ keyId, issuer, key }, now = Math.floor(Date.now() / 1000)) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${part({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

/**
 * GET from App Store Connect. It has bad hours: requests that hang, and 500s
 * that clear a minute later. Those are retried; any other answer is final.
 */
export function appStore(token, { fetch = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  return async (path) => {
    for (let attempt = 1; ; attempt++) {
      let failure;
      try {
        const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45_000) });
        if (response.ok) return response.json();
        failure = `answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
        if (response.status < 500 && response.status !== 429) throw new Stop(2, `App Store Connect ${failure} for ${path}`);
      } catch (error) {
        if (error instanceof Stop) throw error;
        failure = `did not answer (${error.cause?.code ?? error.name})`;
      }
      if (attempt === 4) throw new Stop(2, `App Store Connect ${failure} for ${path}, four times. Run the job again later.`);
      console.error(`App Store Connect ${failure.split(':')[0]}; trying again in ${attempt * 15} s.`);
      await sleep(attempt * 15_000);
    }
  };
}

/** The highest build number App Store Connect holds for this version, 0 if none. */
export async function highestBuild(get, bundleId, version) {
  const apps = await get(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  const app = apps.data.find((candidate) => candidate.attributes.bundleId === bundleId);
  if (!app) throw new Stop(2, `App Store Connect has no app with bundle id ${bundleId}; create its record first.`);
  const builds = await get(`/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&fields[builds]=version&limit=200`);
  const taken = builds.data.map((build) => Number(build.attributes.version)).filter(Number.isFinite);
  return taken.length ? Math.max(...taken) : 0;
}

export function checkBuild(highest, version, build) {
  if (Number(build) <= highest) {
    throw new Stop(1, `Version ${version} already has build ${highest} on App Store Connect, so build ${build} cannot go up.\n`
      + 'An upload is built from its release tag, so the next one is a new version: raise expo.version\n'
      + 'and expo.ios.buildNumber, release it, and run the iOS workflow on its tag.');
  }
}

export function parseArguments(args) {
  const [bundleId, version, build, commit] = args;
  if (args.length !== 4 || !/^[A-Za-z0-9.-]+$/.test(bundleId) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || !/^[1-9]\d*$/.test(build) || !/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new Stop(2, 'usage: sabeel-ci testflight-check <bundle-id> <X.Y.Z version> <build number> <commit sha>');
  }
  return { bundleId, version, build, commit };
}

/** Both answers for `args`, as the command line gives them; a Stop if either is no. */
export async function testflightCheck(args, { env = process.env, cwd = '.', ...client } = {}) {
  const { bundleId, version, build, commit } = parseArguments(args);
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer } = env;
  if (!keyId || !issuer) throw new Stop(2, 'ASC_KEY_ID and ASC_ISSUER_ID must be set');
  const keyPath = env.ASC_KEY_PATH || `${homedir()}/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`;
  let key;
  try {
    key = createPrivateKey(readFileSync(keyPath));
  } catch (error) {
    throw new Stop(2, `cannot read the App Store Connect key ${keyPath}: ${error.message}`);
  }

  // 1. The release tag, read from GitHub rather than the local clone: a
  //    runner's shallow checkout has no tags, and a local tag is not the
  //    published one.
  const ref = `refs/tags/v${version}`;
  let listing;
  try {
    listing = execFileSync('git', ['ls-remote', '--tags', 'origin', ref, `${ref}^{}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Stop(2, `could not ask GitHub for the release tags: ${error.stderr?.trim() || error.message}`);
  }
  const tagged = taggedCommit(listing, version);
  checkRelease(tagged, version, commit);

  // 2. The build number.
  const highest = await highestBuild(appStore(appStoreToken({ keyId, issuer, key }), client), bundleId, version);
  checkBuild(highest, version, build);
  return `v${version} is ${tagged.slice(0, 12)}, and build ${build} is free (highest so far: ${highest || 'none'}).`;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    console.log(await testflightCheck(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.error(error.message);
    process.exit(error.code);
  }
}
