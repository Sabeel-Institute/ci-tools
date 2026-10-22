import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_ID, iosApp } from './fixtures/iosApp.mjs';
import minimal from './fixtures/minimal.json' with { type: 'json' };

const bin = fileURLToPath(new URL('../bin/sabeel-ci.mjs', import.meta.url));
const loader = fileURLToPath(new URL('../scripts/lib/load-build-env.sh', import.meta.url));
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * The macOS tools build-ios asks before it builds anything, as small scripts
 * on PATH. `security` answers from STUB_* variables: a locked keychain, an
 * identity, a codesign that fails. npm records what it was asked to run.
 */
const STUBS = {
  uname: 'echo Darwin',
  xcodebuild: 'exit 0',
  pod: 'exit 0',
  codesign: 'exit "${STUB_CODESIGN:-0}"',
  npm: 'echo "$*" >> "$STUB_LOG"; exit "${STUB_NPM:-0}"',
  ruby: 'shift 3; echo "ruby $*" >> "$STUB_LOG"',
  security: `case "$1" in
  default-keychain) echo "    \\"$HOME/login.keychain-db\\"" ;;
  show-keychain-info) [ -z "\${STUB_LOCKED:-}" ] ;;
  find-identity) if [ -n "\${STUB_IDENTITY:-}" ]; then echo "  1) \${STUB_IDENTITY} \\"\${STUB_IDENTITY_NAME:-Apple Development: Example}\\""; fi ;;
  cms) cat "$4" ;;
  *) exit 1 ;;
esac`,
};

/** A certificate's bytes, and the SHA-1 `security find-identity` names it by. */
const CERTIFICATE = Buffer.from('fixture certificate');
const CERTIFICATE_SHA1 = createHash('sha1').update(CERTIFICATE).digest('hex').toUpperCase();

/**
 * plutil, for a provisioning profile kept as JSON (the `security cms` stub
 * prints it as it is): `-extract <key path> raw <file>` prints a value, an
 * array's length, or a certificate as base64, as plutil does.
 */
const PLUTIL = `const value = process.argv[3].split('.').reduce((v, key) => v?.[key], JSON.parse(require('node:fs').readFileSync(process.argv[5], 'utf8')));
if (value === undefined) process.exit(1);
console.log(Array.isArray(value) ? value.length : value);`;

/** An installed App Store profile; `changes` alter it. */
function profile(root, changes = {}) {
  const directory = join(root, 'home/Library/MobileDevice/Provisioning Profiles');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'UUID.mobileprovision'), JSON.stringify({
    Name: 'Example App Store', ExpirationDate: '2099-01-01T00:00:00Z',
    Entitlements: { 'application-identifier': `TEAM123456.${BUNDLE_ID}` },
    DeveloperCertificates: [Buffer.from('another certificate').toString('base64'), CERTIFICATE.toString('base64')],
    ...changes,
  }));
}
const MANUAL = { IOS_PROFILE_NAME: 'Example App Store', STUB_IDENTITY: CERTIFICATE_SHA1, STUB_IDENTITY_NAME: 'Apple Distribution: Example (TEAM123456)' };

/**
 * The build's tools, for running it end to end: prebuild makes an Xcode
 * project, pod install keeps the pinned lock (or, with STUB_PODS, resolves
 * another), and xcodebuild lists the project's schemes, archives an app, and
 * exports an .ipa beside a copy of the export options it was given. Each
 * records its arguments and the commit stamp it saw in tools.log.
 */
const BUILD_STUBS = {
  plutil: PLUTIL,
  npx: `require('node:fs').mkdirSync('ios/Example.xcodeproj', { recursive: true });
require('node:fs').mkdirSync('ios/Example.xcworkspace', { recursive: true });`,
  pod: `if (process.argv[2] === 'install' && process.env.STUB_PODS) require('node:fs').writeFileSync('Podfile.lock', process.env.STUB_PODS);`,
  xcodebuild: `const fs = require('node:fs');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (args.includes('-list')) console.log(JSON.stringify({ project: { name: 'Example', schemes: ['ExampleTests', 'Example'] } }));
else if (args.at(-1) === 'archive') fs.mkdirSync(value('-archivePath') + '/Products/Applications/Example.app', { recursive: true });
else if (args[0] === '-exportArchive') {
  fs.mkdirSync(value('-exportPath'), { recursive: true });
  fs.writeFileSync(value('-exportPath') + '/Example.ipa', '');
  fs.copyFileSync(value('-exportOptionsPlist'), value('-exportPath') + '/options.plist');
}`,
};

/** An app checkout on "a Mac": committed, with every gate's answer stubbed. */
function mac(settings) {
  const { root, put } = iosApp(settings);
  fixtures.push(root);
  put('.gitignore', '.env.local\n.env.sentry-build-plugin\nstubs/\nhome/\nnpm.log\ntools.log\napp/ios/\nbuild/\n');
  put('app/Podfile.lock', 'PODS:\n  - Example (1.0.0)\n\nDEPENDENCIES:\n  - Example\n\nCOCOAPODS: 1.16.2\n');
  mkdirSync(join(root, 'stubs'), { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(root, 'stubs', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  for (const [name, body] of Object.entries(BUILD_STUBS)) {
    writeFileSync(join(root, 'stubs', name), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(join(root, 'tools.log'))},
  ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + ' [' + (process.env.EXPO_PUBLIC_COMMIT ?? '') + ']\\n');
${body}\n`, { mode: 0o755 });
  }
  mkdirSync(join(root, 'home'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'app');
  const env = {
    PATH: `${join(root, 'stubs')}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), STUB_LOG: join(root, 'npm.log'),
    IOS_TEAM_ID: 'TEAM123456', SENTRY_ORG: 'o', SENTRY_PROJECT: 'example-ios', SENTRY_AUTH_TOKEN: 't',
  };
  const run = (extra = {}, ...args) => spawnSync(process.execPath, [bin, 'build-ios', ...args], { cwd: root, encoding: 'utf8', env: { ...env, ...extra } });
  const npm = () => (existsSync(env.STUB_LOG) ? readFileSync(env.STUB_LOG, 'utf8') : '');
  return { root, put, run, npm, commit: git('rev-parse', '--short', 'HEAD') };
}

describe('load-build-env', () => {
  const load = (file, env = {}) => {
    const { root, put } = iosApp();
    fixtures.push(root);
    put('app/.env.sentry-build-plugin', file);
    return spawnSync('bash', ['-c', 'set -euo pipefail; . "$1"; for v in A B C D E F; do printf "%s=[%s]\\n" "$v" "${!v-unset}"; done', '_', loader],
      { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  };

  it('exports the file\'s values as a dotenv reader reads them, the environment winning', () => {
    const result = load('# the build machine\n\nA=one\n  B = two words \r\nC="three=3"\nD=\nE=\'five\'\nF=from-file', { F: 'from-env' });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('A=[one]\nB=[two words]\nC=[three=3]\nD=[unset]\nE=[five]\nF=[from-env]\n');
  });

  it('refuses a line that names no variable, and does nothing without the file', () => {
    const result = load('A=1\nexport B=2\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('app/.env.sentry-build-plugin: "export B" is not a variable name\n');
    const { root } = iosApp();
    fixtures.push(root);
    expect(spawnSync('bash', ['-c', 'set -euo pipefail; . "$1"; echo "${A-unset}"', '_', loader], { cwd: root, encoding: 'utf8' }).stdout).toBe('unset\n');
  });
});

describe('build-ios', () => {
  it('needs a Mac', () => {
    const { root } = iosApp();
    fixtures.push(root);
    const result = spawnSync(process.execPath, [bin, 'build-ios', '--check'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('build-ios needs macOS: an iOS archive cannot be made elsewhere.\n');
  });

  it('runs every gate with --check and builds nothing', () => {
    const { run, npm, commit } = mac();
    const result = run({}, '--check');
    expect(result.stderr).toMatch(/^note: no codesigning identity in the keychain; automatic signing mints/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`iOS config ok (${BUNDLE_ID}, v1.2.3 build 3)`);
    expect(result.stdout).toContain(`app          Example (${BUNDLE_ID})\nversion      1.2.3  (build 3, commit ${commit})\nteam         TEAM123456\nsigning      automatic\nsymbols      example-ios\n`);
    expect(result.stdout).toMatch(/--check: every gate passed; nothing was built\.\n$/);
    expect(npm()).toBe('run --silent release-notes -- 1.2.3\n');
  });

  it('asks for release notes only of an app that keeps them', () => {
    const { run, npm } = mac(minimal);
    expect(run({}, '--check').status).toBe(0);
    expect(npm()).toBe('');
  });

  it.each([
    ['the emulators, from the shell', ({ run }) => run({ EXPO_PUBLIC_USE_EMULATORS: '1' }, '--check'), /^EXPO_PUBLIC_USE_EMULATORS is set in this shell\./],
    ['the emulators, from app/.env.local', ({ run, put }) => {
      put('app/.env.local', `EXPO_PUBLIC_SENTRY_DSN_NATIVE=https://k@example.invalid/1\n  EXPO_PUBLIC_USE_EMULATORS = 1\n`);
      return run({}, '--check');
    }, /^app\/\.env\.local sets EXPO_PUBLIC_USE_EMULATORS\./],
    ['an iOS configuration check that fails', ({ run, put }) => {
      put('app/.env.local', 'EXPO_PUBLIC_OTHER=1\n');
      return run({}, '--check');
    }, /iOS config check FAILED[\s\S]*crash reporting OFF/],
    ['no release notes for the version', ({ run }) => run({ STUB_NPM: '1' }, '--check'), /^No release notes for v1\.2\.3 \(npm run release-notes -- 1\.2\.3\)\./],
    ['no Apple team', ({ run }) => run({ IOS_TEAM_ID: '' }, '--check'), /^IOS_TEAM_ID is not set\./],
    ['a locked keychain', ({ run }) => run({ STUB_LOCKED: '1' }, '--check'), /^The signing keychain is locked:[\s\S]*security unlock-keychain .*login\.keychain-db/],
    ['an identity codesign cannot use', ({ run }) => run({ STUB_IDENTITY: '1', STUB_CODESIGN: '1' }, '--check'),
      /^The keychain is unlocked, but codesign cannot USE the signing identity\.[\s\S]*set-key-partition-list/],
    ['a profile that is not installed', ({ run }) => run({ IOS_PROFILE_NAME: 'Example App Store' }, '--check'),
      /^IOS_PROFILE_NAME is "Example App Store", and no installed provisioning profile has that name\./],
  ])('refuses %s', (_, act, message) => {
    const result = act(mac());
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
  });

  it('takes the build machine\'s values from app/.env.sentry-build-plugin, the shell winning', () => {
    const { run, put } = mac();
    put('app/.env.sentry-build-plugin', 'IOS_TEAM_ID=FILE123456\nSENTRY_PROJECT=from-file\n');
    const result = run({ IOS_TEAM_ID: '', SENTRY_PROJECT: 'from-shell' }, '--check');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/team {9}FILE123456\nsigning {6}automatic\nsymbols {6}from-shell\n/);
  });

  it('warns of a build that maps to no commit, and of one that uploads no symbols', () => {
    const { root, run, put, commit } = mac();
    put('app/android/app/build.gradle', readFileSync(join(root, 'app/android/app/build.gradle'), 'utf8') + '// edited\n');
    const result = run({ SENTRY_AUTH_TOKEN: '' }, '--check');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`commit ${commit}+)`);
    expect(result.stderr).toContain(`WARNING: uncommitted changes; this build is stamped ${commit}+ and maps to no commit.`);
    expect(result.stderr).toContain('WARNING: SENTRY_AUTH_TOKEN not set: this build uploads no debug symbols');
  });

  it('builds and exports an .ipa, uploading nothing, signed automatically on a Mac', () => {
    const { root, run, npm, commit } = mac();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(npm()).toBe('run --silent release-notes -- 1.2.3\nrun --silent build-info\n');
    const tools = readFileSync(join(root, 'tools.log'), 'utf8').trimEnd().split('\n');
    expect(tools[0]).toBe(`npx --no-install expo prebuild --platform ios --no-install [${commit}]`);
    expect(tools[1]).toBe(`pod install --repo-update [${commit}]`);
    expect(tools[2]).toMatch(/^xcodebuild -project app\/ios\/Example\.xcodeproj -list -json/);
    expect(tools[3]).toBe('xcodebuild -workspace app/ios/Example.xcworkspace -scheme Example -configuration Release -destination generic/platform=iOS'
      + ` -archivePath build/ios/Example-1.2.3-3.xcarchive -allowProvisioningUpdates DEVELOPMENT_TEAM=TEAM123456 archive [${commit}]`);
    expect(tools[4]).toMatch(/^xcodebuild -exportArchive -archivePath build\/ios\/Example-1\.2\.3-3\.xcarchive -exportPath build\/ios\/export -exportOptionsPlist build\/ios\/ExportOptions\.plist -allowProvisioningUpdates/);
    expect(tools).toHaveLength(5);
    const options = readFileSync(join(root, 'build/ios/export/options.plist'), 'utf8');
    expect(options).toContain('<key>destination</key><string>export</string>');
    expect(options).toContain('<key>method</key><string>app-store-connect</string>');
    expect(options).toContain('<key>signingStyle</key><string>automatic</string>');
    expect(result.stdout).toMatch(/scheme {7}Example\n/);
    expect(result.stdout).toContain(`Exported v1.2.3 (build 3, commit ${commit}) to build/ios/export/Example.ipa. Nothing was uploaded;`);
  });

  it('passes the App Store Connect key to an automatic build only whole, and only when its file exists', () => {
    const { root, put, run } = mac();
    put('home/.appstoreconnect/private_keys/AuthKey_KEY1234567.p8', 'fixture');
    const archive = () => readFileSync(join(root, 'tools.log'), 'utf8').split('\n').find((line) => line.endsWith(']') && line.includes(' archive '));
    expect(run({ ASC_KEY_ID: 'KEY1234567', ASC_ISSUER_ID: 'ISSUER' }).status).toBe(0);
    expect(archive()).toContain(`-allowProvisioningUpdates -authenticationKeyPath ${join(root, 'home')}/.appstoreconnect/private_keys/AuthKey_KEY1234567.p8 -authenticationKeyID KEY1234567 -authenticationKeyIssuerID ISSUER DEVELOPMENT_TEAM`);
    rmSync(join(root, 'tools.log'));
    expect(run({ ASC_KEY_ID: 'KEY1234567' }).status).toBe(0);
    expect(archive()).toContain('-allowProvisioningUpdates DEVELOPMENT_TEAM');
  });

  it('signs manually with the installed profile, on the app target alone, minting nothing', () => {
    const { root, run, npm } = mac();
    profile(root);
    const result = run(MANUAL);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('signing      manual, profile "Example App Store" (expires 2099-01-01T00:00:00Z)');
    expect(npm()).toContain('ruby app/ios/Example.xcodeproj Example Example App Store TEAM123456\n');
    const tools = readFileSync(join(root, 'tools.log'), 'utf8');
    expect(tools).not.toContain('-allowProvisioningUpdates');
    expect(tools).not.toContain('-authenticationKey');
    const options = readFileSync(join(root, 'build/ios/export/options.plist'), 'utf8');
    expect(options).toContain('<key>signingStyle</key><string>manual</string>');
    expect(options).toContain(`<key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>Example App Store</string></dict>`);
    expect(options).toContain('<key>destination</key><string>export</string>');
  });

  it.each([
    ['another app\'s profile', { Entitlements: { 'application-identifier': 'TEAM123456.com.sabeelinstitute.other' } }, MANUAL,
      /^Profile "Example App Store" is for TEAM123456\.com\.sabeelinstitute\.other, not TEAM123456\.com\.sabeelinstitute\.example\./],
    ['an expired profile', { ExpirationDate: '2020-01-01T00:00:00Z' }, MANUAL, /^Profile "Example App Store" expired 2020-01-01T00:00:00Z\./],
    ['a profile made on another certificate', { DeveloperCertificates: [Buffer.from('another certificate').toString('base64')] }, MANUAL,
      /^Profile "Example App Store" does not carry the certificate of the\nApple Distribution identity in the keychain/],
    ['no distribution identity', {}, { ...MANUAL, STUB_IDENTITY_NAME: 'Apple Development: Example' },
      /^IOS_PROFILE_NAME is set \(manual signing\), but the keychain holds no Apple Distribution identity\./],
  ])('refuses %s', (_, changes, env, message) => {
    const { root, run } = mac();
    profile(root, changes);
    const result = run(env, '--check');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
  });

  it('stops when pod install resolves other pods than the lock pins', () => {
    const { run } = mac();
    const result = run({ STUB_PODS: 'PODS:\n  - Example (1.0.1)\n\nDEPENDENCIES:\n  - Example\n' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pod install resolved other pods than app\/Podfile\.lock pins/);
  });

  it('refuses an option it does not have', () => {
    const { run } = mac();
    const result = run({}, '--no-upload');
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('build-ios: unknown option --no-upload (sabeel-ci build-ios [--check])\n');
  });
});
