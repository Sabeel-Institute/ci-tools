#!/usr/bin/env node
/**
 * sabeel-ci <command> [args…]
 *
 * Runs one of this package's scripts for the app repository it is called from:
 * scripts/<command>.mjs under node, scripts/<command>.sh under bash. The working
 * directory is the app repository's root (the nearest directory above holding
 * ci-tools.json), and CI_TOOLS names this package, so a script reads the app's
 * files by relative path and reaches its siblings through CI_TOOLS.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot } from '../lib/config.mjs';

const tools = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(tools, 'scripts');

function commands() {
  return readdirSync(scripts).filter((name) => /\.(mjs|sh)$/.test(name)).map((name) => name.replace(/\.(mjs|sh)$/, '')).sort();
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') {
  console.log(`usage: sabeel-ci <command> [args…]\n\ncommands:\n${commands().map((name) => '  ' + name).join('\n')}`);
  process.exit(command ? 0 : 2);
}
const mjs = join(scripts, `${command}.mjs`);
const sh = join(scripts, `${command}.sh`);
if (!/^[a-z0-9-]+$/.test(command) || !(existsSync(mjs) || existsSync(sh))) {
  console.error(`sabeel-ci: no command "${command}"; the commands are: ${commands().join(', ')}`);
  process.exit(2);
}

let root;
try {
  root = findRoot(process.cwd());
} catch (error) {
  console.error(`sabeel-ci: ${error.message}`);
  process.exit(2);
}
const [program, file] = existsSync(mjs) ? [process.execPath, mjs] : ['bash', sh];
const child = spawn(program, [file, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, CI_TOOLS: tools } });
// A signal sent to this process alone reaches the command as well, so a
// long-running one (`emulators`) never outlives it.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const forward = (signal) => child.kill(signal);
for (const signal of SIGNALS) process.on(signal, forward);
child.on('error', (error) => {
  throw error;
});
child.on('exit', (status, signal) => {
  for (const name of SIGNALS) process.off(name, forward);
  if (signal) process.kill(process.pid, signal);
  else process.exit(status ?? 1);
});
