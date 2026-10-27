import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debugAppId } from '../scripts/lib/android-app.mjs';
import { RECIPES, cacheKey, fingerprintOptions } from '../scripts/native-fingerprint.mjs';
import { renderAll } from '../scripts/workflows.mjs';
import full from './fixtures/full.json' with { type: 'json' };
import minimal from './fixtures/minimal.json' with { type: 'json' };

const runner = readFileSync(new URL('../scripts/native-e2e.sh', import.meta.url), 'utf8');
const builder = readFileSync(new URL('../scripts/native-build.sh', import.meta.url), 'utf8');
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
    expect(workflow).toMatch(/run: sabeel-ci native-e2e --build ~\/native-build\n/);
    expect(workflow).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact/);
    expect(workflow).toContain('path: shots/native/');
  });

  it('run on the iOS simulator for release tags, pull requests and by hand, and on main only for a build not kept', () => {
    expect(workflow).toMatch(/\n {2}ios:\n {4}needs: fingerprint\n {4}if: github\.event_name != 'push' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| needs\.fingerprint\.outputs\.ios-kept != 'true'\n/);
    expect(workflow).toContain('runs-on: macos-');
    expect(workflow).toMatch(/run: sabeel-ci native-e2e --ios --build ~\/native-build\n/);
  });

  it('build the debug app only for native inputs no kept build has, and keep it before the flows', () => {
    const fingerprint = workflow.slice(workflow.indexOf('\n  fingerprint:\n'), workflow.indexOf('\n  android:\n'));
    expect(fingerprint).toContain("if: github.repository_owner == 'Sabeel-Institute'");
    expect(fingerprint).toContain('run: sabeel-ci native-fingerprint debug');
    expect(fingerprint).toMatch(/lookup-only: true/);
    for (const [name, platform] of [['android', 'android'], ['ios', 'ios']]) {
      const end = name === 'android' ? '\n  # On a main push' : '\n  # The check main';
      const job = workflow.slice(workflow.indexOf(`\n  ${name}:\n`), workflow.indexOf(end));
      expect(job).toContain('needs: fingerprint');
      const at = (text) => job.indexOf(text);
      const key = `key: \${{ needs.fingerprint.outputs.${platform} }}`;
      expect(job.split(key)).toHaveLength(3);
      expect(at('uses: actions/cache/restore@')).toBeGreaterThan(0);
      expect(at('uses: actions/cache/restore@')).toBeLessThan(at(`run: sabeel-ci native-build ${platform} ~/native-build`));
      expect(at(`run: sabeel-ci native-build ${platform} ~/native-build`)).toBeLessThan(at('uses: actions/cache/save@'));
      expect(at('uses: actions/cache/save@')).toBeLessThan(at('run: sabeel-ci native-e2e'));
      expect(job.match(/if: steps\.kept\.outputs\.cache-hit != 'true'\n/g).length).toBeGreaterThanOrEqual(2);
    }
    // The SDK packages are the build's: the emulator brings its own.
    const android = workflow.slice(workflow.indexOf('\n  android:\n'), workflow.indexOf('\n  # On a main push'));
    expect(android).toMatch(/if: steps\.kept\.outputs\.cache-hit != 'true'\n\s+run: sabeel-ci ci-android-sdk/);
  });

  it('key each build by its platform\'s fingerprint, the recipe and, for iOS, the pods the lock pins', () => {
    for (const kind of Object.keys(RECIPES)) {
      const android = fingerprintOptions(kind, 'android');
      const ios = fingerprintOptions(kind, 'ios');
      expect(android.platforms).toEqual(['android']);
      expect(ios.platforms).toEqual(['ios']);
      expect(android.extraSources).toContainEqual(expect.objectContaining({ id: 'ci-tools:recipe', contents: `${kind} android ${RECIPES[kind]}` }));
      expect(ios.extraSources).toContainEqual(expect.objectContaining({ type: 'file', filePath: 'Podfile.lock' }));
      expect(android.extraSources.some((source) => source.filePath === 'Podfile.lock')).toBe(false);
    }
    expect(cacheKey('debug', 'ios', 'abc')).toBe('native-debug-ios-abc');
    expect(() => fingerprintOptions('profile', 'android')).toThrow(/no build kind/);
    expect(() => fingerprintOptions('debug', 'web')).toThrow(/no platform/);
  });

  it('install a build it is given, and build one only when it is not', () => {
    const at = (text) => runner.indexOf(text);
    expect(runner).toMatch(/--build\)\n/);
    expect(at('if [ -z "$BUILD" ]; then')).toBeLessThan(at('native-build.sh" "$PLATFORM" "$BUILD"'));
    expect(runner).toContain('apk="$BUILD/app-debug.apk"');
    expect(runner).toContain("app=$(find \"$BUILD\" -maxdepth 1 -name '*.app' | head -1)");
    expect(builder).toContain('cp "$apk" "$OUT/app-debug.apk"');
    expect(builder).toMatch(/ditto "\$app" "\$OUT\/\$\(basename "\$app"\)"/);
  });

  it('build for and boot the same iOS simulator, and boot it before the emulators start', () => {
    expect(builder).toContain('. "$CI_TOOLS/scripts/lib/ios-simulator.sh"');
    expect(runner).toContain('. "$CI_TOOLS/scripts/lib/ios-simulator.sh"');
    const at = (text) => runner.indexOf(text);
    // A booting simulator beside the emulators slowed a blocking function past the Auth emulator's deadline.
    expect(at('xcrun simctl bootstatus "$DEVICE" -b')).toBeGreaterThan(0);
    expect(at('xcrun simctl install "$DEVICE" "$app"')).toBeGreaterThan(at('xcrun simctl bootstatus "$DEVICE" -b'));
    expect(at('xcrun simctl install "$DEVICE" "$app"')).toBeLessThan(at('node "$CI_TOOLS/scripts/emulators.mjs"'));
    expect(runner).not.toMatch(/bootstatus[^\n]*&\n/);
  });

  it("read the iOS simulator's log only when a flow failed, since it takes minutes", () => {
    expect(runner).toMatch(/if \[ "\$rc" -ne 0 \]; then\n\s+xcrun simctl spawn "\$DEVICE" log show/);
    expect(runner.match(/log show/g)).toHaveLength(1);
  });

  it('keep macOS from handing out an emulator port at random before the iOS flows', () => {
    const ios = workflow.slice(workflow.indexOf('\n  ios:\n'), workflow.indexOf('\n  native:\n'));
    expect(ios).toContain('sudo sysctl -w net.inet.ip.portrange.last=60999 net.inet.ip.portrange.hilast=60999');
    expect(ios.indexOf('portrange.last=60999')).toBeLessThan(ios.indexOf('run: sabeel-ci native-e2e --ios'));
  });

  it('run on every pull request to main and gate it on both platforms, failing closed', () => {
    // A path filter would leave the required check unreported, and the pull
    // request blocked, whenever it skipped the workflow.
    expect(workflow).toMatch(/pull_request:\n {4}branches: \[main\]\n {2}workflow_dispatch:/);
    expect(workflow).not.toContain('paths:');
    const gate = workflow.slice(workflow.indexOf('\n  native:\n'));
    expect(gate).toContain("if: always() && github.event_name == 'pull_request'");
    expect(gate).toContain('needs: [android, ios]');
    expect(gate).toContain('jobs.length !== 2');
    expect(gate).toContain('job.result !== "success"');
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
    expect(at('RESOURCES_PID=$!')).toBeLessThan(at('native-build.sh" "$PLATFORM" "$BUILD"'));
    // Stopped on every exit, a failed build's included.
    expect(at('trap cleanup EXIT')).toBeLessThan(at('RESOURCES_PID=$!'));
    expect(runner).toMatch(/for pid in [^\n]*"\$\{RESOURCES_PID:-\}"; do/);
  });

  it("share ci-tools' flow steps, copied into each run before the build", () => {
    const copy = runner.indexOf('cp -R "$CI_TOOLS/maestro" maestro/ci-tools');
    expect(copy).toBeGreaterThan(0);
    expect(copy).toBeLessThan(runner.indexOf('native-build.sh" "$PLATFORM" "$BUILD"'));
    const steps = readdirSync(new URL('../maestro/', import.meta.url));
    expect(steps.sort()).toEqual(['back-until.yaml', 'back.yaml', 'tap-until.yaml', 'wait.yaml']);
    for (const name of steps) {
      expect(readFileSync(new URL(`../maestro/${name}`, import.meta.url), 'utf8').split('\n')).toContain('appId: ${APP_ID}');
    }
  });

  it('leave no Gradle or Kotlin daemon holding memory once the APK is built', () => {
    // 5 GB between them ran a 16 GB runner out of memory beside the emulator.
    expect(builder).toMatch(/\.\/gradlew assembleDebug [^\n]*-Pkotlin\.compiler\.execution\.strategy=in-process/);
    expect(builder).toMatch(/assembleDebug [^\n]*\\\n\s+&& \.\/gradlew --stop/);
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
