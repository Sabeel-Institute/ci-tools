import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { versionProblems } from '../lib/version.mjs';
import { BUILD_INFO } from './build-info.mjs';
import { BLOCK, LAYOUT, LOWEST_BASE, PINNED, STARTABLE, emulatorProject, ports } from '../lib/ports.mjs';
import { firebaseFixtures } from './ci-premerge.mjs';
import { deployNotesProblem } from './deploy-notes.mjs';
import { SECRET_LOCAL } from './lib/firebase-emulators.mjs';
import { releaseAccessProblems } from './lib/release-access.mjs';
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

/** The files a stated port or emulator project would hide in. */
function scriptFiles(root, directory = 'scripts') {
  if (!existsSync(join(root, directory))) return [];
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : scriptFiles(root, path);
    return /\.(mjs|cjs|js|ts|sh)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every place the app states an emulator port agrees with ci-tools.json. Two
 * cannot read it and are held in step here: firebase.json, which the
 * emulators bind, and app/src/env.ts's EMULATOR_PORTS, inlined into the
 * client bundle. Scripts and package.json state no port of the block at all,
 * and no Firebase default, and pass no other emulator project: they read
 * them from `sabeel-ci ports` and ci-tools.json. A port that disagrees is
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
    for (const other of new Set([...text.matchAll(/--project[ =]+["']?(demo-[a-z0-9-]+)/g)].map((match) => match[1]).filter((id) => id !== project))) {
      found.push(`${file} passes --project ${other}; this app's emulator project is ${project}`);
    }
  }
  return found;
}

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
    return found;
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
