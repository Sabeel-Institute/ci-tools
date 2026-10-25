import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

  it('warm the emulated callables from the bundle the emulators run, never a rebuild that reloads them', () => {
    const script = readFileSync(new URL('../scripts/ci-functions.mjs', import.meta.url), 'utf8');
    const warm = script.slice(script.indexOf('async function warm('), script.indexOf('\n}\n', script.indexOf('async function warm(')));
    expect(warm).toContain('loadEndpoints({ build: false })');
  });

  it('call every emulated callable once after the seed, so no flow waits on a cold function', () => {
    const at = (text) => runner.indexOf(text);
    expect(at('ci-functions.mjs" warm')).toBeGreaterThan(at('node "$SEED"'));
    expect(at('ci-functions.mjs" warm')).toBeLessThan(at('exec npx expo start --port "$METRO_PORT"'));
    expect(runner).toMatch(/ci-functions\.mjs" warm [^\n]*\\\n\s+\|\| \{ echo "native-e2e: the emulated functions did not all start/);
  });

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

  it('report memory, disk and the largest processes from before the build, into the job log in CI', () => {
    const at = (text) => runner.indexOf(text);
    // A runner that runs out of memory is shut down before the artifact upload.
    expect(runner).toMatch(/if \[ "\$\{GITHUB_ACTIONS:-\}" = true \]; then sample_resources \| tee -a "\$LOGS\/resources\.log"/);
    expect(at('RESOURCES_PID=$!')).toBeLessThan(at('./gradlew assembleDebug'));
    expect(at('RESOURCES_PID=$!')).toBeLessThan(at('ios-sim-build.sh'));
    // Stopped on every exit, a failed build's included.
    expect(at('trap cleanup EXIT')).toBeLessThan(at('RESOURCES_PID=$!'));
    expect(runner).toMatch(/for pid in [^\n]*"\$\{RESOURCES_PID:-\}"; do/);
  });

  it("share ci-tools' flow steps, copied into each run before the build", () => {
    const copy = runner.indexOf('cp -R "$CI_TOOLS/maestro" maestro/ci-tools');
    expect(copy).toBeGreaterThan(0);
    expect(copy).toBeLessThan(runner.indexOf('./gradlew assembleDebug'));
    const steps = readdirSync(new URL('../maestro/', import.meta.url));
    expect(steps.sort()).toEqual(['back-until.yaml', 'back.yaml', 'tap-until.yaml', 'wait.yaml']);
    for (const name of steps) {
      expect(readFileSync(new URL(`../maestro/${name}`, import.meta.url), 'utf8').split('\n')).toContain('appId: ${APP_ID}');
    }
  });

  it('leave no Gradle or Kotlin daemon holding memory once the APK is built', () => {
    // 5 GB between them ran a 16 GB runner out of memory beside the emulator.
    expect(runner).toMatch(/\.\/gradlew assembleDebug [^\n]*-Pkotlin\.compiler\.execution\.strategy=in-process/);
    expect(runner).toMatch(/assembleDebug [^\n]*\\\n\s+&& \.\/gradlew --stop/);
  });

  it("build the web page's scripts before the seed loads the page", () => {
    const at = (text) => runner.indexOf(text);
    const warm = at('curl -sf -o /dev/null --max-time 600 "http://127.0.0.1:${WEB_PORT}${script}"');
    expect(warm).toBeGreaterThan(at('wait_for "http://127.0.0.1:${WEB_PORT}/" "the web dev server"'));
    expect(warm).toBeLessThan(at('node "$SEED"'));
    expect(runner).toContain('native-e2e: the web dev server\'s page loads no script');
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
