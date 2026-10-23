import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { versionCode } from '../lib/version.mjs';
import { accessToken, fingerprint, playApi, readCredential } from './publish-play.mjs';

/**
 * The APK Google Play made of the app's published bundle, signed exactly as
 * Play installs it on phones:
 *
 *   sabeel-ci play-apk <out.apk>
 *
 * Play generates a universal APK, every ABI in one file, for each versionCode
 * it holds. This takes app.json's version's, refuses one Play signs with any
 * key but ci-tools.json's release.appSigningCertificate, and writes it to
 * out.apk. It only lists and downloads; nothing on Play changes. The key is
 * the Play publishing service account's JSON (~/keys/sabeel-play-publisher.json,
 * or the path in PLAY_KEY), never printed. `release --ship` attaches the APK
 * to the GitHub release, so a sideloaded install and Play's update each other.
 *
 * It refuses an APK carrying Play's installer check (Play Console's automatic
 * protection, a per-app setting no API reads): installed by anything but Play,
 * such an APK asks for Google Play and does not open, so neither the release
 * check nor anyone installing from the GitHub release could run it.
 */

/** The bytes of Play's universal APK for `code`, once Play signs it with `appSigningCertificate`. */
export async function universalApk(api, code, appSigningCertificate) {
  let generatedApks = [];
  try {
    ({ generatedApks = [] } = await api.call('GET', `/generatedApks/${code}`));
  } catch (error) {
    if (!/HTTP 404/.test(error.message)) throw error;
  }
  const universal = generatedApks.find((apk) => apk.generatedUniversalApk?.downloadId);
  if (!universal) {
    throw new Error(`Play has no universal APK for versionCode ${code} of ${api.packageName}: it holds no bundle of that version.`);
  }
  if (fingerprint(String(universal.certificateSha256Hash ?? '')) !== fingerprint(appSigningCertificate)) {
    throw new Error(`Play signs versionCode ${code} with ${universal.certificateSha256Hash}, not with the app signing key\n`
      + `ci-tools.json names (release.appSigningCertificate), ${appSigningCertificate}.`);
  }
  const bytes = await api.download(`/generatedApks/${code}/downloads/${encodeURIComponent(universal.generatedUniversalApk.downloadId)}:download?alt=media`);
  if (bytes.subarray(0, 2).toString('latin1') !== 'PK') throw new Error(`What Play sent for versionCode ${code} is not an APK.`);
  return bytes;
}

/** Whether the APK at `apk` carries Play's installer check, which automatic protection adds. */
export function hasInstallerCheck(apk) {
  return execFileSync('unzip', ['-p', apk, 'classes*.dex'], { maxBuffer: 1 << 30 }).includes('Lcom/pairip/licensecheck/');
}

async function main(args) {
  if (args.length !== 1 || !args[0].endsWith('.apk')) {
    console.error('usage: sabeel-ci play-apk <out.apk>');
    return 2;
  }
  const { release } = config();
  const app = JSON.parse(readFileSync('app/app.json', 'utf8')).expo;
  const code = versionCode(app.version);
  const key = process.env.PLAY_KEY || join(homedir(), 'keys', 'sabeel-play-publisher.json');
  const api = playApi(await accessToken(readCredential(key)), app.android.package);
  const bytes = await universalApk(api, code, release.appSigningCertificate);
  writeFileSync(args[0], bytes);
  if (hasInstallerCheck(args[0])) {
    throw new Error(`Play adds its installer check (automatic protection) to ${app.android.package}'s APKs: installed by anything but\n`
      + 'Play, the APK asks for Google Play and does not open. Turn automatic protection off (Play Console, the app,\n'
      + `Protected with Play), then release a new version: Play built versionCode ${code}'s APKs with the check.`);
  }
  console.log(`${args[0]}: Play's universal APK of ${app.version} (${code}), ${(bytes.length / 1048576).toFixed(1)} MB, `
    + `signed with ${release.appSigningCertificate}`);
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`\nplay-apk: ${error.message}\n`);
    process.exitCode = 1;
  }
}
