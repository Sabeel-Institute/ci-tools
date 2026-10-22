# Plan: one set of CI and support tools for the three apps

Lms, Kanban and Time Tracker each carried their own copy of the same CI and
release tooling. Eleven scripts, six workflows and their tests were identical
across all three, kept so by hand; a dozen more were the same tool drifted
apart. This repository becomes the one copy, and the apps change where they
differed only by accident.

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
  `.github/workflows/` by `sabeel-ci workflows`; `sabeel-ci workflows --check`
  fails CI on any drift. The workflow files stay in each app, so a change to one
  shows in that app's pull request and GitHub's environments, OIDC claims and
  rulesets see nothing new.

## Stages

1. **The identical tools.** `check-release`, `ci-android-sdk`, `ci-avd`,
   `ci-functions`, `ci-hosting-smoke`, `ci-platform`, `ci-play`, `ci-premerge`,
   `install-maestro`, `ios-sim-build`, `screens-report`, `app/ci-sdk.mjs`; the
   workflows `android`, `android-publish`, `functions-deploy`, `premerge`,
   `web`, `web-deploy`; their tests, rewritten against templates and fixtures.
2. **The drifted tools, merged.** `native-e2e` and `native.yml`; the iOS release
   path (`build-ios.sh`, `check-ios-config`, `testflight-check`,
   `load-build-env.sh`, `ios.yml`); the Android release path (`publish-play`,
   Kanban's `build-aab.sh` gates); push checks (`check-push`, `check-web-push`,
   `send-test-push`); `preflight-metro`, `check-version`, `gen-build-info`,
   `check-text-sources`; emulator control (`emulator.sh`, `emulators.sh`,
   `test-emulator.sh`, `free-emulator-ports.sh`). Done: `ci.yml` and
   `codeql.yml`.

   Kanban's `build-aab.sh` gates); `preflight-metro`, `check-version`,
   `gen-build-info`, `check-text-sources`; emulator control (`emulator.sh`,
   `emulators.sh`, `test-emulator.sh`, `free-emulator-ports.sh`); `codeql.yml`.

   Merged: the push checks. `check-push` asks FCM and both Apple services
   (Kanban's `check-apple-push` is `check-push apple`), `send-test-push` takes
   the destination as `key=value` pairs, and `check-web-push` runs in every
   web build. All three apps keep one project in `.firebaserc`, the same APNs
   key, and web push, so none needs a `ci-tools.json` setting.

   `load-build-env.sh`, `ios.yml`); `publish-play`; push checks (`check-push`,
   `check-web-push`, `send-test-push`); emulator control (`emulator.sh`,
   `emulators.sh`, `test-emulator.sh`, `free-emulator-ports.sh`); `codeql.yml`.
   Merged: build stamping and the checks before a build. `gen-build-info` is
   `build-info`; `check-version`, `check-text-sources`, `preflight-metro` and
   Kanban's `deploy-notes` keep their names; Kanban's `build-aab.sh` gates are
   `build-aab`, with `build-web` beside it, and `ci-platform` builds through
   both. Kanban's `check-web-template` stays in Kanban, as a unit test: it
   holds Kanban's own `app/public/index.html` to its palette, and LMS and TT
   use Expo's generated template.
3. **The apps standardised where they differed by accident** (each in that
   app's migration pull request, with its tests):
   - one Android keystore variable name read by every app's Gradle build
     (`ci-platform` writes both LMS's and TT's names today);
   - the same build hooks under the same names (build info, version check), so
     tools call npm scripts instead of probing for files;
   - one push sender the push tools load from source (README, "Push"): LMS and
     TT give `sendToApns` a message per send, as Kanban's does; Kanban's
     `fcmMessage` stops taking the token, as LMS's and TT's; each app moves
     `DEAD_TOKEN_CODES` from `messaging.ts` to `fcm.ts` and exports it (Kanban's
     is `DEAD_FCM_CODES`), and adds `functions/src/testPush.ts` with a unit
     test; the APNs key for a test push is `~/.apns/AuthKey_<id>.p8` (LMS
     and TT look under `~/.config/sabeel-lms/` and
     `~/.config/sabeel-time-tracker/` today); npm scripts `check:push` and
     `check:web-push` in every app;

   - one build stamp: every label reads `app/src/build-info.ts` from
     `build-info`, LMS's included (it reads `EXPO_PUBLIC_COMMIT` today, which
     never marks a dirty build);
   - one deploy log: `docs/PHASE_STATUS.md`, one entry per release headed
     `### <date> — <summary> — v<version>` and written with the version bump
     (Kanban's form; TT's log is dated bullets, LMS has none);
   - the web push check under one name, so `ci-platform web` calls it instead
     of probing for `scripts/check-web-push.mjs`;
   - one emulator port layout per base (+0 Firestore … +6 logging, then fixed
     offsets for storage, tasks, eventarc, web dev servers and the media
     store), declared once in `ci-tools.json`;
   - one seed hook for the native flows (today `seed-emulator-world`,
     `seed-native`, `seed-dev`);
   - one heading for the emulator-only sign-in row, "Dev sign-in (emulator
     only)" with testID `dev-sign-in`, which `check-release` must find
     absent: Kanban has it; LMS ("Emulator sign-in (dev only)", also in its
     staff flow and tutorial recorder) and TT ("Dev (emulator) sign-in")
     rename theirs;
   - the CI contract: npm scripts `lint`, `typecheck`, `test`,
     `test:emulator`, `test:screens` and the other browser suites (Kanban
     names its six; LMS's become plain npm scripts), screenshots under
     `shots/` (TT moves off `e2e-shots/`), Kanban's migration end-to-end
     run inside its `test:emulator`, Kanban's web export left to the
     pre-merge web job;
   - Kanban clears its dead-code findings and turns on `ci.knip` (dozens of
     unused exports and types today; until then `ci.knip` is off for it).
4. **Each app migrates** in one pull request: the pin, `ci-tools.json`, rendered
   workflows, its copies deleted, its docs pointing here.

App-specific tools stay in the apps: `screens-e2e`, `web-e2e`, seeds,
migrations, backfills, LMS's media store.

## Build stamping and checks: the apps' part

Every app, at migration:

- `ci-tools.json`: `build.sentryDsnVariable`, the variable its native Sentry
  setup reads (LMS `EXPO_PUBLIC_SENTRY_DSN_ANDROID`, Kanban
  `EXPO_PUBLIC_SENTRY_DSN_NATIVE`, TT `EXPO_PUBLIC_SENTRY_DSN`).
- `package.json`: `prepare` ends `&& sabeel-ci build-info`; `build:aab`,
  `check:version` and `check:text` run `sabeel-ci build-aab`, `check-version`
  and `check-text-sources`, and `lint` runs the last two.
- `app/package.json`: `web:export` is `sabeel-ci build-web`; `start` and
  `android` begin `sabeel-ci build-info && sabeel-ci preflight-metro &&`.
- Its copies of the merged scripts deleted, and every caller and document
  pointing at `sabeel-ci`.

And each its own:

- LMS: `.gitignore` covers `app/src/build-info.ts`; `app/src/buildInfo.ts`
  builds `BUILD_LABEL` from `BUILD_INFO`; `web:export:maps` is `sabeel-ci
  build-web --source-maps`; `EXPO_PUBLIC_COMMIT` goes from `app/package.json`,
  `build-ios.sh` and the docs; a deploy-log entry for the current version.
- Kanban: `check-web-template` becomes a unit test; the raw BEL in
  `packages/shared/test/attachments.test.ts` becomes `\u0007`; `build.gradle`
  applies `sentry.gradle` when `app/.env.sentry-build-plugin` exists as well
  as when `SENTRY_AUTH_TOKEN` is set, and warns when neither is, which
  `build-aab.sh` did by sourcing `load-build-env.sh` and warning itself.
- TT: a deploy-log entry heading for the current version, and `release.mjs`
  writing its notes into the deploy log in the release pull request.

## Assertions waiting for their templates

The apps' copies of these tests also checked workflows that are not templates
yet. Each comes back here with its template:

- `ios.yml`: built on main pushes, TestFlight only on a manual run with
  `testflight`; release-build environment for both jobs; the owner check first.
- `native.yml`, with `nativeE2e`; `releaseAccess` over every template.
