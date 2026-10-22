// app/android/gradlew: assembleRelease makes the ABI-split APKs, unless the
// test takes the splits away.
import { mkdirSync, writeFileSync } from 'node:fs';
import { log } from './log.mjs';

log('gradlew');
if (process.argv.includes('assembleRelease') && !process.env.NO_SPLITS) {
  mkdirSync('app/build/outputs/apk/release', { recursive: true });
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'universal']) writeFileSync(`app/build/outputs/apk/release/app-${abi}-release.apk`, abi);
}
