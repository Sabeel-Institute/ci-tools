import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { versionProblems } from '../lib/version.mjs';
import { dsnProblem } from './lib/sentry.mjs';

/**
 * The iOS configuration, spread across files that must agree.
 *
 *   sabeel-ci check-ios-config     # also the first gate of sabeel-ci build-ios
 *
 * app/GoogleService-Info.plist comes from the Firebase console, app/app.json is
 * written by hand, and app/ios/ is regenerated from it on every prebuild, so
 * nothing else stops them drifting. Each check is a failure that otherwise
 * surfaces only at upload, at App Review or at runtime, long after the build
 * that caused it succeeded.
 *
 * Problems fail it. Warnings are for what is wrong only on the machine that
 * archives: the check runs from any checkout, and `build-ios` refuses to
 * archive without the Sentry token.
 */

/** <key>NAME</key><string>VALUE</string> pairs; the file is a flat dictionary. */
export function plistStrings(xml) {
  const out = {};
  for (const m of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) out[m[1]] = m[2];
  return out;
}

export function iosConfigProblems(root = '.', env = process.env) {
  const problems = [];
  const warnings = [];
  const fail = (message) => problems.push(message);
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const settings = config(root);
  const app = JSON.parse(read('app/app.json')).expo;
  const ios = app.ios ?? {};
  const plugins = app.plugins ?? [];
  const options = (name) => plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === name)?.[1];

  /** A plugin registered as a plain string, never as [name, options]. */
  const bare = (names, why) => {
    if (names.some((name) => plugins.includes(name))) return;
    const configured = plugins.find((plugin) => Array.isArray(plugin) && names.includes(plugin[0]));
    fail(configured ? `"${configured[0]}" is configured with options. ${why.options}` : `app.json plugins is missing "${names[0]}". ${why.missing}`);
  };

  if (!app.platforms?.includes('ios')) fail('expo.platforms does not include "ios".');

  // 1. The plist. Without it prebuild fails late, naming a path rather than
  //    the console step that was skipped.
  if (!existsSync(join(root, 'app/GoogleService-Info.plist'))) {
    fail(
      'app/GoogleService-Info.plist is missing.\n'
        + `    Download it from the Firebase console: Project settings -> the iOS app (${ios.bundleIdentifier}).\n`
        + '    An app that does not commit it has CI write it from the GOOGLE_SERVICE_INFO_PLIST secret.',
    );
  } else {
    const plist = plistStrings(read('app/GoogleService-Info.plist'));

    // 2. Bundle id. A mismatch makes Google sign-in fail in ways that look like
    //    a network or credential problem.
    if (!ios.bundleIdentifier) {
      fail('app.json has no expo.ios.bundleIdentifier.');
    } else if (plist.BUNDLE_ID !== ios.bundleIdentifier) {
      fail(
        `bundle id mismatch: app.json says "${ios.bundleIdentifier}", the plist says "${plist.BUNDLE_ID}".\n`
          + '    Firebase cannot rename a bundle id: register a new iOS app on the right one,\n'
          + '    download its plist, and delete the wrong registration.',
      );
    }

    // 3. The project. A plist from another project points the phone at another
    //    database, and nothing errors: it simply finds no data. The project is
    //    the one .firebaserc deploys to, and the one Android's config names.
    let projects = [];
    try {
      projects = [...new Set(Object.values(JSON.parse(read('.firebaserc')).projects ?? {}))];
    } catch (error) {
      fail(`cannot read the Firebase project from .firebaserc: ${error.message}`);
    }
    if (projects.length && !projects.includes(plist.PROJECT_ID)) {
      fail(`the plist is for Firebase project "${plist.PROJECT_ID}", but .firebaserc names ${projects.map((p) => `"${p}"`).join(', ')}.`);
    }
    if (existsSync(join(root, 'app/google-services.json'))) {
      const android = JSON.parse(read('app/google-services.json')).project_info?.project_id;
      if (android !== plist.PROJECT_ID) {
        fail(
          `Firebase project mismatch: the plist is for "${plist.PROJECT_ID}", google-services.json for "${android}".\n`
            + '    iOS and Android are two apps in ONE project.',
        );
      }
    }

    // 4. Google Sign-In's URL scheme. Without it Safari opens, an account is
    //    chosen, and the app never regains focus, with no error at all.
    //    Registered bare, the plugin derives the scheme from the plist's
    //    REVERSED_CLIENT_ID; given options it demands a hand copy in app.json,
    //    which can drift from the file it came from and is validated on every
    //    platform, so a wrong one breaks the web export too.
    bare(['@react-native-google-signin/google-signin'], {
      options: 'Register it bare, so the URL scheme comes from the plist, not a hand copy.',
      missing: 'Native Google sign-in has no URL scheme without it.',
    });
    if (!plist.REVERSED_CLIENT_ID) {
      fail(
        'the plist has no REVERSED_CLIENT_ID, so no Google Sign-In URL scheme can be derived.\n'
          + '    Enable Google sign-in in Firebase Authentication, then re-download the plist.',
      );
    }
  }

  // 5. Sentry, which makes an iOS crash readable. Bare, because an authToken
  //    option would be written into the app package, and the org and project
  //    are ci-tools.json's: build-ios exports SENTRY_ORG and SENTRY_PROJECT
  //    from it, and SENTRY_AUTH_TOKEN comes from the build environment
  //    (app/.env.sentry-build-plugin). Both spellings are the same plugin.
  bare(['@sentry/react-native', '@sentry/react-native/expo'], {
    options: "Register it bare; build-ios gives it ci-tools.json's org and project, and the token from the build environment.",
    missing: 'No dSYM or source-map upload is wired, so iOS crashes arrive as raw addresses.',
  });

  // 6. Push. expo-notifications' plugin writes the aps-environment
  //    entitlement. Without it the build succeeds, the permission prompt still
  //    appears, and no push token ever arrives. Android cannot catch this: its
  //    native project is committed and never prebuilt.
  bare(['expo-notifications'], {
    options: 'Its defaults are what the app needs; remove the options.',
    missing: 'Without it the app has no aps-environment entitlement and never gets a push token.',
  });

  // 7. Playback with the phone locked. expo-video writes UIBackgroundModes
  //    audio from this option at prebuild; without it playback stops when the
  //    phone locks, and the build is otherwise perfect.
  if (settings.ios?.backgroundPlayback && options('expo-video')?.supportsBackgroundPlayback !== true) {
    fail(
      'expo-video is not registered with supportsBackgroundPlayback: true (ci-tools.json ios.backgroundPlayback).\n'
        + '    Without it prebuild writes no UIBackgroundModes audio, and playback stops when the phone locks.',
    );
  }

  // 8. Export compliance. Absent, every upload waits on a manual questionnaire
  //    in App Store Connect before a tester can see it.
  if (ios.config?.usesNonExemptEncryption !== false) {
    fail(
      'expo.ios.config.usesNonExemptEncryption must be explicitly false.\n'
        + '    Otherwise App Store Connect holds each build for an export-compliance answer.',
    );
  }

  // 9. ONE version. ios.version would override expo.version and show Apple a
  //    number Android and the web do not have. Where build.gradle states
  //    versionName rather than deriving it from app.json, the two must agree.
  if (ios.version) fail(`expo.ios.version is set ("${ios.version}"); remove it. expo.version is the one version.`);
  problems.push(...versionProblems(app.version));
  if (existsSync(join(root, 'app/android/app/build.gradle'))) {
    const stated = /versionName\s+["']([^"']+)["']/.exec(read('app/android/app/build.gradle'))?.[1];
    if (stated !== undefined && stated !== app.version) {
      fail(`app.json says version ${app.version}, app/android/app/build.gradle says ${stated}. Bump both.`);
    }
  }

  // 10. The build number, which Apple takes once per version, each higher than
  //     the last. It must be a whole number to be raised at all.
  if (!/^[1-9]\d*$/.test(ios.buildNumber ?? '')) {
    fail(`expo.ios.buildNumber must be a whole number as a string; got ${JSON.stringify(ios.buildNumber)}.`);
  }

  // 11. The icon: 1024x1024 and no alpha channel. Apple rejects transparency
  //     at UPLOAD, after the archive is built and signed. Byte 25 of the PNG
  //     header is the colour type; 4 and 6 carry alpha.
  const icon = join('app', (app.icon ?? './assets/icon.png').replace(/^\.\//, ''));
  if (!existsSync(join(root, icon))) {
    fail(`expo.icon points at ${icon}, which does not exist.`);
  } else {
    const png = readFileSync(join(root, icon));
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      fail(`${icon} is not a PNG.`);
    } else {
      if (png[25] === 4 || png[25] === 6) {
        fail(
          `${icon} has an alpha channel (PNG colour type ${png[25]}); Apple rejects it at upload.\n`
            + `    Flatten it: python3 -c "from PIL import Image; Image.open('${icon}').convert('RGB').save('${icon}')"`,
        );
      }
      const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      if (width !== 1024 || height !== 1024) fail(`${icon} is ${width}x${height}; the App Store icon must be 1024x1024.`);
    }
  }

  // 12. Crash reporting ON. app/.env.local is gitignored, so a fresh clone has
  //     no DSN, and the build that results looks identical and reports nothing.
  const dsn = dsnProblem('native', root);
  if (dsn) fail(dsn);

  // 13. The Sentry token, needed only where the archive is made.
  if (!env.SENTRY_AUTH_TOKEN) {
    warnings.push(
      'SENTRY_AUTH_TOKEN not set in this shell. Harmless anywhere but the machine that\n'
        + '    archives, where build-ios loads it from app/.env.sentry-build-plugin and refuses\n'
        + '    to build without it. It is a Sentry organization token (scope org:ci), and a real secret.',
    );
  }

  // 14. The privacy manifest. Apple rejects an upload without one, by email,
  //     after the archive is built. Expo writes ios/PrivacyInfo.xcprivacy from
  //     this key; absent the key it writes nothing and nothing says so. What
  //     the app collects can only be declared here, and App Store Connect's App
  //     Privacy answers must agree with it.
  const manifest = ios.privacyManifests;
  if (!manifest) {
    fail('app.json has no expo.ios.privacyManifests; Apple rejects the upload without one.');
  } else {
    const types = manifest.NSPrivacyCollectedDataTypes;
    if (!Array.isArray(types) || types.length === 0) fail('expo.ios.privacyManifests declares no NSPrivacyCollectedDataTypes.');
    if (manifest.NSPrivacyTracking !== false) fail('expo.ios.privacyManifests.NSPrivacyTracking must be false: the app does not track.');
    if ((Array.isArray(types) ? types : []).some((type) => type.NSPrivacyCollectedDataTypeTracking !== false)) {
      fail('every collected data type must say NSPrivacyCollectedDataTypeTracking: false.');
    }
  }

  return { problems, warnings, summary: `${ios.bundleIdentifier}, v${app.version} build ${ios.buildNumber}` };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = iosConfigProblems();
  } catch (error) {
    console.error(`iOS config check could not run: ${error.message}`);
    process.exit(2);
  }
  const { problems, warnings, summary } = result;
  if (warnings.length) {
    console.warn('\niOS config warnings (build machine only)\n');
    for (const warning of warnings) console.warn(`  ! ${warning}\n`);
  }
  if (problems.length) {
    console.error('\niOS config check FAILED\n');
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(`iOS config ok (${summary})`);
}
