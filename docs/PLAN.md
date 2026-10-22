# Plan: one set of CI and support tools for the three apps

LMS, Kanban and Time Tracker each carried their own copy of the same CI,
release and device tooling: eleven scripts, six workflows and their tests
identical across all three and kept so by hand, and a dozen more tools that had
drifted apart. This repository is the one copy, and the apps change where they
differed only by accident. When every app has migrated, this file goes.

## How an app uses it

- `@sabeel-institute/ci-tools` is a dev dependency pinned to a commit
  (`github:Sabeel-Institute/ci-tools#<sha>`); `package-lock.json` is the one
  record of which commit. Locally: `npx sabeel-ci <command>`.
- In CI every job first clones this repository at the commit the lockfile pins,
  refuses a commit that is not on this repository's `main` (reviewed, merged by
  the owner), installs its runtime dependencies with `--ignore-scripts`, and puts
  `sabeel-ci` on the PATH. Jobs that run before `npm ci`, or never run it (the
  release jobs, the device check), need that; using it everywhere keeps one way.
- The release jobs keep their rule that validators come from `main`, never from
  the build being released: the pin they read is main's.
- `ci-tools.json` at the app's root holds what genuinely differs between the
  apps. Every key is declared in `lib/config.mjs`; an unknown key is an error.
- Shared workflows are templates here (`workflows/`), rendered into the app's
  `.github/workflows/` by `sabeel-ci workflows`; `check-app` fails CI on any
  drift. The workflow files stay in each app, so a change to one shows in that
  app's pull request and GitHub's environments, OIDC claims and rulesets see
  nothing new. Dependabot moves the actions here, in the templates; an app
  takes them with its next pin.

## Where it stands

Merged here: every tool the apps kept identical, and the drifted ones as one
copy each: the CI, CodeQL, Android, Publish Android, Web, Deploy Web, Deploy
Functions, pre-merge and iOS workflows; builds and their checks (`build-info`,
`build-web`, `build-aab`, `check-version`, `deploy-notes`,
`check-text-sources`, `preflight-metro`); releases (`release`, `publish-play`,
`check-ios-config`, `build-ios`, `testflight-check`); push (`check-push`,
`check-web-push`, `send-test-push`); emulators (`emulators`, `test-emulator`,
`free-emulator-ports`, `ports`, `jdk21`, `emulator`); `check-app`, which holds
what the apps' copies of these tests checked of each app.

Also merged: `native-e2e` and `native.yml`, with the apps' `nativeE2e`
test; one Android keystore variable, `SABEEL_KEYSTORE_PROPERTIES`.

## Migrating an app

One pull request per app, with its own CI green and `npx sabeel-ci check-app`
passing.

### Every app

- **The pin and the settings.** `npm install --save-dev
  github:Sabeel-Institute/ci-tools#<sha>`; `ci-tools.json` (values below);
  `npx sabeel-ci workflows`; the app's copies of every merged script and of the
  tests that moved here deleted, and every caller and document pointing at
  `sabeel-ci`.
- **The CI contract.** npm scripts `lint`, `typecheck`, `test`,
  `test:emulator` and each of `ci.browserSuites`; screenshots under `shots/`.
  `.github/dependabot.yml` has no `github-actions` entry.
- **Builds.** `prepare` ends `&& sabeel-ci build-info`; `build:aab`,
  `check:version` and `check:text` run `sabeel-ci build-aab`, `check-version`
  and `check-text-sources`, and `lint` runs the last two. In `app/`:
  `web:export` is `sabeel-ci build-web`; `start` and `android` begin
  `sabeel-ci build-info && sabeel-ci preflight-metro &&`. `.gitignore`
  covers `app/src/build-info.ts`, and the sign-in label reads it.
- **The deploy log.** `docs/PHASE_STATUS.md` has a `## Deploy log`, newest
  first, one `### <YYYY-MM-DD> — <summary> — vX.Y.Z` entry per release,
  written with the version bump; one for the current version.
- **The version, written once.** `app/app.json`'s `expo.version`;
  `build.gradle` derives `versionCode computedVersionCode` and `versionName
  expoVersion`, and refuses a code above Play's 2100000000 (major at most
  2100, minor and patch at most 999); app.json states no
  `android.versionCode`; `ios.buildNumber` is the versionCode, as a string.
- **Releases.** `sabeel-ci release X.Y.Z --notes <entry>` opens the release
  pull request; `--ship` on main after the owner merges it. TestFlight takes
  only the iOS workflow's build of the commit tagged `v<version>` (`gh workflow
  run ios.yml --ref vX.Y.Z -f testflight=true`), once per version; nothing
  uploads from a Mac. `PLAY_KEY` names the Play key file. `publish:play`,
  `publish-play.mjs` and the app's release script go. `check:ios` and
  `build:ios` run `sabeel-ci check-ios-config` and `build-ios`; `.gitignore`
  covers `build/` and `app/.env.sentry-build-plugin`.
- **Push.** `functions/src/fcm.ts` exports `DEAD_TOKEN_CODES` (moved from
  `messaging.ts`) and `fcmMessage(message)` without a token;
  `functions/src/apns.ts` takes `sendToApns(sends, credentials)`, a message
  per send; a new `functions/src/testPush.ts` with its unit test (README,
  "Push from the app's own code"); `check:push` and `check:web-push` run
  `sabeel-ci`; the APNs key for a test push is `~/.apns/AuthKey_<id>.p8`.
- **Emulators.** `test:emulator`, `emulators` and `emulators:free` run
  `sabeel-ci test-emulator`, `emulators` and `free-emulator-ports`; the
  functions workspace's passes are `test:emulator:rules` and
  `test:emulator:functions`; scripts read ports from `ports(config(root))` or
  `sabeel-ci ports <name>`, JDK 21 from `sabeel-ci jdk21`, the project from
  `config(root).emulators.project`, and state no port of the block, comments
  included. Local settings are `SABEEL_AVD`, `SABEEL_JDK21_HOME`,
  `SABEEL_STOP_GRADLE`.
- **The dev sign-in row** is headed "Dev sign-in (emulator only)", testID
  `dev-sign-in`.
- **The native flows.** `native.seed` names the app's seed script (LMS
  `scripts/seed-emulator-world.mjs`, Kanban `scripts/seed-dev.mjs`, TT
  `scripts/seed-native.mjs`); LMS and Kanban set `native.seedWeb`; LMS sets
  `native.reversePorts: ["s3"]`. Every flow names `appId: ${APP_ID}`.
- **Release signing.** `build.gradle` reads
  `System.getenv('SABEEL_KEYSTORE_PROPERTIES') ?:
  "${System.getProperty('user.home')}/.config/<app>/keystore.properties"`
  and fails closed without it (LMS `sabeel-lms`, TT `sabeel-time-tracker`,
  Kanban `sabeel-kanban`; Kanban's release build stops falling back to the
  debug key, and its local `app/android/keystore.properties` moves to
  `~/.config/sabeel-kanban/`). Local overrides named
  `SABEEL_LMS_KEYSTORE_PROPERTIES` or `SABEEL_TT_KEYSTORE_PROPERTIES` take
  the one name.

### LMS

`ci-tools.json`:

```json
{
  "name": "lms",
  "ci": {
    "browserSuites": ["test:screens", "test:e2e"],
    "emulatorSecrets": { "SENTRY_DSN": "disabled", "R2_READ_KEY_ID": "unused-in-emulator", "R2_READ_SECRET": "unused-in-emulator", "R2_WRITE_KEY_ID": "unused-in-emulator", "R2_WRITE_SECRET": "unused-in-emulator", "APNS_KEY": "unused-in-emulator" },
    "knip": true, "ffmpeg": true, "mediaStore": true
  },
  "build": { "sentryDsnVariable": "EXPO_PUBLIC_SENTRY_DSN_ANDROID" },
  "ios": { "backgroundPlayback": true },
  "emulators": { "base": 61300, "project": "demo-sabeel-recordings", "extras": { "master": 20, "masterGrpc": 21, "volume": 22, "volumeGrpc": 23, "filer": 24, "filerGrpc": 25, "s3Grpc": 26, "s3": 27 }, "functionsWrapper": ["node", "scripts/with-media-store.mjs"] },
  "native": { "seed": "scripts/seed-emulator-world.mjs", "seedWeb": true, "reversePorts": ["s3"] },
  "release": { "appSigningCertificate": "E8:C3:7E:B6:5E:BA:D0:C9:DF:57:D4:58:68:58:D4:59:F9:7F:A4:7E:FB:5D:28:D3:06:0A:79:E9:11:00:FF:D5" }
}
```

- The version: `build.gradle` takes Time Tracker's computed block (its next
  code is 2002; Play has 39); app.json drops `android.versionCode` and sets
  `ios.buildNumber` to `"2001"`; `BUILD_VERSION_CODE` is computed from the
  version, `appVersion.test.ts` becomes a test against `lib/version.mjs`'s
  `versionCode`, and `set-min-version` takes X.Y.Z.
- The build stamp: `app/src/buildInfo.ts` builds `BUILD_LABEL` from
  `BUILD_INFO`; `EXPO_PUBLIC_COMMIT` goes from `app/package.json`,
  `build-ios.sh` and the docs; `web:export:maps` is `sabeel-ci build-web
  --source-maps`; a `## Deploy log` with a v0.2.1 entry.
- Ports: the media store's S3 moves 61307 → 61327
  (`functions/.env.demo-sabeel-recordings` `MEDIA_S3_ENDPOINT`), the
  walkthrough's web server 61311 → 61310 and the sweep's 61310 → 61311;
  `scripts/lib/media-store.mjs`, `e2e-stack.sh` and `native-e2e.sh` (its `adb
  reverse`) read them from ci-tools; `scripts/lib/project.mjs` goes.
- The sign-in heading is renamed from "Emulator sign-in (dev only)", with the
  staff flow and the tutorial recorder.
- `docs/DEPLOY.md` runs TestFlight with `--ref vX.Y.Z`.

### Kanban

`ci-tools.json`: `name` `kanban`; `ci.browserSuites` `test:screens`,
`test:e2e`, `test:e2e:attachments`, `test:e2e:stats`, `test:e2e:richtext`,
`test:e2e:typing-perf`; `ci.emulatorSecrets` `SENTRY_DSN: disabled`,
`APNS_KEY: unused-in-emulator`; `ci.knip` off until its dead-code findings are
cleared; `build.sentryDsnVariable` `EXPO_PUBLIC_SENTRY_DSN_NATIVE`;
`emulators` `{ "base": 61200, "project": "demo-sabeel-kanban" }`;
`release.appSigningCertificate`: Play's app signing certificate (the owner's
to read from Play Console; not the upload key).

- npm scripts for its six browser suites; its migration end-to-end runs inside
  `test:emulator`; CI's quality job no longer exports the web app (the
  pre-merge web job does).
- `firebase.json` pins `tasks` (61208) and `eventarc` (61209); `dev.sh`,
  `e2e-all.sh` and `dev:web` read their ports from ci-tools.
- `check-web-template` becomes a unit test; the raw BEL byte in
  `packages/shared/test/attachments.test.ts` is written `\u0007`;
  `build.gradle` applies `sentry.gradle` when `app/.env.sentry-build-plugin`
  exists and warns when nothing would upload source maps.
- Push: `DEAD_FCM_CODES` becomes `DEAD_TOKEN_CODES`; `check:apple-push` is
  `check:push -- apple`.
- Releases: `expo-notifications` in `app.json`'s plugins; `ios.buildNumber`
  `"12002"`; `docs/USER-MANUAL.md`'s version line matches app.json; `PLAY_KEY`
  (was `SK_PLAY_KEY`); `publish-apk.sh` and its test go; release APKs are
  arm64-v8a and universal, named `<expo.slug>-<abi>.apk`.

### Time Tracker

`ci-tools.json`: `name` `time-tracker`; `ci.browserSuites` `test:screens`,
`test:e2e`; `ci.emulatorSecrets` `SENTRY_DSN: disabled`, `APNS_KEY:
unused-in-emulator`; `ci.knip` on; `build.sentryDsnVariable`
`EXPO_PUBLIC_SENTRY_DSN`; `emulators` `{ "base": 61000, "project":
"demo-sabeel" }`; `release.appSigningCertificate`
`B1:61:7E:20:81:67:E4:0D:16:4E:38:CB:BA:29:48:7C:96:AE:5A:6F:E4:76:A7:37:17:5A:CC:91:B3:A5:99:6E`.

- Screenshots move from `e2e-shots/` to `shots/`.
- The sign-in heading is renamed from "Dev (emulator) sign-in".
- The deploy log becomes newest-first `###` entries, with one for v0.29.1.
- `firebase.json` moves `eventarc` 61007 → 61009; `scripts/lib/e2e-stack.mjs`
  takes ports, project, JDK and the port sweep from ci-tools.
- `build.gradle` gains LMS's ABI splits with a universal APK;
  `docs/render-manual.py` reads the version from app.json; `ios.buildNumber`
  `"29001"`; `release.mjs` and `releaseOrder.test.ts` go.

## Open decisions for the owner

- Kanban's Play app signing certificate, for `release.appSigningCertificate`.
- Whether `release --ship` builds the Play bundle locally, as Time Tracker's
  flow does, or publishes the bundle CI built and checked on an emulator, as
  LMS 0.2.1 went out.
- One name for the native Sentry DSN variable in every app, which means
  editing each `APP_ENV_LOCAL` secret and its copy in the vault.

