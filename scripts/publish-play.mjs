import { execFileSync } from 'node:child_process';
import { createHash, createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { androidIdentity } from '../lib/version.mjs';

/**
 * Put the release bundle on Google Play's internal testing track. Every app
 * publishes this one way: the Publish Android workflow (`ci-play release`),
 * which `sabeel-ci release --ship` runs on CI's bundle, and by hand from a
 * release machine.
 *
 *   sabeel-ci publish-play --check      # every gate, and the Play permission; uploads nothing
 *   sabeel-ci publish-play --internal   # publish: everyone on the tester list gets it
 *
 * The destination must be named. Publishing reaches every tester, so a bare
 * run, or any argument this script does not know, prints the usage and stops.
 *
 * The bundle is app/android/app/build/outputs/bundle/release/app-release.aab.
 * Before anything leaves the machine the script refuses a bundle that:
 *
 *  - is not signed, or is signed with the debug key;
 *  - does not carry HEAD's commit (a bundle from an earlier build), or carries
 *    it marked `<commit>+`, built from uncommitted changes;
 *  - does not name app.json's version, or was built by a build.gradle that
 *    states its own version instead of deriving it from app.json.
 *
 * Then, in three steps:
 *
 *  1. The bundle goes up as a DRAFT release on the internal track, which no
 *     tester sees, replacing whatever draft was there. The script refuses an
 *     upload whose versionCode, as Play read it, is not the one app.json's
 *     version gives. A rerun after a failure resumes with the bundle Play
 *     already holds for that versionCode, and only if it is this very bundle.
 *  2. Play turns the bundle into the APKs phones install. The script waits for
 *     them and refuses unless Play signs them with ci-tools.json's
 *     release.appSigningCertificate. Play Console gives every new app a
 *     Google-generated signing key the moment it is created, and APKs Play
 *     generated before a key change stay signed with the old key.
 *  3. Only then does the draft become a completed release that testers get.
 *     Play keeps an app's very first release a draft if the API may not
 *     complete it; the script says so, and one "Start rollout" in Play Console
 *     sends it.
 *
 * --check runs every gate, then proves the publishing account may release this
 * app by creating and discarding an edit. It does that even when a gate fails,
 * so the credential can be checked before a bundle exists, and it exits 1 when
 * a real run would refuse.
 *
 * The key is the Play publishing service account's JSON, outside the
 * repository (it is public): ~/keys/sabeel-play-publisher.json, or the path in
 * PLAY_KEY. One account publishes every Sabeel app; Play Console gives it
 * "Release apps to testing tracks" per app.
 */

export const BUNDLE = 'app/android/app/build/outputs/bundle/release/app-release.aab';
const API = 'https://androidpublisher.googleapis.com';
const USAGE = `usage: sabeel-ci publish-play --check | --internal

  --check      every gate, and proof the publishing account may release this app;
               uploads nothing
  --internal   upload the bundle to the internal testing track; testers get it`;

const output = (program, args) => execFileSync(program, args, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** A certificate fingerprint as bare lowercase hex, for comparing. */
export const fingerprint = (value) => value.replaceAll(':', '').toLowerCase();

/**
 * The release bundle against what it must be: the app's identity (null when
 * app.json and build.gradle do not give one), what the bundle is, and every
 * reason it may not go to Play.
 */
export function inspectBundle() {
  const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
  const problems = [];
  let identity = null;
  try {
    identity = androidIdentity(app, readFileSync('app/android/app/build.gradle', 'utf8'));
  } catch (error) {
    problems.push(error.message);
  }
  const head = output('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  const found = { packageName: app.android?.package, version: app.version, identity, head, problems };
  try {
    found.size = statSync(BUNDLE).size;
  } catch {
    problems.push(`No bundle at ${BUNDLE}. Build it: npx sabeel-ci build-aab`);
    return found;
  }
  // An AAB is a signed jar, so jarsigner reads it (apksigner does not).
  try {
    found.signer = /Signed by "([^"]+)"/.exec(output('jarsigner', ['-verify', '-verbose:summary', '-certs', BUNDLE]).toString())?.[1];
  } catch {
    // jarsigner exits non-zero on an unsigned jar; the missing signer says so below.
  }
  const keystore = "Restore the app's EXISTING release keystore and its properties (docs/SECRETS.md),\n"
    + '    then rebuild; never generate a new key, which Play refuses.';
  if (!found.signer) problems.push(`${BUNDLE} is not signed, or jarsigner cannot read its signature. ${keystore}`);
  else if (/CN=Android Debug/i.test(found.signer)) problems.push(`${BUNDLE} is signed with the DEBUG key (${found.signer}). ${keystore}`);
  // Hermes keeps string literals readable, so build-info's commit is findable
  // in the compiled JavaScript.
  let javascript = Buffer.alloc(0);
  try {
    javascript = output('unzip', ['-p', BUNDLE, 'base/assets/index.android.bundle']);
  } catch {
    // An unreadable bundle carries no commit; the check below says so.
  }
  if (!javascript.includes(Buffer.from(head))) {
    problems.push(`The bundle's JavaScript does not carry HEAD (${head}): it was built from another commit.\n    Rebuild it: npx sabeel-ci build-aab`);
  } else if (javascript.includes(Buffer.from(`${head}+`))) {
    problems.push(`The bundle was built from uncommitted changes (${head}+). Commit, then rebuild it.`);
  }
  // The manifest is binary protobuf, but versionName sits in it as a plain
  // string. Every X.Y.Z in it is read, so 0.2.10 never passes for 0.2.1.
  let manifest = '';
  try {
    manifest = output('unzip', ['-p', BUNDLE, 'base/manifest/AndroidManifest.xml']).toString('latin1');
  } catch {
    // As above: no manifest names no version.
  }
  const versions = [...new Set(manifest.match(/\d+\.\d+\.\d+/g) ?? [])];
  if (!versions.includes(app.version)) {
    problems.push(`The bundle is not version ${app.version} (app.json's)${versions.length ? `: it names ${versions.join(', ')}` : ''}. Rebuild it.`);
  }
  return found;
}

/** The service account's key from `path`, checked for the fields a token needs. Its content is never printed. */
export function readCredential(path) {
  let credential;
  try {
    credential = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`No Play publishing key at ${path} (or set PLAY_KEY to its path).\n`
      + 'It stays outside the repository, which is public; docs/SECRETS.md says where it lives.');
  }
  if (credential?.type !== 'service_account' || typeof credential.client_email !== 'string' || typeof credential.private_key !== 'string') {
    throw new Error(`${path} is not a service account's JSON key (type, client_email, private_key).`);
  }
  return credential;
}

/** A service account's OAuth token: an RS256 assertion exchanged at Google. */
export async function accessToken(credential, request = fetch) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: credential.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const rotate = 'If its key was rotated or deleted, make a new one (Google Cloud, IAM & Admin, Service Accounts,\n'
    + 'the publisher, Keys, Add key, JSON) and replace the file.';
  let assertion;
  try {
    assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(credential.private_key, 'base64url')}`;
  } catch {
    throw new Error(`The private key of ${credential.client_email} cannot sign. ${rotate}`);
  }
  const response = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(30_000),
  });
  const token = response.ok ? (await response.json()).access_token : undefined;
  if (!token) throw new Error(`Google issued no token for ${credential.client_email} (HTTP ${response.status}).\n${rotate}`);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token}`);
  return token;
}

/** The Play Developer API for one app, as `token`. */
export function playApi(token, packageName, request = fetch) {
  const app = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  const send = async (method, url, body, type, timeout) => {
    const response = await request(url, {
      method, body, signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${token}`, ...(type ? { 'content-type': type } : {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${url.replace(API, '')}: HTTP ${response.status}\n${text}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    packageName,
    call: (method, path, body) => send(method, `${API}${app}${path}`, body && JSON.stringify(body), body && 'application/json', 60_000),
    // Tens of megabytes; the API asks for a raised timeout.
    upload: (edit, bundle) => send('POST', `${API}/upload${app}/edits/${edit}/bundles?uploadType=media`, bundle, 'application/octet-stream', 15 * 60_000),
    /** A file's bytes, such as a generated APK's `:download?alt=media`. */
    download: async (path) => {
      const response = await request(`${API}${app}${path}`, { method: 'GET', signal: AbortSignal.timeout(15 * 60_000),
        headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}\n${(await response.text()).slice(0, 500)}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

/** Runs `work` in a fresh edit, which is discarded unless `work` commits it. */
async function inEdit(api, work) {
  const { id } = await api.call('POST', '/edits');
  if (!id) throw new Error('Play returned no edit');
  const edit = encodeURIComponent(id);
  let committed = false;
  try {
    await work(edit, async () => {
      await api.call('POST', `/edits/${edit}:commit`);
      committed = true;
    });
  } finally {
    if (!committed) await api.call('DELETE', `/edits/${edit}`).catch(() => {});
  }
}

/**
 * Proof that `credential` may release `packageName` to testing tracks: an edit
 * created and discarded, which uploads and changes nothing. A token alone
 * proves only that the key is valid; Play Console grants the permission.
 */
export async function checkPlayAccess(credential, packageName, request = fetch) {
  const api = playApi(await accessToken(credential, request), packageName, request);
  let edit;
  try {
    edit = await api.call('POST', '/edits');
  } catch (error) {
    throw new Error(`Play refused ${credential.client_email} for ${packageName}:\n${error.message}\n\n`
      + 'In Play Console, Users and permissions, that account needs this app with\n"Release apps to testing tracks".');
  }
  if (!edit.id) throw new Error('Play returned no permission-check edit');
  try {
    await api.call('DELETE', `/edits/${encodeURIComponent(edit.id)}`);
  } catch (error) {
    throw new Error(`Could not discard the permission-check edit ${edit.id}:\n${error.message}`);
  }
  return api;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Steps 1 to 3 of the header: draft, Play's signature on what phones install, then out to the testers. */
export async function publish(api, { versionName, versionCode }, appSigningCertificate) {
  const release = (status) => ({ track: 'internal', releases: [{ versionCodes: [String(versionCode)], status }] });
  const bundle = readFileSync(BUNDLE);
  await inEdit(api, async (edit, commit) => {
    const { bundles = [] } = await api.call('GET', `/edits/${edit}/bundles`);
    const held = bundles.find((candidate) => candidate.versionCode === versionCode);
    if (held) {
      if (held.sha256?.toLowerCase() !== createHash('sha256').update(bundle).digest('hex')) {
        throw new Error(`Play already holds a different bundle as versionCode ${versionCode}. Release a new version and build its bundle.`);
      }
      console.log(`\nPlay already holds this bundle as ${versionName} (${versionCode}); not uploading it again.`);
    } else {
      console.log('\nUploading...');
      const uploaded = (await api.upload(edit, bundle)).versionCode;
      if (uploaded !== versionCode) {
        throw new Error(`Play read versionCode ${uploaded} from the bundle; app.json's version ${versionName} gives ${versionCode}. Rebuild it.`);
      }
    }
    await api.call('PUT', `/edits/${edit}/tracks/internal`, release('draft'));
    await commit();
  });
  console.log('A draft release on the internal track holds it; no tester sees a draft.');

  // Play generates the APKs after the commit.
  let signers = [];
  for (let attempt = 0; attempt < 60 && signers.length === 0; attempt++) {
    if (attempt > 0) await sleep(10_000);
    const { generatedApks = [] } = await api.call('GET', `/generatedApks/${versionCode}`).catch(() => ({}));
    signers = generatedApks.map((apk) => apk.certificateSha256Hash);
  }
  if (signers.length === 0) throw new Error('Play generated no APKs from the bundle within 10 minutes. Rerun later; the draft is kept.');
  if (signers.some((signer) => fingerprint(String(signer)) !== fingerprint(appSigningCertificate))) {
    throw new Error(`Play signs this build with ${[...new Set(signers)].join(', ')},\n`
      + `not with the app signing key ci-tools.json names (release.appSigningCertificate), ${appSigningCertificate}.\n`
      + 'It stays an unreleased draft. If Play Console (App integrity, App signing) shows that key,\n'
      + 'Play generated these APKs before the key changed: release a new version. If it shows\n'
      + "another, either ci-tools.json is wrong or Play's key is not the one intended (\"Change key\"\n"
      + "there makes the app's own release key Play's).");
  }
  console.log("Play signs the APKs phones install with the app's signing key.");

  let draftOnly = false;
  await inEdit(api, async (edit, commit) => {
    await api.call('PUT', `/edits/${edit}/tracks/internal`, release('completed'));
    try {
      await commit();
    } catch (error) {
      // "Only releases with status draft may be created on draft app."
      if (!/draft app/i.test(error.message)) throw error;
      draftOnly = true;
    }
  });
  console.log(draftOnly
    ? `\n${versionName} (${versionCode}) is a draft on the internal testing track: Play keeps an app's first\n`
      + 'release a draft until it is rolled out in Play Console (Internal testing, Start rollout).'
    : `\n${versionName} (${versionCode}) is on the internal testing track. Testers get it from Play within minutes.`);
}

async function main(args) {
  if (args.length !== 1 || !['--check', '--internal'].includes(args[0])) {
    console.error(USAGE);
    return args.length === 1 && args[0] === '--help' ? 0 : 2;
  }
  const check = args[0] === '--check';
  const { release } = config();
  const bundle = inspectBundle();
  const key = process.env.PLAY_KEY || join(homedir(), 'keys', 'sabeel-play-publisher.json');
  console.log(`package   ${bundle.packageName}`);
  console.log(`version   ${bundle.version}${bundle.identity ? ` (${bundle.identity.versionCode})` : ''}`);
  console.log(`bundle    ${bundle.size === undefined ? 'none' : `${(bundle.size / 1024 / 1024).toFixed(1)} MB, commit ${bundle.head}, signed by ${bundle.signer ?? 'nobody'}`}`);
  console.log(`key       ${key}`);
  console.log('target    the internal testing track: every tester gets it');
  const refusals = bundle.problems.map((problem) => `  - ${problem}`).join('\n');
  if (bundle.problems.length) {
    if (!check) throw new Error(`Not publishing this bundle:\n${refusals}`);
    console.log(`\nA real run would refuse this bundle:\n${refusals}`);
  }
  const credential = readCredential(key);
  const api = await checkPlayAccess(credential, bundle.packageName);
  if (check) {
    console.log(bundle.problems.length
      ? `\n--check: ${credential.client_email} may release this app, but a real run would refuse the bundle\nfor the reasons above. Nothing was uploaded.`
      : `\n--check: every gate passes, and ${credential.client_email} may release this app\n(an edit was created and discarded). Nothing was uploaded.`);
    return bundle.problems.length ? 1 : 0;
  }
  try {
    await publish(api, bundle.identity, release.appSigningCertificate);
  } catch (error) {
    throw new Error(`${error.message}\n\nNothing reached the testers.`);
  }
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  }
}
