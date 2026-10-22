import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK, suitePorts } from '../lib/ports.mjs';
import full from './fixtures/full.json' with { type: 'json' };

/**
 * The emulator commands, run as an app runs them, against stand-ins: a fake
 * `ss` answering from a table, fake `firebase` and `npm` that log their
 * arguments, a fake JDK and Android SDK. Every process stopped here is one
 * this test started; no real emulator or port is touched.
 */
const bin = fileURLToPath(new URL('../bin/sabeel-ci.mjs', import.meta.url));
const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const made = [];
const started = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(directory);
  return directory;
}

function tool(directory, name, body) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(directory, name), 0o755);
}

/** `ss -lptn "sport = :PORT"`, answered from $FAKE_SS_TABLE ("port pid" lines), every port asked logged. */
const FAKE_SS = `port=\${2#sport = :}
echo "$port" >>"$FAKE_SS_LOG"
[ -f "$FAKE_SS_TABLE" ] || exit 0
while read -r p pid; do
  [ "$p" = "$port" ] || continue
  case "$(ps -o stat= -p "$pid" 2>/dev/null)" in ''|Z*) continue ;; esac
  echo "LISTEN 0 511 127.0.0.1:$port 0.0.0.0:* users:((\\"node\\",pid=$pid,fd=21))"
done <"$FAKE_SS_TABLE"`;

/** A JDK whose java says it is `version`. */
function jdk(version) {
  const home = scratch('ci-tools-jdk-');
  tool(join(home, 'bin'), 'java', `[ "$1" = -XshowSettings:properties ] && echo "    java.home = ${home}" >&2
echo 'openjdk version "${version}" 2024-10-15' >&2`);
  return home;
}

/** An app at full.json's settings, with the fakes on its PATH. */
function app(settings = full) {
  const root = scratch('ci-tools-app-');
  const fakes = join(root, '.fakes');
  writeFileSync(join(root, 'ci-tools.json'), JSON.stringify(settings));
  writeFileSync(join(root, 'firebase.json'), JSON.stringify({ emulators: {
    auth: { port: 61902 }, functions: { port: 61903 }, firestore: { port: 61900, websocketPort: 61901 }, storage: { port: 61907 },
    ui: { enabled: true, port: 61904 }, hub: { port: 61905 }, logging: { port: 61906 }, tasks: { port: 61908 }, eventarc: { port: 61909 },
    singleProjectMode: true,
  } }));
  mkdirSync(join(root, 'functions'));
  tool(fakes, 'ss', FAKE_SS);
  tool(fakes, 'npm', `echo "npm $*" >>"$FAKE_LOG"`);
  tool(fakes, 'firebase', `echo "firebase $* JAVA_HOME=$JAVA_HOME FUNCTIONS_DISCOVERY_TIMEOUT=$FUNCTIONS_DISCOVERY_TIMEOUT" >>"$FAKE_LOG"
case "$*" in *test:emulator:rules*) exit "\${RULES_EXIT:-0}" ;; esac
[ -z "$FIREBASE_PIDFILE" ] && exit 0
trap 'echo "firebase got TERM" >>"$FAKE_LOG"; exit 143' TERM
echo $$ >"$FIREBASE_PIDFILE"
while :; do sleep 0.1; done`);
  tool(fakes, 'with-store', 'echo "with-store around: $*" >>"$FAKE_LOG"; exec "$@"');
  const env = {
    ...process.env,
    PATH: `${fakes}:${process.env.PATH}`,
    FAKE_LOG: join(root, 'fake.log'),
    FAKE_SS_LOG: join(root, 'ss.log'),
    FAKE_SS_TABLE: join(root, 'ss.table'),
    SABEEL_JDK21_HOME: jdk('21.0.5'),
    FUNCTIONS_DISCOVERY_TIMEOUT: '',
  };
  const log = (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n') : []);
  return { root, env, log };
}

const sabeel = (cwd, env, ...args) => spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8' });

/** A process of this test's, `sleep 60` in `cwd` as `name`, adopted by init so nothing here reaps it early. */
function sleeper(cwd, name = 'sleep') {
  const pid = Number(execFileSync('bash', ['-c', 'cd "$1" && { exec -a "$2" sleep 60 >/dev/null 2>&1 & } && echo $!', '_', cwd, name], { encoding: 'utf8' }));
  started.push(pid);
  return pid;
}
const alive = (pid) => {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
};

describe('sabeel-ci ports', () => {
  it('names every port, one port, what an emulator run binds, or its project', () => {
    const { root, env } = app();
    expect(sabeel(root, env, 'ports').stdout).toMatch(/^61900 firestore\n61901 firestoreWebsocket\n[\s\S]*61910 web\n[\s\S]*61921 storeAdmin\n$/);
    expect(sabeel(root, env, 'ports', 'web').stdout).toBe('61910\n');
    expect(sabeel(root, env, 'ports', '--project').stdout).toBe('demo-sabeel-example\n');
    expect(sabeel(root, env, 'ports', '--suite').stdout.trim().split(' ').map(Number)).toEqual(suitePorts(full));
    const wrong = sabeel(root, env, 'ports', 'webb');
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toMatch(/no port named webb; the names are firestore, .*storeAdmin/);
  });
});

describe('sabeel-ci free-emulator-ports', () => {
  it("asks only about the app's own suite ports, inside its block", () => {
    const { root, env, log } = app();
    const result = sabeel(root, env, 'free-emulator-ports');
    expect(result.stdout).toContain('emulator ports clear');
    expect(result.status).toBe(0);
    const asked = [...new Set(log('ss.log').map(Number))].sort((a, b) => a - b);
    expect(asked).toEqual(suitePorts(full));
    expect(asked.every((port) => port >= full.emulators.base && port < full.emulators.base + BLOCK)).toBe(true);
  });

  it('stops a leftover of this checkout that holds one', () => {
    const { root, env } = app();
    const leftover = sleeper(join(root, 'functions'));
    writeFileSync(env.FAKE_SS_TABLE, `61903 ${leftover}\n61920 ${leftover}\n`);
    const result = sabeel(root, env, 'free-emulator-ports');
    expect(result.stdout).toContain(`freeing emulator ports; stopping: ${leftover}`);
    expect(result.stdout).toMatch(/emulator ports clear\n$/);
    expect(result.status).toBe(0);
    expect(alive(leftover)).toBe(false);
  });

  it('stops nothing, and fails, when a port is held from outside the checkout', () => {
    const { root, env } = app();
    const elsewhere = scratch('ci-tools-sibling-');
    const sibling = sleeper(elsewhere);
    const leftover = sleeper(root);
    writeFileSync(env.FAKE_SS_TABLE, `61900 ${sibling}\n61902 ${leftover}\n`);
    const result = sabeel(root, env, 'free-emulator-ports');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`port 61900: pid ${sibling} in ${elsewhere}: sleep 60`);
    expect(result.stderr).toContain('Nothing was stopped. Stop them by pid if they are yours.');
    expect(alive(sibling)).toBe(true);
    expect(alive(leftover)).toBe(true);
  });

  it("stops the functions runtimes a run orphaned in this checkout, and no other's", () => {
    const { root, env } = app();
    const orphan = sleeper(join(root, 'functions'), 'firebase-tools-runtime');
    const elsewhere = sleeper(scratch('ci-tools-sibling-'), 'firebase-tools-runtime');
    // A runtime whose emulator is still running it: its parent's command line names firebase.
    const pidfile = join(root, 'owned.pid');
    const parent = Number(execFileSync('bash', ['-c', `cd "$1" && { exec -a firebase-emulators bash -c '(cd functions && exec -a firebase-tools-runtime sleep 60) & echo $! >"$0"; wait' "$2" >/dev/null 2>&1 & } && echo $!`,
      '_', root, pidfile], { encoding: 'utf8' }));
    started.push(parent);
    for (let i = 0; i < 50 && !existsSync(pidfile); i += 1) execFileSync('sleep', ['0.1']);
    const owned = Number(readFileSync(pidfile, 'utf8'));
    started.push(owned);
    const result = sabeel(root, env, 'free-emulator-ports');
    expect(result.stdout).toContain(`stopping 1 orphaned functions runtime(s): ${orphan}`);
    expect(result.status).toBe(0);
    execFileSync('sleep', ['0.2']);
    expect(alive(orphan)).toBe(false);
    expect(alive(elsewhere)).toBe(true);
    expect(alive(owned)).toBe(true);
  });
});

describe('sabeel-ci jdk21', () => {
  // A PATH with sed and no java, so the machine's own JDKs stay out of it.
  const bare = () => {
    const directory = scratch('ci-tools-path-');
    execFileSync('ln', ['-s', execFileSync('sh', ['-c', 'command -v sed'], { encoding: 'utf8' }).trim(), join(directory, 'sed')]);
    return directory;
  };
  const bash = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
  const jdk21 = (env) => spawnSync(bash, [join(scripts, 'jdk21.sh')], { env: { HOME: scratch('ci-tools-home-'), PATH: bare(), ...env }, encoding: 'utf8' });

  it('prints the first JDK 21 or later it finds: SABEEL_JDK21_HOME, then JAVA_HOME, then the java on PATH', () => {
    const newer = jdk('21.0.5');
    const older = jdk('17.0.9');
    expect(jdk21({ SABEEL_JDK21_HOME: newer, JAVA_HOME: jdk('22') }).stdout).toBe(`${newer}\n`);
    expect(jdk21({ JAVA_HOME: newer }).stdout).toBe(`${newer}\n`);
    expect(jdk21({ JAVA_HOME: older, PATH: `${join(newer, 'bin')}:${bare()}` }).stdout).toBe(`${newer}\n`);
  });

  it('refuses a SABEEL_JDK21_HOME that is not a JDK 21 rather than looking further', () => {
    const result = jdk21({ SABEEL_JDK21_HOME: jdk('17.0.9'), JAVA_HOME: jdk('21.0.5') });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SABEEL_JDK21_HOME is .*, which is not the home of a JDK 21 or later \(Java 17\)/);
  });

  it.skipIf(process.platform !== 'linux')('says where it looked when there is none', () => {
    const result = jdk21({ JAVA_HOME: jdk('1.8.0_392') });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/No JDK 21 or later found[\s\S]*JAVA_HOME: Java 8\n[\s\S]*Set SABEEL_JDK21_HOME/);
  });
});

describe('sabeel-ci emulator', () => {
  /** An Android SDK whose emulator logs how it was called and answers -accel-check with `accel`. */
  function sdk(accel) {
    const home = scratch('ci-tools-sdk-');
    tool(join(home, 'emulator'), 'emulator', `[ "$1" = -accel-check ] && { printf '%s\\n' "${accel}"; exit 0; }
echo "emulator $*"`);
    return home;
  }
  const emulator = (env, ...args) => spawnSync('bash', [join(scripts, 'emulator.sh'), ...args],
    { env: { ...process.env, SABEEL_AVD: `ci_tools_test_${process.pid}`, ...env }, encoding: 'utf8' });

  it('boots the AVD headless, in software only on a host without KVM', () => {
    const fast = emulator({ ANDROID_HOME: sdk('accel:\n0\nKVM (version 12) is installed and usable.') }, 'headless');
    expect(fast.stdout).toBe(`emulator -avd ci_tools_test_${process.pid} -no-window -no-boot-anim -gpu swiftshader_indirect -no-snapshot\n`);
    const slow = emulator({ ANDROID_HOME: sdk('accel:\n3\nKVM is not installed on this machine (/dev/kvm is missing).') }, 'window');
    expect(slow.stdout).toBe(`emulator -avd ci_tools_test_${process.pid} -gpu host -no-snapshot -accel off\n`);
    expect(slow.stderr).toContain('Falling back to software CPU (-accel off)');
  });

  it('refuses to boot an AVD already running, and names who runs it', () => {
    const avd = `ci_tools_test_${process.pid}`;
    const pid = Number(execFileSync('bash', ['-c', `cd "$1" && { exec -a qemu-system-x86_64 "$2" -e 'setTimeout(() => {}, 60000)' -- -avd ${avd} >/dev/null 2>&1 & } && echo $!`,
      '_', scratch('ci-tools-session-'), process.execPath], { encoding: 'utf8' }));
    started.push(pid);
    const result = emulator({ ANDROID_HOME: sdk('accel:\n0') }, 'headless');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(new RegExp(`${avd} is already running: pid ${pid}, started .* in /.*ci-tools-session-`));
  });

  it('says what is missing rather than starting nothing', () => {
    expect(emulator({ ANDROID_HOME: scratch('ci-tools-nosdk-') }, 'headless').stderr).toMatch(/No Android emulator at .*: set ANDROID_HOME/);
    const wrong = emulator({}, 'boot');
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('usage: sabeel-ci emulator headless|window|list|shot <name>|kill [serial]');
    expect(emulator({}, 'shot', '../escape').status).toBe(2);
  });
});

const PLACEHOLDERS = 'SENTRY_DSN=disabled\nAPNS_KEY=unused-in-emulator\n';

describe('sabeel-ci emulator-secrets', () => {
  it("writes functions/.secret.local from ci.emulatorSecrets, over the app's own copy", () => {
    const { root, env } = app();
    writeFileSync(join(root, 'functions/.secret.local'), 'SENTRY_DSN=stale\n');
    const result = sabeel(root, env, 'emulator-secrets');
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'functions/.secret.local'), 'utf8')).toBe(PLACEHOLDERS);
    expect(sabeel(root, env, 'emulator-secrets', 'extra').status).toBe(1);
  });
});

describe('sabeel-ci test-emulator', () => {
  it('runs the rules pass without the Functions emulator, then the functions pass inside the wrapper', () => {
    const { root, env, log } = app();
    const result = sabeel(root, env, 'test-emulator');
    expect(readFileSync(join(root, 'functions/.secret.local'), 'utf8')).toBe(PLACEHOLDERS);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(log('fake.log')).toEqual([
      'npm run build',
      `firebase emulators:exec --project demo-sabeel-example --only firestore,auth,storage npm run test:emulator:rules -w functions JAVA_HOME=${env.SABEEL_JDK21_HOME} FUNCTIONS_DISCOVERY_TIMEOUT=120`,
      'with-store around: firebase emulators:exec --project demo-sabeel-example --only firestore,auth,functions,storage npm run test:emulator:functions -w functions',
      `firebase emulators:exec --project demo-sabeel-example --only firestore,auth,functions,storage npm run test:emulator:functions -w functions JAVA_HOME=${env.SABEEL_JDK21_HOME} FUNCTIONS_DISCOVERY_TIMEOUT=120`,
    ]);
    expect(result.stdout.match(/emulator ports clear/g)).toHaveLength(2);
  });

  it('runs the functions pass when the rules pass fails, and fails naming both', () => {
    const { root, env, log } = app();
    const result = sabeel(root, { ...env, RULES_EXIT: '3' }, 'test-emulator');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('test-emulator failed: rules pass exit 3, functions pass exit 0\n');
    expect(log('fake.log').filter((line) => line.startsWith('firebase'))).toHaveLength(2);
  });

  it('starts nothing without a JDK 21', () => {
    const { root, env, log } = app();
    const result = sabeel(root, { ...env, SABEEL_JDK21_HOME: jdk('17.0.9') }, 'test-emulator');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not the home of a JDK 21[\s\S]*the emulators cannot start without a JDK 21/);
    expect(log('fake.log')).toEqual([]);
  });
});

describe('sabeel-ci emulators', () => {
  it('starts every emulator firebase.json runs, inside the wrapper, and names the UI', () => {
    const { root, env, log } = app();
    const result = sabeel(root, env, 'emulators');
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'functions/.secret.local'), 'utf8')).toBe(PLACEHOLDERS);
    expect(result.stdout).toContain('Emulator UI: http://127.0.0.1:61904');
    expect(log('fake.log')).toEqual([
      'npm run build',
      'with-store around: firebase emulators:start --project demo-sabeel-example --only firestore,auth,functions,storage',
      `firebase emulators:start --project demo-sabeel-example --only firestore,auth,functions,storage JAVA_HOME=${env.SABEEL_JDK21_HOME} FUNCTIONS_DISCOVERY_TIMEOUT=120`,
    ]);
  });

  it("gives a Functions worker 120 s to load, or the caller's own FUNCTIONS_DISCOVERY_TIMEOUT", () => {
    const { root, env, log } = app();
    expect(sabeel(root, { ...env, FUNCTIONS_DISCOVERY_TIMEOUT: '300' }, 'emulators').status).toBe(0);
    expect(log('fake.log').at(-1)).toMatch(/^firebase emulators:start .* FUNCTIONS_DISCOVERY_TIMEOUT=300$/);
    expect(sabeel(root, { ...env, FUNCTIONS_DISCOVERY_TIMEOUT: '300' }, 'test-emulator').status).toBe(0);
    expect(log('fake.log').filter((line) => line.startsWith('firebase emulators:exec')).map((line) => line.split(' ').at(-1)))
      .toEqual(['FUNCTIONS_DISCOVERY_TIMEOUT=300', 'FUNCTIONS_DISCOVERY_TIMEOUT=300']);
  });

  it('stops the emulators when sabeel-ci alone is sent SIGTERM', async () => {
    const { root, env, log } = app();
    const pidfile = join(root, 'firebase.pid');
    const child = spawn(process.execPath, [bin, 'emulators'], { cwd: root, env: { ...env, FIREBASE_PIDFILE: pidfile }, stdio: 'ignore' });
    for (let i = 0; i < 100 && !existsSync(pidfile); i += 1) await new Promise((done) => setTimeout(done, 100));
    const firebase = Number(readFileSync(pidfile, 'utf8'));
    started.push(firebase);
    const exit = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
    child.kill('SIGTERM');
    expect(await exit).toEqual({ code: 143, signal: null });
    expect(log('fake.log')).toContain('firebase got TERM');
    expect(alive(firebase)).toBe(false);
  });
});
