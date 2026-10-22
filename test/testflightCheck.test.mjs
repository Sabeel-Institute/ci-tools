import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Stop, appStore, appStoreToken, checkBuild, checkRelease, highestBuild, parseArguments, taggedCommit, testflightCheck,
} from '../scripts/testflight-check.mjs';

const script = fileURLToPath(new URL('../scripts/testflight-check.mjs', import.meta.url));
const fixtures = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const stop = (code, message) => expect.objectContaining({ code, message: expect.stringMatching(message) });

/**
 * A clone whose origin is a local bare repository holding two commits; the
 * first is tagged v1.2.3 (annotated) and v1.2.2 (lightweight). Nothing leaves
 * this machine.
 */
function release() {
  const root = mkdtempSync(join(tmpdir(), 'ci-tools-testflight-'));
  fixtures.push(root);
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  git(root, 'init', '--quiet', '--bare', origin);
  git(root, 'clone', '--quiet', origin, clone);
  git(clone, 'commit', '--quiet', '--allow-empty', '-m', 'release');
  const tagged = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3');
  git(clone, 'tag', 'v1.2.2');
  git(clone, 'commit', '--quiet', '--allow-empty', '-m', 'after');
  const after = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'push', '--quiet', 'origin', 'HEAD', '--tags');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = join(root, 'AuthKey_TEST.p8');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const env = { PATH: process.env.PATH, ASC_KEY_ID: 'TEST', ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000', ASC_KEY_PATH: key };
  return { clone, tagged, after, env };
}

/** App Store Connect as `fetch` sees it: one app, and the builds it holds for 1.2.3. */
function appStoreConnect(builds) {
  return vi.fn(async (url) => {
    const path = new URL(url).pathname;
    const data = path === '/v1/apps'
      ? [{ id: '42', attributes: { bundleId: 'com.sabeelinstitute.example' } }]
      : builds.map((version) => ({ attributes: { version: String(version) } }));
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
}

describe('testflight-check', () => {
  it('reads the commit a tag names, the peeled one for an annotated tag', () => {
    const listing = 'aaa\trefs/tags/v1.2.3\nbbb\trefs/tags/v1.2.3^{}\n';
    expect(taggedCommit(listing, '1.2.3')).toBe('bbb');
    expect(taggedCommit('ccc\trefs/tags/v1.2.3\n', '1.2.3')).toBe('ccc');
    expect(taggedCommit('ccc\trefs/tags/v1.2.30\n', '1.2.3')).toBeUndefined();
    expect(taggedCommit('', '1.2.3')).toBeUndefined();
  });

  it('lets only the released commit go up', () => {
    const sha = 'abcdef0'.padEnd(40, '1');
    expect(() => checkRelease(sha, '1.2.3', sha)).not.toThrow();
    expect(() => checkRelease(sha, '1.2.3', sha.slice(0, 7))).not.toThrow();
    expect(() => checkRelease(undefined, '1.2.3', sha)).toThrow(stop(1, /Version 1\.2\.3 has not been released: there is no v1\.2\.3 tag/));
    expect(() => checkRelease('f'.repeat(40), '1.2.3', sha)).toThrow(stop(1, /This build is commit abcdef011111, but v1\.2\.3 is ffffffffffff\.\nBuild from the release/));
  });

  it('lets only a build number Apple has not taken go up', () => {
    expect(() => checkBuild(0, '1.2.3', '1')).not.toThrow();
    expect(() => checkBuild(3, '1.2.3', '4')).not.toThrow();
    expect(() => checkBuild(4, '1.2.3', '4')).toThrow(stop(1, /already has build 4 on App Store Connect, so build 4 cannot go up/));
    expect(() => checkBuild(5, '1.2.3', '4')).toThrow(stop(1, /the next one is a new version/));
  });

  it('refuses arguments it cannot ask about', () => {
    expect(parseArguments(['com.example.app', '1.2.3', '4', 'abcdef0'])).toEqual({ bundleId: 'com.example.app', version: '1.2.3', build: '4', commit: 'abcdef0' });
    for (const args of [
      ['com.example.app', '1.2.3', '4'],
      ['com.example.app', '1.2', '4', 'abcdef0'],
      ['com.example.app', '1.2.3', '0', 'abcdef0'],
      ['com.example.app', '1.2.3', '4', 'main'],
      ['com example', '1.2.3', '4', 'abcdef0'],
      ['com.example.app', '1.2.3', '4', 'abcdef0', 'extra'],
    ]) expect(() => parseArguments(args), args.join(' ')).toThrow(stop(2, /^usage:/));
  });

  it('signs a token App Store Connect accepts: ES256 in raw r||s form, ten minutes long', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const token = appStoreToken({ keyId: 'KEY', issuer: 'ISSUER', key: privateKey }, 1000);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url'))).toEqual({ alg: 'ES256', kid: 'KEY', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url'))).toEqual({ iss: 'ISSUER', iat: 1000, exp: 1600, aud: 'appstoreconnect-v1' });
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('retries App Store Connect\'s bad hours, and nothing else', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    const answers = [
      () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); },
      () => ({ ok: false, status: 503, text: async () => 'unavailable' }),
      () => ({ ok: true, status: 200, json: async () => ({ data: 'yes' }) }),
    ];
    const fetch = vi.fn(async () => answers.shift()());
    expect(await appStore('token', { fetch, sleep })('/v1/apps')).toEqual({ data: 'yes' });
    expect(sleep.mock.calls).toEqual([[15_000], [30_000]]);
    expect(fetch.mock.calls[0][1].headers).toEqual({ authorization: 'Bearer token' });

    const refused = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'NOT_AUTHORIZED' }));
    await expect(appStore('token', { fetch: refused, sleep })('/v1/apps')).rejects.toEqual(stop(2, /answered 401: NOT_AUTHORIZED/));
    expect(refused).toHaveBeenCalledTimes(1);

    const down = vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }));
    await expect(appStore('token', { fetch: down, sleep })('/v1/apps')).rejects.toEqual(stop(2, /four times/));
    expect(down).toHaveBeenCalledTimes(4);
  });

  it('finds the highest build of the version, for the app with exactly this bundle id', async () => {
    const get = vi.fn(async (path) => (path.startsWith('/v1/apps')
      ? { data: [{ id: '1', attributes: { bundleId: 'com.example.app.extension' } }, { id: '2', attributes: { bundleId: 'com.example.app' } }] }
      : { data: [{ attributes: { version: '3' } }, { attributes: { version: '11' } }, { attributes: { version: 'x' } }] }));
    expect(await highestBuild(get, 'com.example.app', '1.2.3')).toBe(11);
    expect(get.mock.calls[1][0]).toBe('/v1/builds?filter[app]=2&filter[preReleaseVersion.version]=1.2.3&fields[builds]=version&limit=200');
    await expect(highestBuild(async () => ({ data: [] }), 'com.example.app', '1.2.3')).rejects.toEqual(stop(2, /no app with bundle id/));
  });

  it('answers yes only for the tagged commit with a free build number', async () => {
    const { clone, tagged, after, env } = release();
    const ask = (version, build, commit, builds = [1, 2]) => testflightCheck(['com.sabeelinstitute.example', version, build, commit],
      { env, cwd: clone, fetch: appStoreConnect(builds), sleep: async () => {} });
    await expect(ask('1.2.3', '3', tagged)).resolves.toBe(`v1.2.3 is ${tagged.slice(0, 12)}, and build 3 is free (highest so far: 2).`);
    await expect(ask('1.2.2', '1', tagged.slice(0, 7), [])).resolves.toMatch(/build 1 is free \(highest so far: none\)/);
    await expect(ask('1.2.3', '3', after)).rejects.toEqual(stop(1, /but v1\.2\.3 is/));
    await expect(ask('1.2.4', '1', after)).rejects.toEqual(stop(1, /no v1\.2\.4 tag/));
    await expect(ask('1.2.3', '2', tagged)).rejects.toEqual(stop(1, /cannot go up/));
    await expect(testflightCheck(['com.sabeelinstitute.example', '1.2.3', '3', tagged], { env: { ...env, ASC_ISSUER_ID: '' }, cwd: clone }))
      .rejects.toEqual(stop(2, /ASC_KEY_ID and ASC_ISSUER_ID must be set/));
    await expect(testflightCheck(['com.sabeelinstitute.example', '1.2.3', '3', tagged], { env: { ...env, ASC_KEY_PATH: join(clone, 'none.p8') }, cwd: clone }))
      .rejects.toEqual(stop(2, /cannot read the App Store Connect key/));
  });

  it('runs as a command, exiting 1 for a refusal and 2 for a question it could not ask', () => {
    const { clone, after, env } = release();
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: clone, encoding: 'utf8', env });
    let result = run('com.sabeelinstitute.example', '1.2.3', '3', after);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^This build is commit .*\nBuild from the release: run the iOS workflow on the tag v1\.2\.3\.\n$/);
    result = run('com.sabeelinstitute.example', '1.2.3');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^usage: sabeel-ci testflight-check/);
    result = spawnSync(process.execPath, [script, 'com.sabeelinstitute.example', '1.2.3', '3', after], { cwd: tmpdir(), encoding: 'utf8', env });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/could not ask GitHub for the release tags/);
  });
});
