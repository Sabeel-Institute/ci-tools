#!/usr/bin/env node
/**
 * sabeel-ci sync-functions-lock
 *
 * Bring functions/package-lock.json in step with functions/package.json.
 * Cloud Build installs functions/ alone, from that lock, while the workspace
 * (and Dependabot) keep only the root lock, so every change to the functions
 * manifest leaves it behind. The lock is updated in place rather than made
 * afresh: npm keeps every locked version that still satisfies its range, so
 * only what the manifest moved, and what that needs, changes. Each direct
 * dependency then has to be the version the root lock holds, which is what
 * every suite ran against; one that resolved otherwise is pinned to it, and
 * the manifest's own ranges go back into the lock's root entry, where npm ci
 * compares them with package.json.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The direct dependencies whose version in the functions lock is not the workspace's. */
export function lockDrift(rootLock, functionsLock, manifest) {
  return ['dependencies', 'devDependencies'].flatMap((section) => Object.keys(manifest[section] ?? {}).flatMap((name) => {
    const workspace = (rootLock.packages['functions/node_modules/' + name] ?? rootLock.packages['node_modules/' + name])?.version;
    if (!workspace) throw new Error(`${name} is not in the root package-lock.json: run npm install at the root first`);
    const functions = functionsLock.packages['node_modules/' + name]?.version;
    return functions === workspace ? [] : [{ name, section, functions, workspace }];
  }));
}

function sync() {
  const manifest = json('functions/package.json');
  const rootLock = json('package-lock.json');
  const directory = mkdtempSync(join(tmpdir(), 'functions-lock-'));
  const npm = (...args) => execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', ...args],
    { cwd: directory, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join('functions', file), join(directory, file));
    npm();
    let lock = json(join(directory, 'package-lock.json'));
    const drift = lockDrift(rootLock, lock, manifest);
    for (const section of ['dependencies', 'devDependencies']) {
      const pins = drift.filter((entry) => entry.section === section).map((entry) => entry.name + '@' + entry.workspace);
      if (pins.length) npm(section === 'dependencies' ? '--save-prod' : '--save-dev', '--save-exact', ...pins);
    }
    lock = json(join(directory, 'package-lock.json'));
    lock.packages[''] = { ...lock.packages[''], dependencies: manifest.dependencies, devDependencies: manifest.devDependencies };
    const left = lockDrift(rootLock, lock, manifest);
    if (left.length) {
      throw new Error('The functions lock still differs from the workspace: '
        + left.map((entry) => `${entry.name} ${entry.functions} here, ${entry.workspace} in the root lock`).join('; '));
    }
    writeFileSync('functions/package-lock.json', JSON.stringify(lock, null, 2) + '\n');
    console.log('functions/package-lock.json is in step with functions/package.json'
      + (drift.length ? '; pinned to the workspace: ' + drift.map((entry) => entry.name + '@' + entry.workspace).join(', ') : ''));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) sync();
