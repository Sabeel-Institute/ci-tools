import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Did the exported web bundle get the VAPID key?
 *
 *   sabeel-ci check-web-push      (after `npm run web:export -w @sabeel/app`)
 *
 * `sabeel-ci ci-platform web` runs it on every release build, between the
 * export and the artifact, so what it checks is what ships.
 *
 * A web build without its VAPID public key fails nowhere: the client is inert
 * by design, the build succeeds, the site deploys, and every browser quietly
 * reports that it cannot receive notifications. Every app commits the public
 * key as VAPID_PUBLIC_KEY in app/src/firebase-config.ts, which `check-app`
 * holds to a P-256 key, but the source can hold it while the bundle lacks it.
 * So this reads the scripts app/dist-web/index.html loads and requires a VAPID
 * key in them, other than the sample key the Firebase SDK ships, that is a
 * real P-256 public key: 65 bytes, uncompressed, a point on the curve, which a
 * truncated paste, the private half or the sender id are not, and which a
 * browser refuses to subscribe with. With no key the minifier can prove
 * `canRequestPush()` false and fold `enablePush` to a bare
 * `return 'unavailable'`, deleting the permission path; that fold fails too.
 *
 * It reads the artifact on disk, so run it right after the release export and
 * before the deploy. `dist-web` is shared: an e2e or sweep run rebuilds it,
 * and a check at another moment answers about a different bundle.
 */

/** The Firebase SDK's own sample key; finding only that means ours is absent. */
export const SDK_DEFAULT = 'BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4';

/** Whether `key` (base64url) is an uncompressed P-256 public key: 0x04, then a point on the curve. */
export function isP256Point(key) {
  const raw = Buffer.from(key, 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
    return true;
  } catch {
    return false;
  }
}

const fail = (message) => {
  throw new Error(`check-web-push: ${message}`);
};

/** The export at `site` carries a VAPID key and the permission path: a line saying so, or an Error saying what is wrong. */
export function checkWebPush(site = 'app/dist-web') {
  const index = join(site, 'index.html');
  if (!existsSync(index)) fail(`no export at ${site}\n  build it first: npm run web:export -w @sabeel/app`);
  const scripts = [...readFileSync(index, 'utf8').matchAll(/<script\b[^>]*\bsrc="\/?(_expo\/static\/js\/web\/[^"?#]+\.js)"/g)].map((match) => match[1]);
  if (!scripts.length) fail(`${index} loads no script from _expo/static/js/web`);
  const bundle = scripts.map((path) => {
    if (!existsSync(join(site, path))) fail(`${index} loads ${path}, which is not in the export`);
    return readFileSync(join(site, path), 'utf8');
  }).join('\n');

  // 65 bytes are 87 base64url characters, and a leading 0x04 makes the first a B.
  const keys = [...new Set([...bundle.matchAll(/["'](B[A-Za-z0-9_-]{86})["']/g)].map((match) => match[1]))]
    .filter((key) => key !== SDK_DEFAULT);
  if (!keys.length) {
    fail('no VAPID key in the exported bundle.\n'
      + '  Web push will be inert: every browser will report that it cannot receive\n'
      + '  notifications, and nothing else will look wrong.\n'
      + '  The key is VAPID_PUBLIC_KEY in app/src/firebase-config.ts (the public key of\n'
      + '  the Web Push certificate, Firebase console, Cloud Messaging); check that the\n'
      + '  app\'s web push module imports it, then export again.');
  }
  if (!keys.some(isP256Point)) {
    fail('the VAPID key in the exported bundle is not a P-256 public key: truncated,\n'
      + '  or copied from the wrong field. Browsers refuse to subscribe with it, so web\n'
      + '  push would register no device. Copy the public key of the Web Push\n'
      + '  certificate (Firebase console, Cloud Messaging) into VAPID_PUBLIC_KEY in\n'
      + '  app/src/firebase-config.ts again.');
  }
  // Unreachable once a key is present; here because it is the symptom people see.
  if (/enablePush=async function\([^)]*\)\{return['"]unavailable['"]/.test(bundle)) {
    fail('enablePush was folded to a bare "unavailable": the permission path is not in the bundle.');
  }
  return 'check-web-push: ok, a VAPID public key is in the bundle and the permission path is intact';
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    console.log(checkWebPush());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
