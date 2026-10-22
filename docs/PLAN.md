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
   `check-text-sources`; `codeql.yml`. Merged: emulator control (`emulator`,
   `emulators`, `test-emulator`, `free-emulator-ports`, `jdk21`, `ports`, and
   the apps' emulator ports tests as part of `check-app`).
3. **The apps standardised where they differed by accident** (each in that
   app's migration pull request, with its tests):
   - one Android keystore variable name read by every app's Gradle build
     (`ci-platform` writes both LMS's and TT's names today);
   - the same build hooks under the same names (build info, version check, web
     push check), so tools call npm scripts instead of probing for files;
   - one emulator port layout per base (README, "Emulator ports"), declared
     once in `ci-tools.json`, and the emulator commands' conventions: below,
     "Emulators: each app's changes";
   - one seed hook for the native flows (today `seed-emulator-world`,
     `seed-native`, `seed-dev`);
   - one label (and testID) for the emulator-only sign-in row, which
     `check-release` must find absent (four spellings today).
4. **Each app migrates** in one pull request: the pin, `ci-tools.json`, rendered
   workflows, its copies deleted, its docs pointing here.

App-specific tools stay in the apps: `screens-e2e`, `web-e2e`, seeds,
migrations, backfills, LMS's media store.

## Emulators: each app's changes

`ci-tools.json`:

| App | `emulators` |
|---|---|
| LMS | `{ "base": 61300, "project": "demo-sabeel-recordings", "extras": { "master": 20, "masterGrpc": 21, "volume": 22, "volumeGrpc": 23, "filer": 24, "filerGrpc": 25, "s3Grpc": 26, "s3": 27 }, "functionsWrapper": ["node", "scripts/with-media-store.mjs"] }` |
| Kanban | `{ "base": 61200, "project": "demo-sabeel-kanban" }` |
| Time Tracker | `{ "base": 61000, "project": "demo-sabeel" }` |

Ports that move or are newly pinned:

| App | Service | From | To |
|---|---|---|---|
| LMS | media store S3 (`s3`) | 61307 | 61327 |
| LMS | the walkthrough's web dev server (`web`) | 61311 | 61310 |
| LMS | the screens sweep's web dev server (`sweep`) | 61310 | 61311 |
| Kanban | Cloud Tasks (`tasks`) | unpinned (9499) | 61208 |
| Kanban | Eventarc (`eventarc`) | unpinned (9299) | 61209 |
| Time Tracker | Eventarc (`eventarc`) | 61007 | 61009 |

In every app:

- `package.json`: `"test:emulator": "sabeel-ci test-emulator"`, `"emulators":
  "sabeel-ci emulators"`, `"emulators:free": "sabeel-ci
  free-emulator-ports"` (Time Tracker gains `emulators`, Kanban
  `emulators:free`).
- `functions/package.json`: the two passes are `test:emulator:rules` (no
  Functions emulator) and `test:emulator:functions`. LMS renames `test:rules`
  and `test:integration`; Kanban `test:integration:rules` and
  `test:integration:fn` (and its suite-coverage test, which reads them); Time
  Tracker `test:integration` and `test:gate`.
- Deleted: `scripts/emulator.sh`, `scripts/test-emulator.sh`,
  `scripts/lib/ports.mjs`, and each app's emulator ports test; LMS and Kanban
  `scripts/emulators.sh`; LMS and Time Tracker `scripts/free-emulator-ports.sh`;
  LMS `scripts/lib/jdk21.sh` and `scripts/lib/project.mjs`; Kanban
  `scripts/jdk21.sh`.
- Node scripts read ports with `ports(config(root))` from
  `@sabeel-institute/ci-tools/lib/ports.mjs` and `lib/config.mjs`, and the
  emulator project from `config(root).emulators.project`. Shell scripts read
  them with `npx --no sabeel-ci ports <name>`, find JDK 21 with
  `JAVA_HOME=$(npx --no sabeel-ci jdk21)`, and free ports with `npx --no
  sabeel-ci free-emulator-ports`. No script or `package.json` states a port of
  the block, a comment's copy-paste line included: `check-app` refuses it.
- One name for each local setting: `SABEEL_AVD` (was `SR_AVD`, `SK_AVD`,
  `ST_AVD`), `SABEEL_JDK21_HOME` (was `SR_`, `SK_`, `ST_JDK21_HOME`; the
  bootstrap's `--jdk21-aliases SABEEL` sets it), `SABEEL_STOP_GRADLE` (was
  Kanban's `SK_STOP_GRADLE`).

Per app, beyond that:

- **LMS**: `functions/.env.demo-sabeel-recordings` `MEDIA_S3_ENDPOINT` to
  `http://127.0.0.1:61327`; `scripts/lib/media-store.mjs` takes its ports and
  dev-server origins from `ports()`; `e2e-stack.sh` takes `sweep` and `web`;
  `native-e2e.sh` maps `adb reverse` for `s3` and seeds through `web`.
- **Kanban**: `firebase.json` pins `tasks` and `eventarc`; `dev.sh` and
  `e2e-all.sh` build their port lists from `sabeel-ci ports` (Metro's 8081
  and idb's 10882 stay literal, outside the block); `dev:web` serves on
  `$(sabeel-ci ports web)`; the operator scripts' usage lines read
  `FIRESTORE_EMULATOR_HOST=127.0.0.1:$(npx --no sabeel-ci ports firestore)`.
- **Time Tracker**: `firebase.json` moves `eventarc`; `scripts/lib/e2e-stack.mjs`
  takes ports, project, JDK and the port sweep from ci-tools; `.gitignore`
  covers `shots/`, where `sabeel-ci emulator shot` writes.

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
