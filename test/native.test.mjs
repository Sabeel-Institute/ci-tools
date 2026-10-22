import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debugAppId } from '../scripts/lib/android-app.mjs';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import minimal from './fixtures/minimal.json' with { type: 'json' };

const runner = readFileSync(new URL('../scripts/native-e2e.sh', import.meta.url), 'utf8');
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function android(gradle) {
  const root = mkdtempSync(join(tmpdir(), 'ci-tools-native-'));
  fixtures.push(root);
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('app/app.json', JSON.stringify({ expo: { android: { package: 'com.sabeelinstitute.example' } } }));
  put('app/android/app/build.gradle', gradle);
  return root;
}

describe('the native flows', () => {
  const workflow = renderAll(full).get('native.yml');

  it('run on every main push and release tag, all of them, and keep what they saw', () => {
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]\n {4}tags: \['v\*'\]/);
    expect(workflow).toContain('run: sabeel-ci ci-avd');
    expect(workflow).toMatch(/run: sabeel-ci native-e2e\n/);
    expect(workflow).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact/);
    expect(workflow).toContain('path: shots/native/');
  });

  it('run on the iOS simulator for release tags, by hand and for pull requests that change them', () => {
    expect(workflow).toMatch(/\n {2}ios:\n {4}if: .*startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| github\.event_name != 'push'/);
    expect(workflow).toContain('runs-on: macos-');
    expect(workflow).toMatch(/run: sabeel-ci native-e2e --ios\n/);
    expect(workflow).toContain('- scripts/seed-emulators.mjs\n');
    expect(workflow).toContain('- package-lock.json\n');
  });

  it('start the web dev server and the media tools only for an app that needs them', () => {
    const lean = renderAll(minimal).get('native.yml');
    for (const step of ['Install Chromium for the seed', 'Install SeaweedFS', 'Install ffmpeg']) {
      expect(workflow).toContain(`name: ${step}`);
      expect(lean).not.toContain(`name: ${step}`);
    }
    // native-e2e writes them through sabeel-ci emulators.
    expect(workflow).not.toContain('name: Emulator secret placeholders');
  });

  it("seed the emulators with the app's one seed script, and refuse to run without it", () => {
    expect(runner).toContain('SEED=scripts/seed-emulators.mjs\n');
    expect(runner).toMatch(/\[ -f "\$SEED" \] \|\| \{ echo "native-e2e: no \$SEED/);
  });

  it('each drive the build the runner installed, on either platform', () => {
    expect(runner).toMatch(/-e APP_ID="\$APP_ID"/);
    expect(runner).toContain("APP_ID=$(node -p \"require('./app/app.json').expo.ios.bundleIdentifier\")");
    expect(runner).toContain('debugAppId()');
  });

  it("name Android's debug build by the package and the debug build type's suffix", () => {
    const types = (debug) => `android {\n    buildTypes {\n        debug {\n${debug}        }\n        release {\n            applicationIdSuffix '.never'\n        }\n    }\n}\n`;
    expect(debugAppId(android(types("            applicationIdSuffix '.debug'\n            signingConfig signingConfigs.debug\n"))))
      .toBe('com.sabeelinstitute.example.debug');
    expect(debugAppId(android(types('            signingConfig signingConfigs.debug\n')))).toBe('com.sabeelinstitute.example');
    expect(debugAppId(android('android {\n    signingConfigs {\n        debug {\n            storeFile file("debug.keystore")\n        }\n    }\n}\n')))
      .toBe('com.sabeelinstitute.example');
  });

  it('retry only the two failures that are not the app: the debug renderer crash and a lost iOS driver', () => {
    expect(runner.match(/run_flows \|\| rc=\$\?/g)).toHaveLength(3);
    expect(runner).toContain("grep -q 'MountingCoordinator::pullTransaction' \"$LOGS/logcat.txt\"");
    expect(runner).toContain("grep -q 'DeviceUnreachableException' \"$OUT/report.xml\"");
  });

  it("keep the Firebase CLI's own logs, which say why a function failed to load", () => {
    expect(runner).toMatch(/for log in firebase-debug\.log firestore-debug\.log; do\n\s+\[ ! -f "\$log" \] \|\| cp "\$log" "\$LOGS\/"/);
  });
});
