import { config } from '../lib/config.mjs';
import { SECRET_LOCAL, main, writeEmulatorSecrets } from './lib/firebase-emulators.mjs';

/**
 * functions/.secret.local from ci-tools.json's ci.emulatorSecrets, for an
 * emulator stack the app starts itself (its browser suites):
 *
 *   sabeel-ci emulator-secrets
 *
 * `emulators` and `test-emulator` write it themselves; CI's browser job runs
 * this before the app's suites.
 */
await main(async () => {
  if (process.argv.length > 2) throw new Error('usage: sabeel-ci emulator-secrets');
  writeEmulatorSecrets(config());
  console.log(`${SECRET_LOCAL}: the placeholders ci.emulatorSecrets names`);
});
