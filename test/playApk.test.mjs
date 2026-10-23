import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasInstallerCheck, universalApk } from '../scripts/play-apk.mjs';

const KEY = 'B1:61:7E:20:81:67:E4:0D:16:4E:38:CB:BA:29:48:7C:96:AE:5A:6F:E4:76:A7:37:17:5A:CC:91:B3:A5:99:6E';

/** The Play API as play-apk calls it: generatedApks lists `apks` (or answers 404), download serves `bytes`. */
function play(apks, bytes = Buffer.from('PK\u0003\u0004apk')) {
  const asked = [];
  return {
    asked,
    api: {
      packageName: 'com.sabeelinstitute.example',
      call: async (method, path) => {
        asked.push(`${method} ${path}`);
        if (apks === null) throw new Error(`${method} ${path}: HTTP 404\n{"error":{"status":"NOT_FOUND"}}`);
        return { generatedApks: apks };
      },
      download: async (path) => (asked.push(`download ${path}`), bytes),
    },
  };
}

describe("play-apk: the APK Play signs", () => {
  it('downloads the universal APK of the versionCode, once Play signs it with the app signing key', async () => {
    const { api, asked } = play([
      { certificateSha256Hash: KEY.toLowerCase().replaceAll(':', ''), generatedSplitApks: [{ downloadId: 'split' }] },
      { certificateSha256Hash: KEY, generatedUniversalApk: { downloadId: 'u/1' } },
    ]);
    expect((await universalApk(api, 29001, KEY)).subarray(0, 2).toString()).toBe('PK');
    expect(asked).toEqual(['GET /generatedApks/29001', 'download /generatedApks/29001/downloads/u%2F1:download?alt=media']);
  });

  it('refuses an APK Play signs with another key, before downloading it', async () => {
    const { api, asked } = play([{ certificateSha256Hash: '39:AA:DF:C6', generatedUniversalApk: { downloadId: 'u' } }]);
    await expect(universalApk(api, 12002, KEY)).rejects.toThrow(/Play signs versionCode 12002 with 39:AA:DF:C6, not with the app signing key\nci-tools\.json names \(release\.appSigningCertificate\)/);
    expect(asked).toEqual(['GET /generatedApks/12002']);
  });

  it('says plainly when Play holds no bundle of the version, or lists no universal APK', async () => {
    await expect(universalApk(play(null).api, 2001, KEY)).rejects.toThrow('Play has no universal APK for versionCode 2001 of com.sabeelinstitute.example: it holds no bundle of that version.');
    await expect(universalApk(play([{ certificateSha256Hash: KEY }]).api, 2001, KEY)).rejects.toThrow(/no universal APK for versionCode 2001/);
  });

  it('refuses what is not an APK', async () => {
    const { api } = play([{ certificateSha256Hash: KEY, generatedUniversalApk: { downloadId: 'u' } }], Buffer.from('<html>error</html>'));
    await expect(universalApk(api, 29001, KEY)).rejects.toThrow('What Play sent for versionCode 29001 is not an APK.');
  });

  it("finds Play's installer check in any of the APK's dex files", () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-apk-'));
    const apk = (name, dex) => {
      for (const [file, text] of Object.entries(dex)) writeFileSync(join(dir, file), `dex\n035\0${text}`);
      execFileSync('zip', ['-q', join(dir, name), ...Object.keys(dex)], { cwd: dir });
      return join(dir, name);
    };
    expect(hasInstallerCheck(apk('plain.apk', { 'classes.dex': 'Lcom/sabeelinstitute/example/MainActivity;' }))).toBe(false);
    expect(hasInstallerCheck(apk('protected.apk', {
      'classes.dex': 'Lcom/sabeelinstitute/example/MainActivity;',
      'classes2.dex': 'Lcom/pairip/licensecheck/LicenseActivity;',
    }))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps any other Play error as it is', async () => {
    const api = { packageName: 'x', call: async () => { throw new Error('GET /generatedApks/1: HTTP 403\nforbidden'); } };
    await expect(universalApk(api, 1, KEY)).rejects.toThrow(/HTTP 403/);
  });
});
