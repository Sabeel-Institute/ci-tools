import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import full from './fixtures/full.json' with { type: 'json' };

const script = resolve(import.meta.dirname, '../scripts/publish-play.mjs');
const commit = 'c'.repeat(40);
const head = commit.slice(0, 7);
const signingKey = full.release.appSigningCertificate;
const bundle = Buffer.from('signed bundle fixture');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * An app with a release bundle that passes every gate, stand-ins for git,
 * jarsigner and unzip, and a Play that answers as `play` says and records
 * every request. Nothing leaves the machine.
 */
function fixture(play = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'publish-play-'));
  fixtures.push(directory);
  const put = (path, value, mode = 0o600) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), value, { mode });
  };
  const tool = (name, body) => put('bin/' + name, '#!/usr/bin/env node\n' + body, 0o700);
  put('ci-tools.json', JSON.stringify(full));
  put('app/app.json', JSON.stringify({ expo: { version: '0.2.0', android: { package: 'com.test.app' } } }));
  put('app/android/app/build.gradle', '        versionCode computedVersionCode\n        versionName expoVersion\n');
  put('app/android/app/build/outputs/bundle/release/app-release.aab', bundle);
  put('publisher.json', JSON.stringify({ type: 'service_account', client_email: 'publisher@example.test', private_key: privateKey }));
  tool('git', `process.stdout.write(${JSON.stringify(head)});`);
  tool('jarsigner', 'if (process.env.UNSIGNED) process.exit(1); process.stdout.write(`- Signed by "${process.env.FAKE_SIGNER || "CN=Sabeel Institute"}"\\n`);');
  tool('unzip', `process.stdout.write(process.argv.at(-1).endsWith('AndroidManifest.xml')
    ? (process.env.FAKE_MANIFEST ?? '\\u0012\\u00050.2.0\\u001a\\u000ccom.test.app')
    : (process.env.FAKE_JS ?? 'label ${commit} label'));`);
  put('play.json', JSON.stringify(play));
  put('play.mjs', `
    import { readFileSync, writeFileSync } from 'node:fs';
    const play = JSON.parse(readFileSync('play.json', 'utf8'));
    const calls = [];
    let status;
    globalThis.fetch = async (url, options = {}) => {
      const path = url.replace('https://androidpublisher.googleapis.com', '').replace('/androidpublisher/v3/applications/com.test.app', '');
      const body = typeof options.body === 'string' && path !== 'https://oauth2.googleapis.com/token' ? JSON.parse(options.body) : undefined;
      calls.push({ method: options.method, path, body });
      writeFileSync('play-calls.json', JSON.stringify(calls));
      if (path === 'https://oauth2.googleapis.com/token') return play.token === false ? new Response('{}', { status: 401 }) : Response.json({ access_token: 'unit-token' });
      if (path === '/edits' && options.method === 'POST') return play.refuse ? new Response('{"error":"denied"}', { status: 403 }) : Response.json({ id: 'e1' });
      if (path === '/edits/e1' && options.method === 'DELETE') return new Response(null, { status: 204 });
      if (path === '/edits/e1/bundles' && options.method === 'GET') return Response.json({ bundles: play.bundles ?? [] });
      if (path === '/upload/edits/e1/bundles?uploadType=media') return Response.json({ versionCode: play.uploaded ?? 2000 });
      if (path === '/edits/e1/tracks/internal' && options.method === 'PUT') { status = body.releases[0].status; return Response.json(body); }
      if (path === '/edits/e1:commit') {
        return play.draftApp && status === 'completed'
          ? new Response('{"error":{"message":"Only releases with status draft may be created on draft app."}}', { status: 400 })
          : Response.json({ id: 'e1' });
      }
      if (path === '/generatedApks/2000') return Response.json({ generatedApks: (play.signers ?? [${JSON.stringify(signingKey)}]).map((certificateSha256Hash) => ({ certificateSha256Hash })) });
      throw new Error('unexpected request ' + options.method + ' ' + path);
    };`);
  const run = (args, env = {}) => spawnSync(process.execPath, ['--import', join(directory, 'play.mjs'), script, ...args], {
    cwd: directory, encoding: 'utf8', env: {
      ...process.env, PATH: join(directory, 'bin') + ':' + process.env.PATH, PLAY_KEY: join(directory, 'publisher.json'), GITHUB_ACTIONS: '', ...env,
    },
  });
  const calls = () => (existsSync(join(directory, 'play-calls.json')) ? JSON.parse(readFileSync(join(directory, 'play-calls.json'), 'utf8')) : []);
  const requests = () => calls().map((call) => `${call.method} ${call.path.startsWith('https://') ? 'token' : call.path}${call.body?.releases ? ' ' + call.body.releases[0].status : ''}`);
  return { directory, put, run, calls, requests };
}

const ACCESS = ['POST token', 'POST /edits', 'DELETE /edits/e1'];

describe('publish-play', () => {
  it('publishes only to a destination it is given by name', () => {
    const test = fixture();
    for (const args of [[], ['--dry-run'], ['--internal', '--check'], ['internal']]) {
      const result = test.run(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('usage: sabeel-ci publish-play --check | --internal');
    }
    expect(test.run(['--help']).status).toBe(0);
    expect(test.calls()).toEqual([]);
  });

  it('--check passes every gate and proves the permission, uploading nothing', () => {
    const test = fixture();
    const result = test.run(['--check']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('version   0.2.0 (2000)');
    expect(result.stdout).toContain('every gate passes, and publisher@example.test may release this app');
    expect(test.requests()).toEqual(ACCESS);
  });

  it('--check still proves the permission without a bundle, and fails', () => {
    const test = fixture();
    rmSync(join(test.directory, 'app/android/app/build/outputs/bundle/release/app-release.aab'));
    const result = test.run(['--check']);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/A real run would refuse this bundle:\n {2}- No bundle at .*npx sabeel-ci build-aab/);
    expect(result.stdout).toContain('may release this app, but a real run would refuse the bundle');
    expect(test.requests()).toEqual(ACCESS);
  });

  it.each([
    ['an unsigned bundle', { UNSIGNED: '1' }, /is not signed/],
    ['the debug key', { FAKE_SIGNER: 'CN=Android Debug, O=Android, C=US' }, /signed with the DEBUG key/],
    ["another commit's JavaScript", { FAKE_JS: 'label 1234567 label' }, /does not carry HEAD \(ccccccc\)/],
    ['uncommitted changes', { FAKE_JS: `label ${head}+ label` }, /built from uncommitted changes \(ccccccc\+\)/],
    ['another version', { FAKE_MANIFEST: '\u0012\u00050.2.10' }, /not version 0\.2\.0 \(app\.json's\): it names 0\.2\.10/],
  ])('refuses %s before anything leaves the machine', (_, env, message) => {
    const test = fixture();
    const result = test.run(['--internal'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain('Not publishing this bundle');
    expect(test.calls()).toEqual([]);
  });

  it('refuses a build.gradle or app.json that states its own version', () => {
    const test = fixture();
    test.put('app/android/app/build.gradle', '        versionCode 38\n        versionName "0.2.0"\n');
    expect(test.run(['--internal']).stderr).toMatch(/must derive the version from app\.json/);
    test.put('app/android/app/build.gradle', '        versionCode computedVersionCode\n        versionName expoVersion\n');
    test.put('app/app.json', JSON.stringify({ expo: { version: '0.2.0', android: { package: 'com.test.app', versionCode: 38 } } }));
    expect(test.run(['--internal']).stderr).toMatch(/states android\.versionCode 38; remove it/);
    expect(test.calls()).toEqual([]);
  });

  it('publishes a draft, waits for Play to sign with the app signing key, then completes it', () => {
    const test = fixture({ signers: [signingKey.toLowerCase().replaceAll(':', '')] });
    const result = test.run(['--internal']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(test.requests()).toEqual([
      ...ACCESS,
      'POST /edits', 'GET /edits/e1/bundles', 'POST /upload/edits/e1/bundles?uploadType=media',
      'PUT /edits/e1/tracks/internal draft', 'POST /edits/e1:commit',
      'GET /generatedApks/2000',
      'POST /edits', 'PUT /edits/e1/tracks/internal completed', 'POST /edits/e1:commit',
    ]);
    expect(test.calls().filter((call) => call.body?.releases).map((call) => call.body))
      .toEqual(['draft', 'completed'].map((status) => ({ track: 'internal', releases: [{ versionCodes: ['2000'], status }] })));
    expect(result.stdout).toContain('0.2.0 (2000) is on the internal testing track');
  });

  it.each([
    ['identical', null],
    ['different', /Play already holds a different bundle as versionCode 2000/],
  ])('resumes only an identical stored Play bundle: %s', (kind, refusal) => {
    const sha256 = kind === 'identical' ? createHash('sha256').update(bundle).digest('hex') : 'ff'.repeat(32);
    const test = fixture({ bundles: [{ versionCode: 2000, sha256 }] });
    const result = test.run(['--internal']);
    expect(test.requests().some((request) => request.includes('/upload/'))).toBe(false);
    if (refusal) {
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(refusal);
      expect(result.stderr).toContain('Nothing reached the testers.');
      expect(test.requests().slice(ACCESS.length)).toEqual(['POST /edits', 'GET /edits/e1/bundles', 'DELETE /edits/e1']);
    } else {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Play already holds this bundle as 0.2.0 (2000); not uploading it again.');
      expect(test.requests()).toContain('PUT /edits/e1/tracks/internal completed');
    }
  });

  it('refuses a versionCode Play reads differently, discarding the edit', () => {
    const test = fixture({ uploaded: 38 });
    const result = test.run(['--internal']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Play read versionCode 38 from the bundle; app.json's version 0.2.0 gives 2000.");
    expect(test.requests().slice(-2)).toEqual(['POST /upload/edits/e1/bundles?uploadType=media', 'DELETE /edits/e1']);
    expect(test.requests().some((request) => request.endsWith(':commit'))).toBe(false);
  });

  it('keeps the draft from testers when Play signs with another key', () => {
    const google = 'EF:'.repeat(31) + 'EF';
    const test = fixture({ signers: [google] });
    const result = test.run(['--internal']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Play signs this build with ${google},\nnot with the app signing key ci-tools.json names (release.appSigningCertificate), ${signingKey}.`);
    expect(result.stderr).toContain('Nothing reached the testers.');
    expect(test.requests().at(-1)).toBe('GET /generatedApks/2000');
    expect(test.requests()).not.toContain('PUT /edits/e1/tracks/internal completed');
  });

  it("says so when Play keeps an app's first release a draft", () => {
    const test = fixture({ draftApp: true });
    const result = test.run(['--internal']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0.2.0 (2000) is a draft on the internal testing track');
  });

  it('names what is wrong with the credential or its permission', () => {
    const test = fixture({ refuse: true });
    let result = test.run(['--internal']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Play refused publisher@example.test for com.test.app');
    expect(result.stderr).toContain('"Release apps to testing tracks"');
    expect(test.requests()).toEqual(['POST token', 'POST /edits']);
    result = test.run(['--check'], { PLAY_KEY: join(test.directory, 'absent.json') });
    expect(result.stderr).toContain(`No Play publishing key at ${join(test.directory, 'absent.json')}`);
    test.put('other.json', JSON.stringify({ type: 'authorized_user', client_email: 'x', private_key: 'y' }));
    result = test.run(['--check'], { PLAY_KEY: join(test.directory, 'other.json') });
    expect(result.stderr).toContain("is not a service account's JSON key");
    expect(result.stderr).not.toContain('authorized_user');
    test.put('play.json', JSON.stringify({ token: false }));
    result = test.run(['--check']);
    expect(result.stderr).toContain('Google issued no token for publisher@example.test (HTTP 401)');
  });

  it('masks the access token in GitHub Actions logs', () => {
    const test = fixture();
    expect(test.run(['--check'], { GITHUB_ACTIONS: 'true' }).stdout).toContain('::add-mask::unit-token');
    expect(test.run(['--check']).stdout).not.toContain('unit-token');
  });
});
