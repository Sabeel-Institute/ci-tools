import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWebPush, isP256Point } from '../scripts/check-web-push.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import { vapidKey, webExport } from './fixtures/push.mjs';

const bin = fileURLToPath(new URL('../bin/sabeel-ci.mjs', import.meta.url));
const SDK_DEFAULT = 'BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4';
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function site(bundles, extra) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-tools-web-'));
  directories.push(directory);
  webExport(directory, bundles, extra);
  return directory;
}

/** An entry bundle as the minifier leaves it, with the SDK's sample key always in it. */
const bundle = (key, enablePush = 'enablePush=async function(e){if(!t())return"unavailable";await n(e)}') =>
  `var s="${SDK_DEFAULT}";var v=${key ? `"${key}"` : '""'};${enablePush};`;

describe('check-web-push', () => {
  it('passes an export whose entry bundle carries a VAPID public key and the permission path', () => {
    expect(checkWebPush(site({ 'index-a1.js': bundle(vapidKey()) }))).toMatch(/^check-web-push: ok/);
  });

  it('fails an export with no key but the SDK sample, or with the permission path folded away', () => {
    expect(() => checkWebPush(site({ 'index-a1.js': bundle('') }))).toThrow(/no VAPID key in the exported bundle[\s\S]*VAPID_PUBLIC_KEY in app\/src\/firebase-config\.ts/);
    expect(() => checkWebPush(site({ 'index-a1.js': bundle(vapidKey(), 'enablePush=async function(e){return"unavailable"}') })))
      .toThrow(/enablePush was folded/);
  });

  it('fails a key-shaped string that is not a point on P-256', () => {
    const key = vapidKey();
    const offCurve = key.slice(0, 50) + (key[50] === 'A' ? 'B' : 'A') + key.slice(51);
    expect(isP256Point(key)).toBe(true);
    expect(isP256Point(offCurve)).toBe(false);
    expect(isP256Point('BQ' + key.slice(2))).toBe(false);
    expect(isP256Point(key.slice(0, 86))).toBe(false);
    expect(() => checkWebPush(site({ 'index-a1.js': bundle(offCurve) }))).toThrow(/not a P-256 public key/);
  });

  it('reads the bundles index.html loads, not a keyed one left beside them', () => {
    // An export can hold more than one index-*.js; only the one the page loads ships.
    const stale = { 'index-old.js': bundle(vapidKey()) };
    expect(() => checkWebPush(site({ 'index-new.js': bundle('') }, stale))).toThrow(/no VAPID key/);
    expect(checkWebPush(site({ 'index-new.js': bundle(vapidKey()) }, { 'index-chunk.js': 'var x=1;' }))).toMatch(/ok/);
  });

  it('says what is missing when there is no export to read', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ci-tools-web-'));
    directories.push(empty);
    expect(() => checkWebPush(empty)).toThrow(/no export at .*\n {2}build it first: npm run web:export -w @sabeel\/app/);
    writeFileSync(join(empty, 'index.html'), '<script src="/_expo/static/js/web/index-gone.js" defer></script>');
    expect(() => checkWebPush(empty)).toThrow(/loads _expo\/static\/js\/web\/index-gone\.js, which is not in the export/);
    writeFileSync(join(empty, 'index.html'), '<html></html>');
    expect(() => checkWebPush(empty)).toThrow(/loads no script/);
  });

  it('runs as sabeel-ci check-web-push on the app\'s app/dist-web', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-tools-web-app-'));
    directories.push(root);
    writeFileSync(join(root, 'ci-tools.json'), JSON.stringify(full));
    webExport(join(root, 'app/dist-web'), { 'index-a1.js': bundle('') });
    const result = spawnSync(process.execPath, [bin, 'check-web-push'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^check-web-push: no VAPID key/);
  });
});
