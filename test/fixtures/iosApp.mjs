import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import full from './full.json' with { type: 'json' };

export const BUNDLE_ID = 'com.sabeelinstitute.example';
export const PROJECT = 'example-project';
/** The shape of a Sentry DSN; no such project exists. */
export const DSN = 'https://0123456789abcdef@o0.ingest.example.invalid/0';

/** The first bytes of a PNG: signature, then IHDR's width, height, bit depth and colour type. */
export function pngHeader(width, height, colourType = 2) {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;
  png[25] = colourType;
  return png;
}

export const plist = (values) => '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n'
  + Object.entries(values).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>\n`).join('')
  + '</dict></plist>\n';

export const expo = () => ({
  name: 'Example',
  version: '1.2.3',
  platforms: ['android', 'ios', 'web'],
  icon: './assets/icon.png',
  plugins: [
    '@react-native-google-signin/google-signin',
    '@sentry/react-native',
    'expo-notifications',
    ['expo-video', { supportsBackgroundPlayback: true }],
  ],
  android: { package: BUNDLE_ID },
  ios: {
    bundleIdentifier: BUNDLE_ID,
    buildNumber: '3',
    config: { usesNonExemptEncryption: false },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyCollectedDataTypes: [{ NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeEmailAddress', NSPrivacyCollectedDataTypeTracking: false }],
    },
  },
});

/**
 * An app repository whose iOS configuration passes every check, in a new
 * directory under the system's temporary one. `put` replaces a file; a value
 * that is not a string or Buffer is written as JSON.
 */
export function iosApp(settings = full) {
  const root = mkdtempSync(join(tmpdir(), 'ci-tools-ios-'));
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
  };
  put('ci-tools.json', settings);
  put('.firebaserc', { projects: { default: PROJECT } });
  put('app/app.json', { expo: expo() });
  put('app/GoogleService-Info.plist', plist({ BUNDLE_ID, PROJECT_ID: PROJECT, REVERSED_CLIENT_ID: 'com.googleusercontent.apps.0-example' }));
  put('app/google-services.json', { project_info: { project_id: PROJECT } });
  put('app/assets/icon.png', pngHeader(1024, 1024));
  put('app/.env.local', `EXPO_PUBLIC_SENTRY_DSN_NATIVE=${DSN}\n`);
  put('app/android/app/build.gradle', 'android {\n  defaultConfig {\n    versionCode 1002003\n    versionName "1.2.3"\n  }\n}\n');
  return { root, put };
}
