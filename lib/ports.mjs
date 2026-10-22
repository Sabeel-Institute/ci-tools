/**
 * Where an app's emulators and dev servers listen, computed from its
 * ci-tools.json: `emulators.base` and the fixed layout below.
 *
 * Several checkouts share one machine, and Firebase's defaults (8080, 9099,
 * 5001, … 9499) are the same for all of them, so whichever suite started second
 * killed the other's Firestore. Each app owns a block of 100 ports instead, and
 * every service sits at the same offset in every block, so 61303 and 61203 both
 * read as "functions" in a `ss` or `ps` line, of LMS and of Kanban.
 *
 * The blocks start at 61000: the ephemeral range here is 32768-60999
 * (/proc/sys/net/ipv4/ip_local_port_range), so nothing above it is handed out
 * at random, and Firebase's defaults top out at 9499
 * (firebase-tools/lib/emulator/constants.js).
 *
 *   import { config } from '@sabeel-institute/ci-tools/lib/config.mjs';
 *   import { ports } from '@sabeel-institute/ci-tools/lib/ports.mjs';
 *   const { firestore, web } = ports(config(root));
 *
 * In shell: `sabeel-ci ports firestore`.
 */

/** Ports in a block, and the range a block's first port may take. */
export const BLOCK = 100;
export const LOWEST_BASE = 61000;
export const HIGHEST_BASE = 65400;

/**
 * Every service's offset in the block. Each app pins the emulator suite's
 * services in firebase.json (`sabeel-ci check-app` holds them in step) and
 * leaves out the optional ones it does not run: storage, and the dev servers.
 */
export const LAYOUT = {
  firestore: 0,
  firestoreWebsocket: 1,
  auth: 2,
  functions: 3,
  ui: 4,
  hub: 5,
  logging: 6,
  storage: 7,
  tasks: 8,
  eventarc: 9,
  // Started by the app's own scripts, not by firebase.
  web: 10, // the Expo web dev server: `dev:web`, the browser walkthrough, the native seed
  sweep: 11, // a second one for the screens sweep, so it can run beside the walkthrough
  proxy: 12, // a throttling proxy for a slow-connection device pass
};

/** Offsets below this are the emulator suite's; the app's extras start at EXTRAS. */
const DEV_SERVERS = LAYOUT.web;
export const EXTRAS = 20;

/** What firebase.json must pin: every emulator a run starts, the implicit ones included. */
export const PINNED = ['firestore', 'auth', 'functions', 'ui', 'hub', 'logging', 'tasks', 'eventarc'];

/** The emulators a run can name in `--only`; the rest start with them. */
export const STARTABLE = ['firestore', 'auth', 'functions', 'storage'];

/**
 * The blocks taken on the machines these apps are developed on, with the
 * emulator project of the checkout that owns each. 61100 is the legacy
 * recording app's, which does not use ci-tools.
 */
export const CLAIMED = {
  61000: 'demo-sabeel',
  61100: 'the legacy sabeel-recording-app checkout',
  61200: 'demo-sabeel-kanban',
  61300: 'demo-sabeel-recordings',
};

// ci-tools.json validators (lib/config.mjs): true, or why not.

export function base(value) {
  if (Number.isInteger(value) && value % BLOCK === 0 && value >= LOWEST_BASE && value <= HIGHEST_BASE) return true;
  return `must be a multiple of ${BLOCK} from ${LOWEST_BASE} to ${HIGHEST_BASE} (one block of ${BLOCK} ports per checkout, above the ephemeral range); it is ${JSON.stringify(value)}`;
}

export function project(value) {
  if (typeof value === 'string' && /^demo-[a-z0-9-]+$/.test(value)) return true;
  return `must be a demo- project id, so the emulators never reach a real project's services; it is ${JSON.stringify(value)}`;
}

export function extras(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must map a name to an offset in the block';
  const taken = new Map();
  for (const [name, offset] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) return `has a name ${JSON.stringify(name)}; names are camelCase words`;
    if (name in LAYOUT) return `names ${name}, which the layout already places at +${LAYOUT[name]}`;
    if (!Number.isInteger(offset) || offset < EXTRAS || offset >= BLOCK) {
      return `puts ${name} at ${JSON.stringify(offset)}; an extra takes an offset from ${EXTRAS} to ${BLOCK - 1}, inside the app's own block`;
    }
    if (taken.has(offset)) return `puts ${name} and ${taken.get(offset)} both at +${offset}`;
    taken.set(offset, name);
  }
  return true;
}

export function command(value) {
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' && part.length > 0)) return true;
  return 'must be a command as a list of words, such as ["node", "scripts/with-media-store.mjs"]';
}

/** The section's keys against each other and against the other checkouts' blocks. */
export function claim({ base: start, project: owner }) {
  const holder = CLAIMED[start];
  if (holder !== undefined && holder !== owner) return `emulators.base ${start} is the block of ${holder}, not of ${owner} (lib/ports.mjs CLAIMED)`;
  const own = Object.keys(CLAIMED).find((key) => CLAIMED[key] === owner);
  if (own !== undefined && Number(own) !== start) return `emulators.project ${owner} owns the block at ${own}, not ${start} (lib/ports.mjs CLAIMED)`;
  return null;
}

/** Every port of the app, by name: the layout from its base, then its extras. */
export function ports(settings) {
  const { base: start, extras: own = {} } = settings.emulators;
  return Object.fromEntries([...Object.entries(LAYOUT), ...Object.entries(own)].map(([name, offset]) => [name, start + offset]));
}

/**
 * The ports an emulator run binds: the suite's, and the extras the app runs
 * around it (LMS's media store). Never a dev server's, and never outside the
 * block.
 */
export function suitePorts(settings) {
  const { base: start, extras: own = {} } = settings.emulators;
  return [...Object.values(LAYOUT).filter((offset) => offset < DEV_SERVERS), ...Object.values(own)]
    .map((offset) => start + offset).sort((a, b) => a - b);
}
