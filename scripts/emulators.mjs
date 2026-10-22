import { config } from '../lib/config.mjs';
import { ports } from '../lib/ports.mjs';
import { emulatorEnv, freePorts, main, run, startable } from './lib/firebase-emulators.mjs';

/**
 * The app's emulators, left running for a dev server, a seed or a device pass:
 *
 *   sabeel-ci emulators     # npm run emulators
 *
 * Every emulator firebase.json runs, under the app's demo project, inside the
 * app's `emulators.functionsWrapper` when it has one (LMS's media store). The
 * ports are freed first and the functions built: the Functions emulator loads
 * the built bundle, so without the build it serves stale triggers, or none,
 * and a user who signs in is never provisioned. Data is discarded when they
 * stop; Ctrl-C, or stopping this process, stops them.
 */
await main(async () => {
  const settings = config();
  const { project, functionsWrapper = [] } = settings.emulators;
  const only = startable();
  const env = emulatorEnv();
  freePorts();
  if (await run(['npm', 'run', 'build'])) throw new Error('npm run build failed; the emulators were not started');
  console.log(`\nEmulator UI: http://127.0.0.1:${ports(settings).ui}\nData is discarded when they stop. Ctrl-C to quit.\n`);
  process.exit(await run([...functionsWrapper, 'firebase', 'emulators:start', '--project', project, '--only', only.join(',')], { env }));
});
