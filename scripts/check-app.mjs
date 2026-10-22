import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { versionProblems } from '../lib/version.mjs';
import { BUILD_INFO } from './build-info.mjs';
import { BLOCK, LAYOUT, LOWEST_BASE, PINNED, STARTABLE, emulatorProject, ports } from '../lib/ports.mjs';
import { SDK_DEFAULT, isP256Point } from './check-web-push.mjs';
import { firebaseFixtures } from './ci-premerge.mjs';
import { deployNotesProblem } from './deploy-notes.mjs';
import { SECRET_LOCAL } from './lib/firebase-emulators.mjs';
import { releaseAccessProblems } from './lib/release-access.mjs';
import { DSN_VARIABLES, sentryGradleProblem } from './lib/sentry.mjs';
import { versionedFileProblems } from './release.mjs';
import { drift } from './workflows.mjs';

/**
 * What ci-tools needs to be true of the app repository it runs in.
 *
 *   sabeel-ci check-app
 *
 * The scripts here assume these; an app that broke one would not fail loudly,
 * it would publish a secret or build against the wrong identifiers. CI runs it
 * beside the app's own tests.
 */

/** Files the CI scripts write from secrets; Git must never pick them up. */
export const PRIVATE_FILES = ['app/.env.local', 'app/.env.sentry-build-plugin', 'app/android/keystore.properties'];

/** The script native-e2e seeds the emulators with for the Maestro flows. */
export const SEED = 'scripts/seed-emulators.mjs';

/** Files every build writes; unless Git ignores them, each build is marked as built from uncommitted changes. */
export const GENERATED_FILES = [BUILD_INFO];

/**
 * Firebase's default emulator ports, which every checkout that leaves one
 * unpinned shares, and two web dev-server ports the apps gave up.
 */
const ABANDONED = new Set([8080, 9150, 9099, 5001, 9199, 9299, 9499, 4000, 4400, 4500, 8083, 8086]);

const readIf = (root, path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined);

/** The source files under `directory`: where a stated port or emulator project would hide, or a DSN be read. */
function scriptFiles(root, directory = 'scripts') {
  if (!existsSync(join(root, directory))) return [];
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : scriptFiles(root, path);
    return /\.(mjs|cjs|js|tsx?|sh)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every place the app states an emulator port agrees with ci-tools.json. Two
 * cannot read it and are held in step here: firebase.json, which the
 * emulators bind, and app/src/env.ts's EMULATOR_PORTS, inlined into the
 * client bundle. Scripts and package.json state no port of the block at all,
 * and no Firebase default: they read them from `sabeel-ci ports` and
 * ci-tools.json. Neither they, Firebase's config nor the functions' parameters
 * name another emulator project (projectProblems). A port that disagrees is
 * silent until something connects to it and finds nobody, or worse, a
 * sibling checkout's emulator, which reads and writes happily and passes.
 */
export function portProblems(root = '.') {
  const settings = config(root);
  const { base } = settings.emulators;
  const project = emulatorProject(settings);
  const want = ports(settings);
  const nameOf = Object.fromEntries(Object.entries(want).map(([name, port]) => [port, name]));
  const found = [];

  let emulators = null;
  try {
    emulators = JSON.parse(readFileSync(resolve(root, 'firebase.json'), 'utf8')).emulators;
    if (!emulators || typeof emulators !== 'object') {
      found.push('firebase.json has no emulators section');
      emulators = null;
    }
  } catch (error) {
    found.push(`firebase.json: cannot read it: ${error.message}`);
  }
  const runs = [];
  if (emulators) {
    for (const [service, entry] of Object.entries(emulators)) {
      if (!entry || typeof entry !== 'object') continue;
      if (!Object.hasOwn(LAYOUT, service) || LAYOUT[service] >= LAYOUT.web || service === 'firestoreWebsocket') {
        found.push(`firebase.json runs the ${service} emulator, which the ci-tools port layout has no place for (lib/ports.mjs LAYOUT)`);
      } else if (entry.port !== want[service]) {
        found.push(`firebase.json pins ${service} to ${entry.port ?? 'no port'}; this app's ${service} port is ${want[service]}`);
      }
      if (STARTABLE.includes(service)) runs.push(service);
    }
    for (const service of PINNED.filter((name) => !emulators[name])) {
      found.push(`firebase.json does not pin ${service}: every run starts it, and unpinned it takes Firebase's default port, which other checkouts take too`);
    }
    const socket = emulators.firestore?.websocketPort;
    if (emulators.firestore && socket !== want.firestoreWebsocket) {
      found.push(`firebase.json pins firestore.websocketPort to ${socket ?? 'no port'}; this app's is ${want.firestoreWebsocket} (unpinned it is 9150, and moves on a collision)`);
    }
  }

  let client = null;
  try {
    client = /EMULATOR_PORTS\s*=\s*\{([^}]*)\}/.exec(readFileSync(resolve(root, 'app/src/env.ts'), 'utf8'))?.[1];
    if (!client) found.push('app/src/env.ts has no EMULATOR_PORTS = { … }, the ports the app connects to');
  } catch (error) {
    found.push(`app/src/env.ts: cannot read it: ${error.message}`);
  }
  if (client) {
    const entries = Object.fromEntries([...client.matchAll(/(\w+)\s*:\s*(\d+)/g)].map((match) => [match[1], Number(match[2])]));
    for (const [service, port] of Object.entries(entries)) {
      if (port !== want[service]) found.push(`app/src/env.ts connects ${service} to ${port}; this app's ${service} port is ${want[service] ?? 'not in the layout'}`);
    }
    for (const service of runs.filter((name) => !(name in entries))) {
      found.push(`app/src/env.ts EMULATOR_PORTS has no ${service}, which firebase.json runs: the app would not use that emulator`);
    }
  }

  const shared = /EMULATOR_PROJECT_ID\s*=\s*['"]([^'"]+)['"]/.exec(readIf(root, 'packages/shared/src/constants.ts') ?? '')?.[1];
  if (shared === undefined) found.push('packages/shared/src/constants.ts has no EMULATOR_PROJECT_ID, the emulator project the app and the functions check for');
  else if (shared !== project) found.push(`packages/shared/src/constants.ts says the emulator project is ${shared}; this app's is ${project}, demo-sabeel-<name> from ci-tools.json`);
  for (const name of existsSync(join(root, 'functions')) ? readdirSync(join(root, 'functions')) : []) {
    if (/^\.env\.demo-/.test(name) && name !== `.env.${project}`) {
      found.push(`functions/${name} is for another project: the Functions emulator reads functions/.env.${project}`);
    }
  }

  const last = base + BLOCK - 1;
  const list = (numbers) => [...numbers].sort((a, b) => a - b).map((port) => (nameOf[port] ? `${port} (${nameOf[port]})` : `${port}`)).join(', ');
  for (const file of [...scriptFiles(root), 'package.json']) {
    const text = readIf(root, file);
    if (text === undefined) continue;
    const abandoned = new Set();
    const foreign = new Set();
    const stated = new Set();
    for (const match of text.matchAll(/(?:(?:127\.0\.0\.1|localhost|0\.0\.0\.0|10\.0\.2\.2):|--port[ =]|tcp:)(\d{2,5})\b/g)) {
      const port = Number(match[1]);
      if (ABANDONED.has(port)) abandoned.add(port);
      else if (port >= LOWEST_BASE && (port < base || port > last)) foreign.add(port);
    }
    for (const match of text.matchAll(/(?<![\d.])(\d{5})(?!\d)/g)) {
      const port = Number(match[1]);
      if (port >= base && port <= last) stated.add(port);
    }
    if (abandoned.size) found.push(`${file} names ${list(abandoned)}: Firebase defaults or given-up ports, not this app's`);
    if (foreign.size) found.push(`${file} names ${list(foreign)}, outside this app's block ${base}-${last}: another checkout's`);
    if (stated.size) found.push(`${file} states ${list(stated)}: read ports from ci-tools instead (\`sabeel-ci ports <name>\`, ports() in Node)`);
  }
  return [...found, ...projectProblems(root, project)];
}

/**
 * An emulator project id: demo-sabeel and its hyphenated words, or any demo-
 * id passed as --project. A template (demo-sabeel-<name>, demo-sabeel-${name})
 * is not one.
 */
const PROJECT_IDS = [/(?<![\w-])(demo-sabeel(?:-[a-z0-9]+)*)(?![\w<${-])/g, /--project[ =]+["']?(demo(?:-[a-z0-9]+)+)(?![\w<${-])/g];

/**
 * Every emulator project the scripts, the npm scripts, Firebase's config and
 * the functions' parameters name is this app's: another is a renamed
 * project's leftover (`CHECK_PROJECT=demo-sabeel-recordings`), which talks to
 * nobody, or to a sibling checkout's emulators. The docs and the deploy log
 * keep their history; they are not read.
 */
function projectProblems(root, project) {
  const functions = existsSync(join(root, 'functions'))
    ? readdirSync(join(root, 'functions')).filter((name) => name.startsWith('.env')).sort().map((name) => `functions/${name}`) : [];
  const files = [...scriptFiles(root), 'package.json', 'app/package.json', 'functions/package.json', 'firebase.json', '.firebaserc', ...functions];
  return files.flatMap((file) => {
    const text = readIf(root, file);
    if (text === undefined) return [];
    const others = [...new Set(PROJECT_IDS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1])))].filter((id) => id !== project);
    return others.length
      ? [`${file} names the emulator project ${others.join(', ')}; this app's is ${project}: take it from \`sabeel-ci ports --project\` (emulatorProject() in Node)`]
      : [];
  });
}

/** Headers on every page Hosting serves but Firebase's own (/__/, whose auth handler is framed). */
export const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
const NOT_FIREBASE = '!/__/**';
/** Directories whose files are named by their content, so a browser may keep them for good. */
export const IMMUTABLE = { '/_expo/static/**': 'public, max-age=31536000, immutable', '/assets/**': 'public, max-age=31536000, immutable' };
/** The single-page app's rewrite, which leaves Metro's chunks out: a missing one is a 404, not index.html run as JavaScript. */
export const SPA_REWRITE = { source: '!/_expo/**', destination: '/index.html' };
/** Hosting's predeploy: a local hosting deploy exports again through build-web, never uploading what an e2e run left in app/dist-web. */
export const PREDEPLOY = 'npm run web:export -w @sabeel/app';

/** firebase.json's Hosting site and .firebaserc against the one shape every app serves. */
export function hostingProblems(root = '.') {
  const found = [];
  const hosting = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8')).hosting;
  if (!hosting || typeof hosting !== 'object' || Array.isArray(hosting)) {
    return ['firebase.json must have one Hosting site, an object under "hosting": Deploy Web publishes one'];
  }
  const rules = Array.isArray(hosting.headers) ? hosting.headers : [];
  const valueOf = (rule, key) => rule?.headers?.find((header) => header.key?.toLowerCase() === key.toLowerCase())?.value;
  const guarded = rules.find((rule) => rule.source === NOT_FIREBASE);
  if (!guarded) {
    found.push(`firebase.json hosting has no headers rule for ${NOT_FIREBASE}, every page but Firebase's own: it sets `
      + Object.entries(SECURITY_HEADERS).map(([key, value]) => `${key}: ${value}`).join(', '));
  }
  for (const [key, value] of guarded ? Object.entries(SECURITY_HEADERS) : []) {
    const set = valueOf(guarded, key);
    const right = key === 'Content-Security-Policy' ? set?.split(';').map((part) => part.trim()).includes(value) : set === value;
    if (!right) found.push(`firebase.json hosting does not set ${key}: ${value} on ${NOT_FIREBASE}${set === undefined ? '' : ` (it sets ${JSON.stringify(set)})`}`);
  }
  for (const rule of rules.filter((other) => other.source !== NOT_FIREBASE)) {
    for (const key of ['X-Frame-Options', 'Content-Security-Policy'].filter((name) => valueOf(rule, name) !== undefined)) {
      found.push(`firebase.json hosting sets ${key} on ${rule.source}; set it on ${NOT_FIREBASE} only, so Firebase's own /__/ pages, which sign-in frames, keep working`);
    }
  }
  for (const [source, value] of Object.entries(IMMUTABLE)) {
    if (valueOf(rules.find((rule) => rule.source === source), 'Cache-Control') !== value) {
      found.push(`firebase.json hosting does not cache ${source} as "${value}": its files are named by their content`);
    }
  }
  const predeploy = [hosting.predeploy].flat();
  if (predeploy.length !== 1 || predeploy[0] !== PREDEPLOY) {
    found.push(`firebase.json hosting's predeploy must be "${PREDEPLOY}" alone, so a hosting deploy exports through build-web, `
      + `which refuses an emulator bundle, rather than uploading whatever app/dist-web holds${hosting.predeploy === undefined ? '' : ` (it runs ${JSON.stringify(hosting.predeploy)})`}`);
  }
  const rewrites = (Array.isArray(hosting.rewrites) ? hosting.rewrites : []).filter((rewrite) => rewrite.destination === SPA_REWRITE.destination);
  if (!rewrites.some((rewrite) => rewrite.source === SPA_REWRITE.source) || rewrites.some((rewrite) => rewrite.source !== SPA_REWRITE.source)) {
    found.push(`firebase.json hosting must rewrite to ${SPA_REWRITE.destination} from "${SPA_REWRITE.source}" alone, so a missing chunk under /_expo/ is a 404 rather than index.html served as JavaScript`
      + (rewrites.length ? ` (it rewrites from ${rewrites.map((rewrite) => JSON.stringify(rewrite.source)).join(', ')})` : ''));
  }
  let projects;
  try {
    projects = JSON.parse(readFileSync(join(root, '.firebaserc'), 'utf8')).projects;
  } catch (error) {
    return [...found, `.firebaserc: cannot read it: ${error.message}`];
  }
  if (typeof projects?.default !== 'string' || !projects.default) {
    found.push(`.firebaserc has no "default" project alias${projects && Object.keys(projects).length ? ` (it has ${Object.keys(projects).join(', ')})` : ''}: firebase and the push checks use the default`);
  }
  return found;
}

const MANIFEST = 'app/android/app/src/main/AndroidManifest.xml';
const DEFAULT_CHANNEL = 'com.google.firebase.messaging.default_notification_channel_id';

/**
 * The Android notification channel a push lands in when a send names none:
 * the functions' own, PUSH_CHANNEL_ID in @sabeel/shared. Without it Android
 * makes "Miscellaneous", a channel nobody recognises and nothing can remove.
 */
export function pushChannelProblems(root = '.') {
  const sources = scriptFiles(root, 'packages/shared/src').filter((path) => !/\.test\.[cm]?[jt]sx?$/.test(path));
  const channels = sources.flatMap((path) => [...readFileSync(join(root, path), 'utf8').matchAll(/export const PUSH_CHANNEL_ID\s*=\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
  if (channels.length !== 1) return [`packages/shared/src must export one PUSH_CHANNEL_ID, the channel the functions send on; it exports ${channels.length}`];
  const [channel] = channels;
  const manifest = readIf(root, MANIFEST);
  if (manifest === undefined) return [`${MANIFEST} is missing`];
  const attribute = (tag, name) => new RegExp(`\\bandroid:${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
  const named = [...manifest.matchAll(/<meta-data\b[^>]*>/g)].map((match) => match[0]).filter((tag) => attribute(tag, 'name') === DEFAULT_CHANNEL);
  if (named.length !== 1) {
    return [`${MANIFEST} has no ${DEFAULT_CHANNEL} meta-data, so a push sent without a channel lands in Android's "Miscellaneous":\n`
      + `    <meta-data android:name="${DEFAULT_CHANNEL}" android:value="${channel}"/>`];
  }
  const value = attribute(named[0], 'value');
  return value === channel ? [] : [`${MANIFEST} makes ${value} the default notification channel; the functions send on PUSH_CHANNEL_ID ${channel}`];
}

const FIREBASE_CONFIG = 'app/src/firebase-config.ts';

/**
 * The web push public key, committed where every app's web push reads it: it
 * is public, as the Firebase apiKey beside it is, and a build without it, or
 * with a broken paste, is inert in every browser and fails nowhere.
 * check-web-push looks for it again in the release export.
 */
export function vapidKeyProblems(root = '.') {
  const key = /^export const VAPID_PUBLIC_KEY\s*=\s*['"]([^'"]*)['"]/m.exec(readIf(root, FIREBASE_CONFIG) ?? '')?.[1];
  if (key === undefined) {
    return [`${FIREBASE_CONFIG} does not export VAPID_PUBLIC_KEY = '<key>', the public key of the project's Web Push certificate `
      + '(Firebase console, Cloud Messaging) that web push subscribes browsers with'];
  }
  if (key === SDK_DEFAULT) return [`${FIREBASE_CONFIG}'s VAPID_PUBLIC_KEY is the Firebase SDK's sample key, not the project's Web Push certificate`];
  return isP256Point(key) ? [] : [`${FIREBASE_CONFIG}'s VAPID_PUBLIC_KEY is not a P-256 public key: truncated, or copied from the wrong field `
    + "of the project's Web Push certificate (Firebase console, Cloud Messaging). Browsers refuse to subscribe with it"];
}

/** The google-services Gradle plugin every app builds with. */
export const GOOGLE_SERVICES_PLUGIN = '4.4.4';

/**
 * A release Gradle cannot sign stops, rather than coming out unsigned: AGP
 * creates no validateSigningRelease task without a key, and packages the
 * release anyway. The pre-merge build, which sets the release signing config
 * to null on purpose, passes.
 */
export function releaseSigningProblem(gradle) {
  const start = /gradle\.taskGraph\.whenReady\s*\{/.exec(gradle);
  let block = '';
  if (start) {
    let depth = 0;
    for (let index = start.index + start[0].length - 1; index < gradle.length; index += 1) {
      depth += gradle[index] === '{' ? 1 : gradle[index] === '}' ? -1 : 0;
      if (depth === 0) {
        block = gradle.slice(start.index, index + 1);
        break;
      }
    }
  }
  const asks = [/\(package\|sign\)Release\(Bundle\)\?/, /buildTypes\.release\.signingConfig\b/, /!=\s*null/, /\.storeFile\s*==\s*null/, /throw new GradleException\(/];
  if (asks.every((ask) => ask.test(block))) return null;
  return 'app/android/app/build.gradle does not stop a release it cannot sign: without a key AGP packages it unsigned\n'
    + '    rather than failing. Add, after the android { } block:\n'
    + '        gradle.taskGraph.whenReady { graph ->\n'
    + '            def releaseSigning = android.buildTypes.release.signingConfig\n'
    + '            def packagesRelease = graph.allTasks.any { it.project == project && it.name ==~ /^(package|sign)Release(Bundle)?$/ }\n'
    + '            if (packagesRelease && releaseSigning != null && releaseSigning.storeFile == null) {\n'
    + '                throw new GradleException("No release key: …")\n'
    + '            }\n'
    + '        }';
}

/**
 * Files a public repository must never take, by example: the release
 * keystore, and service-account keys as Google's consoles name them. Each
 * must be ignored wherever it lands.
 */
export const KEY_FILES = {
  'release.jks': '*.jks',
  'app/android/app/release.keystore': '*.keystore',
  'play-service-account.json': '*service-account*.json',
  'example-project-firebase-adminsdk-abc12-0123456789.json': '*firebase-adminsdk*.json',
  // Sentry's Android tooling reads a token from it; a copy left in a checkout
  // would otherwise go in with the next `git add -A`.
  'app/android/sentry.properties': 'sentry.properties',
};

export function problems(root = '.') {
  const found = [];
  const attempt = (check) => {
    try {
      found.push(...check());
    } catch (error) {
      found.push(error.message);
    }
  };
  attempt(() => (config(root), []));
  attempt(() => drift(root));
  attempt(() => portProblems(root));
  const ignored = (path) => {
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  attempt(() => PRIVATE_FILES.filter((path) => !ignored(path)).map((path) => `.gitignore does not cover ${path}, which CI writes from a secret`));
  attempt(() => Object.entries(KEY_FILES).filter(([path]) => !ignored(path))
    .map(([path, pattern]) => `.gitignore does not cover ${pattern} (${path}, say): a key committed to a public repository stays readable in its history`));
  attempt(() => GENERATED_FILES.filter((path) => !ignored(path))
    .map((path) => `.gitignore does not cover ${path}, which every build writes, so each build is marked as built from uncommitted changes`));
  attempt(() => {
    // sabeel-ci writes the emulators' placeholders here, and it is where the
    // Functions emulator would read a real secret from.
    const tracked = execFileSync('git', ['ls-files', '--', SECRET_LOCAL], { cwd: root, encoding: 'utf8' }).trim() !== '';
    return [
      ...(ignored(SECRET_LOCAL) ? [] : [`.gitignore does not cover ${SECRET_LOCAL}, which sabeel-ci writes for the emulators from ci.emulatorSecrets`]),
      ...(tracked ? [`${SECRET_LOCAL} is committed; sabeel-ci writes it from ci.emulatorSecrets, so the app keeps no copy: git rm --cached ${SECRET_LOCAL}`] : []),
    ];
  });
  attempt(() => {
    const directory = resolve(root, '.github/workflows');
    return releaseAccessProblems(readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(join(directory, name), 'utf8')]));
  });
  attempt(() => {
    const app = JSON.parse(readFileSync(resolve(root, 'app/app.json'), 'utf8')).expo;
    firebaseFixtures(app);
    return [];
  });
  attempt(() => versionedFileProblems(root));
  attempt(() => {
    const { version } = JSON.parse(readFileSync(resolve(root, 'app/app.json'), 'utf8')).expo;
    // A malformed version is reported once, by the version check below.
    if (versionProblems(version).length) return [];
    const problem = deployNotesProblem(String(version), root);
    return problem ? [`${problem}\n    The Android release build refuses to run without it.`] : [];
  });
  attempt(() => {
    // ci-platform hands the release key to Gradle in this variable, and only in it.
    const gradle = readFileSync(resolve(root, 'app/android/app/build.gradle'), 'utf8');
    const found = [];
    if (!gradle.includes("System.getenv('SABEEL_KEYSTORE_PROPERTIES')")) {
      found.push("app/android/app/build.gradle does not read the release key's properties from System.getenv('SABEEL_KEYSTORE_PROPERTIES')");
    }
    const others = [...new Set(gradle.match(/\b(?!SABEEL_KEYSTORE_PROPERTIES\b)\w+_KEYSTORE_PROPERTIES\b/g) ?? [])];
    if (others.length) found.push(`app/android/app/build.gradle names ${others.join(', ')}; the variable is SABEEL_KEYSTORE_PROPERTIES`);
    const sentry = sentryGradleProblem(gradle);
    if (sentry) found.push(sentry);
    const signing = releaseSigningProblem(gradle);
    if (signing) found.push(signing);
    return found;
  });
  attempt(() => {
    const version = /com\.google\.gms:google-services:([\w.-]+)/.exec(readIf(root, 'app/android/build.gradle') ?? '')?.[1];
    return version === GOOGLE_SERVICES_PLUGIN ? []
      : [`app/android/build.gradle ${version ? `takes the google-services Gradle plugin at ${version}` : 'names no com.google.gms:google-services plugin'}; every app builds with ${GOOGLE_SERVICES_PLUGIN}`];
  });
  attempt(() => hostingProblems(root));
  attempt(() => pushChannelProblems(root));
  attempt(() => vapidKeyProblems(root));
  attempt(() => {
    // The bundles carry debug ids, which match a crash to its source map with
    // no release name to keep in step; Sentry's Metro config adds them.
    const metro = readIf(root, 'app/metro.config.js') ?? '';
    return /require\(\s*['"]@sentry\/react-native\/metro['"]\s*\)/.test(metro) && /\bgetSentryExpoConfig\s*\(/.test(metro) ? []
      : ['app/metro.config.js does not build on getSentryExpoConfig from @sentry/react-native/metro, so its bundles carry no debug ids for Sentry to match their source maps by'];
  });
  attempt(() => {
    // The release builds check app/.env.local for these two names, so the app
    // must read its DSNs from them and no other.
    const sources = scriptFiles(root, 'app/src').filter((path) => !/\.test\.[cm]?[jt]sx?$/.test(path));
    const read = new Set(sources.flatMap((path) => [...readFileSync(join(root, path), 'utf8').matchAll(/\bEXPO_PUBLIC_SENTRY_DSN\w*/g)].map((match) => match[0])));
    const fixed = Object.values(DSN_VARIABLES);
    return [
      ...[...read].filter((name) => !fixed.includes(name)).sort()
        .map((name) => `app/src reads ${name}; the Sentry DSNs are ${fixed.join(' (Android and iOS) and ')} (web)`),
      ...fixed.filter((name) => !read.has(name)).map((name) => `app/src never reads ${name}, which the release builds require in app/.env.local`),
    ];
  });
  attempt(() => {
    // ci-tools' Dependabot moves the actions in the templates; one here would
    // edit rendered workflows, and its pull requests would fail as drift.
    const dependabot = readIf(root, '.github/dependabot.yml') ?? '';
    return /^\s*-?\s*package-ecosystem:\s*["']?github-actions\b/m.test(dependabot)
      ? ['.github/dependabot.yml updates github-actions, but the workflows are rendered from ci-tools, whose Dependabot updates them: remove that entry']
      : [];
  });
  attempt(() => {
    // native-e2e tells each flow the id of the build it installed, which
    // differs between Android's debug build and iOS. It seeds the emulators
    // for them with the app's one seed script.
    const directory = resolve(root, 'maestro');
    if (!existsSync(directory)) return [];
    const flows = readdirSync(directory, { recursive: true }).filter((name) => String(name).endsWith('.yaml'));
    return [
      ...flows.filter((name) => !readFileSync(join(directory, String(name)), 'utf8').split('\n').includes('appId: ${APP_ID}'))
        .map((name) => `maestro/${name} does not take its app from native-e2e: it must name it as appId: \${APP_ID}`),
      ...(flows.length && !existsSync(join(root, SEED))
        ? [`maestro/ holds flows, but there is no ${SEED}: native-e2e seeds the emulators for them with it`] : []),
    ];
  });
  attempt(() => {
    const manifest = resolve(root, 'functions/package.json');
    if (!existsSync(manifest)) return [];
    const { dependencies, devDependencies } = JSON.parse(readFileSync(manifest, 'utf8'));
    const lock = JSON.parse(readFileSync(resolve(root, 'functions/package-lock.json'), 'utf8')).packages[''];
    return JSON.stringify([lock.dependencies, lock.devDependencies]) === JSON.stringify([dependencies, devDependencies])
      ? [] : ['functions/package-lock.json is out of step with functions/package.json (Cloud Build installs from that lock): run npm install in functions/'];
  });
  return found;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const found = problems();
  if (found.length) {
    console.error(found.map((problem) => `- ${problem}`).join('\n'));
    process.exit(1);
  }
  console.log('the app meets what ci-tools assumes');
}
