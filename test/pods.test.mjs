import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pods = fileURLToPath(new URL('../scripts/pods.sh', import.meta.url));
const fixtures = [];
afterAll(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

const LOCK = `PODS:
  - Example (1.0.0)
  - ExpoFont (57.0.1)
  - GoogleUtilities (8.1.0)

DEPENDENCIES:
  - Example

SPEC REPOS:
  trunk:
    - GoogleUtilities

EXTERNAL SOURCES:
  Example:
    :path: "../node_modules/example/ios"
  "ExpoFont":
    :path: "../../node_modules/expo-font/ios"

SPEC CHECKSUMS:
  Example: 0123

COCOAPODS: 1.16.2
`;
const MOVED = LOCK.replace('ExpoFont (57.0.1)', 'ExpoFont (57.0.4)');

/**
 * An app on "a Mac": prebuild makes app/ios, and pod records what it was asked.
 * pod install writes STUB_PODS as the lock when set, or fails when
 * STUB_REFUSE is set, as CocoaPods does once a local pod's version moved; pod
 * update writes STUB_PODS.
 */
function mac() {
  const root = mkdtempSync(join(tmpdir(), 'pods-'));
  fixtures.push(root);
  mkdirSync(join(root, 'app'));
  mkdirSync(join(root, 'stubs'));
  writeFileSync(join(root, 'app/Podfile.lock'), LOCK);
  const stub = (name, body) => writeFileSync(join(root, 'stubs', name), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(join(root, 'tools.log'))}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
${body}\n`, { mode: 0o755 });
  stub('uname', "console.log('Darwin');");
  stub('npx', "require('node:fs').mkdirSync('ios', { recursive: true });");
  stub('pod', `const [task] = process.argv.slice(2);
if (task === 'install' && process.env.STUB_REFUSE) process.exit(1);
if (process.env.STUB_PODS) require('node:fs').writeFileSync('Podfile.lock', process.env.STUB_PODS);`);
  const run = (env = {}, ...args) => spawnSync('bash', [pods, ...args], {
    cwd: root, encoding: 'utf8',
    env: { PATH: `${join(root, 'stubs')}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
  });
  const tools = () => (existsSync(join(root, 'tools.log')) ? readFileSync(join(root, 'tools.log'), 'utf8').trimEnd().split('\n') : []);
  return { root, run, tools, lock: () => readFileSync(join(root, 'app/Podfile.lock'), 'utf8') };
}

describe('pods', () => {
  it('installs the pods the lock pins into a regenerated app/ios', () => {
    const { run, tools, lock } = mac();
    const result = run({}, '--check');
    expect(result.status, result.stderr).toBe(0);
    expect(tools()).toEqual(['uname -s', 'npx --no-install expo prebuild --platform ios --no-install', 'pod install --repo-update']);
    expect(lock()).toBe(LOCK);
  });

  it('updates only the pods built from node_modules when pod install refuses the lock', () => {
    const { run, tools } = mac();
    const result = run({ STUB_REFUSE: '1', STUB_PODS: LOCK }, '--check');
    expect(result.status, result.stderr).toBe(0);
    expect(tools().at(-1)).toBe('pod update --no-repo-update Example ExpoFont');
    expect(result.stderr).toContain('updating the 2 pods built from node_modules');
  });

  it('stops --check when the pods installed are not the ones the lock pins', () => {
    const { run, lock } = mac();
    const result = run({ STUB_PODS: MOVED }, '--check');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pod install resolved other pods than app\/Podfile\.lock pins/);
    expect(result.stderr).toContain('npx sabeel-ci pods --write');
    expect(lock()).toBe(LOCK);
  });

  it('writes the pods installed to app/Podfile.lock with --write', () => {
    const { run, lock } = mac();
    const result = run({ STUB_REFUSE: '1', STUB_PODS: MOVED }, '--write');
    expect(result.status, result.stderr).toBe(0);
    expect(lock()).toBe(MOVED);
  });

  it('leaves the lock alone and passes without an option, for a debug build', () => {
    const { run, lock } = mac();
    expect(run({ STUB_PODS: MOVED }).status).toBe(0);
    expect(lock()).toBe(LOCK);
  });

  it('refuses a lock with no pods, which would compare equal to anything', () => {
    const { root, run } = mac();
    writeFileSync(join(root, 'app/Podfile.lock'), 'COCOAPODS: 1.16.2\n');
    const result = run({}, '--check');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('app/Podfile.lock has no PODS: section');
  });

  it('refuses an option it does not have', () => {
    const { run, tools } = mac();
    const result = run({}, '--update');
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('pods: unknown option --update (sabeel-ci pods [--check|--write])\n');
    expect(tools()).toEqual([]);
  });
});
