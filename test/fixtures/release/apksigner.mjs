import { log } from './log.mjs';

if (process.argv[2] !== '--version') {
  log('apksigner');
  console.log(`Signer #1 certificate DN: ${process.env.FAKE_APK_DN ?? 'CN=Sabeel Institute'}`);
  console.log(`Signer #1 certificate SHA-256 digest: ${process.env.FAKE_APK_DIGEST ?? 'ab'.repeat(32)}`);
}
