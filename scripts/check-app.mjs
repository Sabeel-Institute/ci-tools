import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { BLOCK, LAYOUT, LOWEST_BASE, PINNED, STARTABLE, ports } from '../lib/ports.mjs';
import { firebaseFixtures } from './ci-premerge.mjs';
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
export const PRIVATE_FILES = ['app/.env.local', 'app/android/keystore.properties'];

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
  const { base, project } = settings.emulators;
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
  else if (shared !== project) found.push(`packages/shared/src/constants.ts says the emulator project is ${shared}; ci-tools.json emulators.project is ${project}`);
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
  attempt(() => PRIVATE_FILES.flatMap((path) => {
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: root, stdio: 'ignore' });
      return [];
    } catch {
      return [`.gitignore does not cover ${path}, which CI writes from a secret`];
    }
  }));
  attempt(() => {
    const app = JSON.parse(readFileSync(resolve(root, 'app/app.json'), 'utf8')).expo;
    firebaseFixtures(app);
    return [];
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
