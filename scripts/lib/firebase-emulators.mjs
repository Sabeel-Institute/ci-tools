import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { delimiter, join } from 'node:path';
import { STARTABLE } from '../../lib/ports.mjs';

/** What `emulators` and `test-emulator` share: the app's emulators, Java, and runs. */

/** This package, which sabeel-ci names in CI_TOOLS. */
export function tools() {
  const root = process.env.CI_TOOLS;
  if (!root) throw new Error('CI_TOOLS is not set: run this through sabeel-ci');
  return root;
}

/** The emulators firebase.json runs that `--only` names, in the layout's order. */
export function startable(root = '.') {
  let emulators;
  try {
    emulators = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8')).emulators;
  } catch (error) {
    throw new Error(`firebase.json: cannot read it: ${error.message}`);
  }
  const names = STARTABLE.filter((name) => emulators?.[name] && typeof emulators[name] === 'object');
  if (!names.includes('functions')) throw new Error('firebase.json runs no Functions emulator; these runs build and load the functions');
  return names;
}

/**
 * Seconds a new Functions worker has to answer its health check before the
 * emulator fails the request with "Failed to load function": firebase-tools
 * reads FUNCTIONS_DISCOVERY_TIMEOUT and waits 30 s without it. On a macOS
 * runner busy with the simulator and Metro a cold worker took longer (LMS
 * pull request #28, getPlaybackUrl; sendMyPasswordLink before it).
 */
export const FUNCTIONS_DISCOVERY_TIMEOUT = '120';

/**
 * The environment with JAVA_HOME at a JDK 21 or later (scripts/jdk21.sh),
 * firebase on the PATH, and FUNCTIONS_DISCOVERY_TIMEOUT unless the caller set
 * it.
 */
export function emulatorEnv() {
  let home;
  try {
    home = execFileSync('bash', [join(tools(), 'scripts', 'jdk21.sh')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  } catch {
    throw new Error('the emulators cannot start without a JDK 21 (above)');
  }
  const env = {
    ...process.env, JAVA_HOME: home, PATH: `${join(home, 'bin')}${delimiter}${process.env.PATH}`,
    FUNCTIONS_DISCOVERY_TIMEOUT: process.env.FUNCTIONS_DISCOVERY_TIMEOUT || FUNCTIONS_DISCOVERY_TIMEOUT,
  };
  if (spawnSync('sh', ['-c', 'command -v firebase'], { env, stdio: 'ignore' }).status !== 0) {
    throw new Error('firebase is not on the PATH: npm install --global firebase-tools@15');
  }
  return env;
}

/** Where the Functions emulator reads the values of the secrets the functions bind. */
export const SECRET_LOCAL = 'functions/.secret.local';

/**
 * functions/.secret.local from ci-tools.json's ci.emulatorSecrets: a
 * placeholder for each secret the functions bind, so the emulator never asks
 * Secret Manager for one. Written on every run, so the app keeps no copy and
 * a secret added to ci-tools.json reaches every checkout.
 */
export function writeEmulatorSecrets(settings) {
  const lines = Object.entries(settings.ci.emulatorSecrets).map(([name, value]) => `${name}=${value}\n`);
  try {
    writeFileSync(SECRET_LOCAL, lines.join(''));
  } catch (error) {
    throw new Error(`cannot write ${SECRET_LOCAL}: ${error.message}`);
  }
}

/** sabeel-ci free-emulator-ports; throws when a port stays held. */
export function freePorts() {
  try {
    execFileSync('bash', [join(tools(), 'scripts', 'free-emulator-ports.sh')], { stdio: 'inherit' });
  } catch {
    throw new Error('the emulator ports are not free (above); nothing was started');
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Run a command to its end and resolve its exit status. A signal this process
 * receives meanwhile is passed on, and once the command has stopped this
 * process exits with it rather than going on to the next step: Ctrl-C, or a
 * SIGTERM sent to this pid alone, must stop the whole run and leave no
 * emulator behind. firebase ignores the second copy of a signal that a
 * terminal's Ctrl-C delivers to it directly.
 */
export function run([program, ...args], options = {}) {
  return new Promise((resolve) => {
    let received = null;
    const child = spawn(program, args, { stdio: 'inherit', ...options });
    const forward = (signal) => {
      received = signal;
      child.kill(signal);
    };
    for (const signal of SIGNALS) process.on(signal, forward);
    const done = (code) => {
      for (const signal of SIGNALS) process.off(signal, forward);
      if (received) process.exit(128 + constants.signals[received]);
      resolve(code);
    };
    child.on('error', (error) => {
      console.error(`could not run ${program}: ${error.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
}

/** Run a script's main, reporting a thrown error as one line and exit 1. */
export async function main(body) {
  try {
    await body();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
