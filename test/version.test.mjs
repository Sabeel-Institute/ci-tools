import { describe, expect, it } from 'vitest';
import { VERSION_CODE_MAX, androidIdentity, buildNumber, versionCode, versionProblems } from '../lib/version.mjs';

const computed = '        versionCode computedVersionCode\n        versionName expoVersion\n';

describe('app versions', () => {
  it('takes three integers without leading zeros, within the versionCode scheme', () => {
    for (const version of ['0.0.1', '0.1.33', '1.0.0', '2100.0.0']) expect(versionProblems(version)).toEqual([]);
    for (const version of ['1.2.3-beta.1', '1.2.3.4', 'v1.2.3', '2026.07.01', '01.2.3', '1.2', '0.1.1000', '0.1000.0',
      '2100.0.1', '1.2.3 ', '', '1000000000000000.0.0']) {
      expect(versionProblems(version), version).not.toEqual([]);
    }
    expect(versionProblems(undefined)).toEqual(['undefined is not a version string.']);
  });

  it('gives Android and iOS one number per version, rising with it', () => {
    expect(versionCode('0.2.1')).toBe(2001);
    expect(versionCode('0.12.3')).toBe(12003);
    expect(versionCode('1.0.0')).toBe(1000000);
    expect(versionCode('2100.0.0')).toBe(VERSION_CODE_MAX);
    // Two-digit fields made 0.1.100 and 0.2.0 the same code once.
    expect(versionCode('0.1.999')).toBeLessThan(versionCode('0.2.0'));
    expect(buildNumber('0.29.2')).toBe('29002');
    expect(() => versionCode('0.2.1-beta')).toThrow(/X\.Y\.Z/);
  });

  it("reads Android's identity only from a build.gradle that derives it from app.json", () => {
    const app = { version: '0.2.0', android: { package: 'com.test.app' } };
    expect(androidIdentity(app, computed)).toEqual({ packageName: 'com.test.app', versionName: '0.2.0', versionCode: 2000 });
    expect(() => androidIdentity(app, '        versionCode 38\n        versionName "0.2.0"\n')).toThrow(/derive the version from app\.json/);
    expect(() => androidIdentity(app, '')).toThrow(/derive the version/);
    expect(() => androidIdentity({ ...app, android: { ...app.android, versionCode: 2000 } }, computed)).toThrow(/states android\.versionCode 2000; remove it/);
    expect(() => androidIdentity({ ...app, version: '0.2' }, computed)).toThrow(/X\.Y\.Z/);
  });
});
