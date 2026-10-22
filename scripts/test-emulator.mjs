import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config } from '../lib/config.mjs';
import { emulatorEnv, freePorts, main, run, startable } from './lib/firebase-emulators.mjs';

/**
 * The functions workspace's emulator suites, in two passes:
 *
 *   sabeel-ci test-emulator     # npm run test:emulator, locally and in CI
 *
 *   1. `npm run test:emulator:rules -w functions`, against every emulator
 *      firebase.json runs except Functions: the rules tests, and any test that
 *      calls the functions' code directly. With no Functions emulator a write
 *      fires no trigger. One Functions emulator runs every trigger of a run, one
 *      at a time; the rules tests write and wipe thousands of documents, and a
 *      trigger still running when the next test wiped the database held its
 *      locks until the wipe timed out, or deleted a document a later test had
 *      just seeded under a reused id.
 *   2. `npm run test:emulator:functions -w functions`, with the Functions
 *      emulator, inside the app's `emulators.functionsWrapper` when it has one
 *      (LMS's media store): the triggers, callables and blocking functions.
 *
 * Both passes run whatever the first says, and this fails if either did. The
 * ports are freed before each. The functions are built first: the Functions
 * emulator loads the built bundle, not the TypeScript, while the tests run
 * fresh source, so without the build the suite passes against yesterday's
 * triggers and nothing shows it.
 */

/**
 * A resident Gradle daemon holds ~3.7 GB beside the emulators. Reported, and
 * stopped only when SABEEL_STOP_GRADLE=1: `gradlew --stop` stops every
 * checkout's daemons, since they share one registry, including one a sibling
 * session is building with.
 */
function gradle() {
  if (!existsSync('app/android/gradlew')) return;
  if (process.env.SABEEL_STOP_GRADLE === '1') {
    spawnSync('./gradlew', ['--stop'], { cwd: 'app/android', stdio: 'ignore' });
    console.log('Gradle daemons stopped (SABEEL_STOP_GRADLE=1): every checkout\'s, machine-wide.');
  } else if (spawnSync('pgrep', ['-f', 'GradleDaemon'], { stdio: 'ignore' }).status === 0) {
    console.log('note: a Gradle daemon is running (~3.7 GB), shared with every checkout here, so this leaves it.\n'
      + '      If memory is tight and nothing else is building: SABEEL_STOP_GRADLE=1 npm run test:emulator');
  }
}

await main(async () => {
  const { project, functionsWrapper = [] } = config().emulators;
  const all = startable();
  const env = emulatorEnv();
  gradle();
  if (await run(['npm', 'run', 'build'])) throw new Error('npm run build failed; no emulator suite ran');
  const passes = [
    { name: 'rules', only: all.filter((name) => name !== 'functions'), around: [] },
    { name: 'functions', only: all, around: functionsWrapper },
  ];
  const results = [];
  for (const pass of passes) {
    freePorts();
    const status = await run([...pass.around, 'firebase', 'emulators:exec', '--project', project, '--only', pass.only.join(','),
      `npm run test:emulator:${pass.name} -w functions`], { env });
    results.push({ ...pass, status });
  }
  if (results.some(({ status }) => status !== 0)) {
    throw new Error(`test-emulator failed: ${results.map(({ name, status }) => `${name} pass exit ${status}`).join(', ')}`);
  }
});
