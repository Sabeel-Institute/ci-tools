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
   `load-build-env.sh`, `ios.yml`); the Android build (Kanban's `build-aab.sh`
   gates); push checks (`check-push`, `check-web-push`,
   `send-test-push`); `preflight-metro`, `check-version`, `gen-build-info`,
   `check-text-sources`; emulator control (`emulator.sh`, `emulators.sh`,
   `test-emulator.sh`, `free-emulator-ports.sh`); `codeql.yml`.
   Merged: `publish-play` (the three copies, one Play publisher), and the
   release flow, `release`, from the Time Tracker's `release.mjs`, Kanban's
   `publish-apk.sh` and the LMS's recipe in its `docs/DEPLOY.md`. `release`
   calls the build tools by their `sabeel-ci` names (`build-aab`,
   `build-info`, `deploy-notes`), so it runs once those are merged.
3. **The apps standardised where they differed by accident** (each in that
   app's migration pull request, with its tests):
   - one Android keystore variable name read by every app's Gradle build
     (`ci-platform` writes both LMS's and TT's names today);
   - the same build hooks under the same names (build info, version check, web
     push check), so tools call npm scripts instead of probing for files;
   - one emulator port layout per base (+0 Firestore … +6 logging, then fixed
     offsets for storage, tasks, eventarc, web dev servers and the media
     store), declared once in `ci-tools.json`;
   - one seed hook for the native flows (today `seed-emulator-world`,
     `seed-native`, `seed-dev`);
   - one label (and testID) for the emulator-only sign-in row, which
     `check-release` must find absent (four spellings today);
   - the version written once, in `app/app.json`: the LMS's build.gradle
     computes versionCode and versionName from it as Kanban's and the Time
     Tracker's do (its next code is 2002; Play has 39), app.json drops
     `android.versionCode`, and the LMS's update gate computes its own code
     from the version;
   - the iOS build number is the versionCode (`release` writes it), so each
     version goes to TestFlight once, as it goes to Play once;
   - the Play publishing key in `PLAY_KEY` (Kanban's `SK_PLAY_KEY` goes), and
     the certificate Play signs installs with in `release.appSigningCertificate`
     (Kanban's is the Google-generated key; the others' their release key);
   - one release flow, `sabeel-ci release`: a `## Deploy log` section in
     `docs/PHASE_STATUS.md` with `### <date> — <summary> — vX.Y.Z` entries,
     newest first; a manual renderer that reads the version from app.json (the
     Time Tracker's states it); build.gradle's ABI splits with a universal APK
     (the Time Tracker builds twice); APKs named `<expo.slug>-<abi>.apk`,
     arm64-v8a and universal (Kanban attaches four).
4. **Each app migrates** in one pull request: the pin, `ci-tools.json`, rendered
   workflows, its copies deleted, its docs pointing here.

App-specific tools stay in the apps: `screens-e2e`, `web-e2e`, seeds,
migrations, backfills, LMS's media store.

## Assertions waiting for their templates

The apps' copies of these tests also checked workflows that are not templates
yet. Each comes back here with its template:

- `ci.yml`: the fail-closed `build-test` gate over every job, actionlint
  1.7.12 checksum-pinned with shellcheck, the screens report on every sweep
  (`if: always()`, kept as the `screens-report` artifact).
- `codeql.yml`: `javascript-typescript`, `build-mode: none`, scheduled, no
  secrets, no `pull_request_target`.
- `ios.yml`: built on main pushes, TestFlight only on a manual run with
  `testflight`; release-build environment for both jobs; the owner check first.
- `native.yml`, with `nativeE2e`; `releaseAccess` over every template.
