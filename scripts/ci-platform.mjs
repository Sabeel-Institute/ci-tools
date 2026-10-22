import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { config } from '../lib/config.mjs';
import { buildAab } from './build-aab.mjs';
import { WEB_EXPORT, buildWeb, exportedScripts } from './build-web.mjs';
import { checkWebPush } from './check-web-push.mjs';
import { BUILD_ENV_FILE, debugIdProblems, dsnProblem } from './lib/sentry.mjs';

const command = (program, args, options = {}) => execFileSync(program, args, { maxBuffer: 64 * 1024 * 1024, ...options });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export function environmentValues(text) {
  return Object.values(parseEnv(text)).filter(Boolean);
}

function maskEnvironment(text) {
  for (const value of environmentValues(text)) {
    console.log(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
  }
}

function writePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: 0o600 });
}

// The build machine's values (the Sentry token; for iOS the Apple team and
// App Store Connect key ids) where sentry.gradle, the Xcode build and
// `build-ios` read them. GitHub masks a multi-line secret line by line
// ("NAME=value"), never the bare value, so every value is masked on its own
// before anything can print it.
function writeBuildEnv() {
  const settings = required('BUILD_ENV');
  maskEnvironment(settings);
  writePrivate(BUILD_ENV_FILE, settings);
}

function prepare(android) {
  const env = required('APP_ENV_LOCAL');
  maskEnvironment(env);
  writePrivate('app/.env.local', env);
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const path = join('app', name);
    if (existsSync(path) && /^\s*EXPO_PUBLIC_USE_EMULATORS\s*=\s*['"]?1\b/m.test(readFileSync(path, 'utf8'))) {
      throw new Error('Production builds must not use Firebase emulators');
    }
  }
  if (!android) return;
  writeBuildEnv();
  const settings = required('ANDROID_KEYSTORE_PROPERTIES');
  maskEnvironment(settings);
  const keystore = join(required('RUNNER_TEMP'), 'android-signing.keystore');
  const properties = join(required('RUNNER_TEMP'), 'android-keystore.properties');
  writePrivate(keystore, Buffer.from(required('ANDROID_KEYSTORE'), 'base64'));
  const normalized = settings.replace(/^\s*storeFile\s*[=:].*(?:\r?\n|$)/gm, '').trimEnd() + `\nstoreFile=${keystore}\n`;
  for (const name of ['storePassword', 'keyPassword', 'keyAlias']) {
    if (!new RegExp(`^\\s*${name}\\s*[=:]\\s*\\S`, 'm').test(normalized)) throw new Error(`Missing signing property ${name}`);
  }
  writePrivate(properties, normalized);
  // Every app's build.gradle signs releases with the properties this names,
  // and fails closed without them (check-app holds it to that).
  appendFileSync(required('GITHUB_ENV'), `SABEEL_KEYSTORE_PROPERTIES=${properties}\n`);
  if (process.env.ANDROID_GOOGLE_SERVICES_JSON) {
    const googleServices = JSON.parse(process.env.ANDROID_GOOGLE_SERVICES_JSON);
    const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
    if (!googleServices.client?.some((client) => client.client_info?.android_client_info?.package_name === app.android.package)) {
      throw new Error('Android Firebase configuration has the wrong package');
    }
    writePrivate('app/android/app/google-services.json', JSON.stringify(googleServices));
  }
}

// The iOS build job: app/.env.local as for the web, the build machine's values,
// and, for an app that does not commit it, the iOS Firebase config.
function prepareIos() {
  prepare(false);
  writeBuildEnv();
  if (process.env.GOOGLE_SERVICE_INFO_PLIST) {
    const plist = Buffer.from(process.env.GOOGLE_SERVICE_INFO_PLIST, 'base64').toString('utf8');
    const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
    if (/<key>BUNDLE_ID<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] !== app.ios.bundleIdentifier) {
      throw new Error('iOS Firebase configuration has the wrong bundle id');
    }
    writePrivate('app/GoogleService-Info.plist', plist);
  }
}

// The TestFlight job: the App Store Connect key where Apple's tools and
// testflight-check look for it, and its ids in the job's environment.
function appStoreKey() {
  const settings = required('BUILD_ENV');
  maskEnvironment(settings);
  const { ASC_KEY_ID: id, ASC_ISSUER_ID: issuer } = parseEnv(settings);
  if (!/^[A-Z0-9]+$/.test(id ?? '') || !/^[0-9a-f-]{36}$/i.test(issuer ?? '')) {
    throw new Error('BUILD_ENV must set ASC_KEY_ID (the key id) and ASC_ISSUER_ID (a UUID)');
  }
  const key = required('ASC_KEY_P8');
  if (!key.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('ASC_KEY_P8 is not a .p8 private key');
  writePrivate(join(homedir(), '.appstoreconnect/private_keys', `AuthKey_${id}.p8`), key.trimEnd() + '\n');
  appendFileSync(required('GITHUB_ENV'), `ASC_KEY_ID=${id}\nASC_ISSUER_ID=${issuer}\n`);
}

export function treeHashes(directory) {
  const result = {};
  function walk(path, prefix) {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error('Build artifacts must not contain symlinks');
      if (info.isDirectory()) walk(full, relative);
      else result[relative] = sha256(readFileSync(full));
    }
  }
  walk(directory, '');
  return result;
}

function record(platform, artifact, additional = {}) {
  const commit = command('git', ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(artifact, 'build-record.json'), JSON.stringify({
    platform, commit, repository: required('GITHUB_REPOSITORY'), repositoryId: required('GITHUB_REPOSITORY_ID'),
    runId: required('GITHUB_RUN_ID'), ref: required('GITHUB_REF'), ...additional,
  }, null, 2) + '\n');
}

// A release bundle or export carries HEAD's commit as build-info stamps it, and
// must not be marked as built from uncommitted changes.
function assertCommit(javascript, commit, what) {
  if (!javascript.some((text) => text.includes(Buffer.from(commit)))) throw new Error(`${what} does not carry the build commit`);
  if (javascript.some((text) => text.includes(Buffer.from(commit + '+')))) throw new Error(`${what} is marked as built from uncommitted changes`);
}

function android() {
  const commit = command('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  const { bundle } = buildAab(config());
  command('jarsigner', ['-verify', bundle]);
  const certificate = command('keytool', ['-printcert', '-jarfile', bundle]).toString();
  const fingerprint = /SHA256:\s*([A-Fa-f0-9:]+)/.exec(certificate)?.[1].replaceAll(':', '').toLowerCase();
  if (!fingerprint || fingerprint !== required('ANDROID_SIGNING_CERT_SHA256').replaceAll(':', '').toLowerCase()) {
    throw new Error('AAB certificate does not match the existing release/upload key');
  }
  assertCommit([command('unzip', ['-p', bundle, 'base/assets/index.android.bundle'])], commit, 'AAB');
  const artifact = join(required('RUNNER_TEMP'), 'android-artifact');
  mkdirSync(artifact, { recursive: true });
  copyFileSync(bundle, join(artifact, 'app-release.aab'));
  record('android', artifact, { sha256: sha256(readFileSync(bundle)), signingCertificate: fingerprint, bytes: statSync(bundle).size });
}

// The web release: built with source maps, whose debug ids must match the
// scripts' and reach the Sentry SDK. The site Hosting serves holds no map;
// the maps and their scripts sit beside it in the artifact, for Deploy Web to
// upload to Sentry when it publishes the site.
function web() {
  const dsn = dsnProblem('web');
  if (dsn) throw new Error(`not building the web release:\n  - ${dsn}`);
  const commit = command('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  buildWeb({ sourceMaps: true });
  const source = resolve(WEB_EXPORT);
  console.log(checkWebPush(source));
  const ids = debugIdProblems(source);
  if (ids.length) throw new Error(`the web export cannot be read in Sentry:\n${ids.map((problem) => `  - ${problem}`).join('\n')}`);
  const artifact = join(required('RUNNER_TEMP'), 'web-artifact');
  const all = Object.keys(treeHashes(source));
  const maps = all.filter((path) => path.endsWith('.map'));
  const copy = (paths, to) => {
    for (const path of paths) {
      const target = join(artifact, to, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(source, path), target);
    }
  };
  copy(all.filter((path) => !path.endsWith('.map')), 'site');
  copy([...maps, ...maps.map((path) => path.slice(0, -'.map'.length))], 'sourcemaps');
  const files = treeHashes(join(artifact, 'site'));
  if (!files['index.html'] || Object.keys(files).some((path) => /\.map$|(^|\/)\.env/.test(path))) {
    throw new Error('Web artifact must contain index.html and no source maps or environment files');
  }
  assertCommit(exportedScripts().map((path) => readFileSync(path)), commit, 'Web export');
  record('web', artifact, { files, sourceMaps: treeHashes(join(artifact, 'sourcemaps')) });
}

function resolveBuild(platform = 'web') {
  const id = required('BUILD_RUN_ID');
  if (!/^\d+$/.test(id)) throw new Error('Build run ID must be numeric');
  const repo = required('GITHUB_REPOSITORY');
  const api = (path) => JSON.parse(command('gh', ['api', path]).toString());
  const run = api(`repos/${repo}/actions/runs/${id}`);
  const workflow = api(`repos/${repo}/actions/workflows/${platform}.yml`);
  if (run.workflow_id !== workflow.id || run.status !== 'completed' || run.conclusion !== 'success'
    || run.head_branch !== 'main' || String(run.head_repository.id) !== required('GITHUB_REPOSITORY_ID')
    || !['push', 'workflow_dispatch'].includes(run.event) || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
    throw new Error(`Choose a successful ${platform === 'web' ? 'Web' : 'Android'} build from this repository main branch`);
  }
  const checks = api(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${run.head_sha}&status=completed&per_page=50`);
  if (!checks.workflow_runs.some((check) => check.conclusion === 'success' && ['push', 'workflow_dispatch'].includes(check.event))) {
    throw new Error('CI must pass on the exact build commit before deployment');
  }
  appendFileSync(required('GITHUB_OUTPUT'), `sha=${run.head_sha}\nrun_id=${id}\n`);
}

export function hostingConfig(source, site) {
  if (!source.hosting || Array.isArray(source.hosting)) throw new Error('Expected one Hosting site');
  const { predeploy, postdeploy, ...hosting } = source.hosting;
  void predeploy;
  void postdeploy;
  return { hosting: { ...hosting, public: resolve(site) } };
}

/** The downloaded web artifact, once its record names the selected build of this commit. */
function webArtifact() {
  const artifact = join(required('RUNNER_TEMP'), 'hosting-artifact');
  const build = JSON.parse(readFileSync(join(artifact, 'build-record.json'), 'utf8'));
  const commit = command('git', ['rev-parse', 'HEAD']).toString().trim();
  if (build.platform !== 'web' || build.commit !== commit || build.repository !== required('GITHUB_REPOSITORY')
    || String(build.repositoryId) !== required('GITHUB_REPOSITORY_ID') || String(build.runId) !== required('BUILD_RUN_ID')) {
    throw new Error('Downloaded artifact provenance does not match the selected build');
  }
  return { artifact, build };
}

function deployConfig() {
  const { artifact, build } = webArtifact();
  const site = join(artifact, 'site');
  if (JSON.stringify(treeHashes(site)) !== JSON.stringify(build.files)) throw new Error('Web artifact checksum mismatch');
  const source = JSON.parse(readFileSync('firebase.json', 'utf8'));
  writeFileSync(join(required('RUNNER_TEMP'), 'firebase-hosting.json'), JSON.stringify(hostingConfig(source, site)));
}

// Deploy Web's first job: the selected build's source maps to the app's web
// project in Sentry, with sentry-cli at the path SENTRY_CLI names (the
// workflow installs it, checksum-pinned). The token comes from BUILD_ENV, is
// masked, and reaches sentry-cli in its environment only. No upload, no
// deploy: the site never goes live with crashes nobody can read.
function sourceMaps() {
  const settings = config();
  const { artifact, build } = webArtifact();
  const directory = join(artifact, 'sourcemaps');
  if (!build.sourceMaps || !Object.keys(build.sourceMaps).some((path) => path.endsWith('.map'))) {
    throw new Error('The selected web build recorded no source maps; build it again with this ci-tools');
  }
  if (JSON.stringify(treeHashes(directory)) !== JSON.stringify(build.sourceMaps)) throw new Error('Source map checksum mismatch');
  const values = required('BUILD_ENV');
  maskEnvironment(values);
  const token = parseEnv(values).SENTRY_AUTH_TOKEN;
  if (!token) throw new Error("BUILD_ENV has no SENTRY_AUTH_TOKEN, so the web build's source maps cannot reach Sentry");
  const { BUILD_ENV: _, ...env } = process.env;
  command(required('SENTRY_CLI'), ['sourcemaps', 'upload', '--org', settings.sentry.org, '--project', settings.sentry.projects.web, directory],
    { stdio: 'inherit', env: { ...env, SENTRY_AUTH_TOKEN: token, SENTRY_LOAD_DOTENV: '0' } });
}

async function validateAuthentication() {
  const token = command('gcloud', ['auth', 'print-access-token']).toString().trim();
  const project = required('FIREBASE_PROJECT_ID');
  const response = await fetch(`https://firebasehosting.googleapis.com/v1beta1/projects/${project}/sites`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Hosting identity validation failed: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.sites?.some((site) => site.name.endsWith(`/sites/${project}`))) throw new Error('Expected Hosting site not found');
  console.log('Hosting deployment identity validated; no release published');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const task = process.argv[2];
  if (task === 'prepare-web') prepare(false);
  else if (task === 'prepare-android') prepare(true);
  else if (task === 'prepare-ios') prepareIos();
  else if (task === 'asc-key') appStoreKey();
  else if (task === 'android') android();
  else if (task === 'web') web();
  else if (task === 'resolve-build') resolveBuild();
  else if (task === 'resolve-android-build') resolveBuild('android');
  else if (task === 'deploy-config') deployConfig();
  else if (task === 'sourcemaps') sourceMaps();
  else if (task === 'validate-auth') await validateAuthentication();
  else throw new Error('Unknown CI platform task');
}
