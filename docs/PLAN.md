# Plan: adopting the uniform configuration

This pass makes the three apps' configuration the same where it differed by
accident: one Sentry setup, the emulators' placeholders and project, one
Hosting and Android shape, one manual renderer, one seed path. Each app takes
it by moving its pin to the merge of `ci/uniform-config`, in one pull request
with its own CI green and `npx sabeel-ci check-app` passing. README.md says
how each piece works; this file is the handoff and goes once all three have
adopted it.

## Secrets, by name, before an app's pull request merges

| Where | Change |
|---|---|
| LMS, TT, Kanban: `release-build` environment | Create `BUILD_ENV` from the vault copy of that app's `app.env.sentry-build-plugin` (`SENTRY_AUTH_TOKEN`, `IOS_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`). `SENTRY_ORG` and `SENTRY_PROJECT` lines are no longer read (ci-tools.json's win); drop them from the file and the vault copy. Delete `IOS_BUILD_ENV` once the app's pull request has merged |
| LMS: `APP_ENV_LOCAL` (and the vault's `app/.env.local`) | Rename `EXPO_PUBLIC_SENTRY_DSN_ANDROID` to `EXPO_PUBLIC_SENTRY_DSN_NATIVE`, same value |
| TT: `APP_ENV_LOCAL` (and the vault's `app/.env.local`) | Rename `EXPO_PUBLIC_SENTRY_DSN` to `EXPO_PUBLIC_SENTRY_DSN_NATIVE`, and add `EXPO_PUBLIC_SENTRY_DSN_WEB` with the same value (`sabeel-time-tracker-app` takes both) |
| Kanban: `APP_ENV_LOCAL` | No change |
| This machine and the Mac, LMS and TT | Move the token from `app/android/sentry.properties` (`auth.token`) into `app/.env.sentry-build-plugin` as `SENTRY_AUTH_TOKEN`; delete `app/android/sentry.properties` |

No new token: the org token already in that file (scope `org:ci`) serves the
Android, iOS and web uploads. Deploy Web reads it only in its new
`sourcemaps` job, which enters `release-build` from main after the owner
check.

## Every app

- Pin, `npx sabeel-ci workflows`, commit the re-rendered workflows.
- `ci-tools.json`: delete `build`, `emulators.project` and `native.seed`; add
  `sentry` (values per app below).
- Sentry: `app/src/sentry.ts` reads `EXPO_PUBLIC_SENTRY_DSN_NATIVE`,
  `app/src/sentry.web.ts` reads `EXPO_PUBLIC_SENTRY_DSN_WEB`, and no other
  file in `app/src` names another DSN variable. `app/metro.config.js` builds
  on `getSentryExpoConfig(projectRoot)` from `@sentry/react-native/metro`.
  `app/android/app/build.gradle` applies `sentry.gradle` under exactly
  `if (file("$projectRoot/.env.sentry-build-plugin").exists()) {` (README,
  "Sentry").
- `app/android/app/build.gradle` ends with the `gradle.taskGraph.whenReady`
  release-key stop (README, "ci-tools.json", Kanban's shape); its comments
  stop saying Gradle refuses an unsigned release by itself.
- `firebase.json` hosting: LMS's `headers` (security headers on `!/__/**`
  only, `/_expo/static/**` and `/assets/**` immutable) and the rewrite
  `{ "source": "!/_expo/**", "destination": "/index.html" }` in place of
  `**`; `predeploy` `npm run web:export -w @sabeel/app`.
- `app/android/app/src/main/AndroidManifest.xml`: `<meta-data
  android:name="com.google.firebase.messaging.default_notification_channel_id"
  android:value="sabeel-alerts"/>` inside `<application>`.
- `.gitignore`: `*.jks`, `*.keystore`, `!app/android/app/debug.keystore`,
  `*service-account*.json`, `*firebase-adminsdk*.json`.
- Emulators: `EMULATOR_PROJECT_ID` in `packages/shared/src/constants.ts` is
  `demo-sabeel-<name>`; `git mv` the functions' `functions/.env.<old>` to
  `functions/.env.demo-sabeel-<name>`; scripts take the project from
  `emulatorProject(config(root))` (`lib/ports.mjs`) or `npx sabeel-ci ports
  --project`, never a literal.
- `functions/.secret.local` is no longer kept by hand: docs stop telling
  anyone to make it, and the app's own browser stack may run `npx sabeel-ci
  emulator-secrets` before it starts the emulators (CI's browser job does).
- The seed for the native flows is `scripts/seed-emulators.mjs` (`git mv`),
  with every caller and comment moved.
- The manual: delete `docs/render-manual.py`; the logo is
  `app/assets/logo.png`; screenshot pairs are `<figure class="ph">` then
  `<figure class="wd">` in a `<div class="pair">`; docs say `npx sabeel-ci
  render-manual` (needs `uv` and `google-chrome`).
- Docs name `BUILD_ENV` where they said `IOS_BUILD_ENV`.

## LMS (`Sabeel-Institute/lms`, main)

- `ci-tools.json` `sentry`: `{ "org": "devnull-ke", "projects": { "native":
  "sabeel-recording-android", "web": "sabeel-recording-web", "functions":
  "sabeel-recording-functions" } }`.
- `app/src/sentry.ts`: `EXPO_PUBLIC_SENTRY_DSN_ANDROID` →
  `EXPO_PUBLIC_SENTRY_DSN_NATIVE`; also `docs/IOS-BUILD.md`,
  `docs/SECRETS.md`.
- `app/metro.config.js`: `getDefaultConfig` → `getSentryExpoConfig` (keep the
  cache store and the Lexical resolver).
- `app/android/app/build.gradle`: add the `sentry.gradle` block and the
  release-key stop. `app/android/build.gradle`: `google-services:4.4.2` →
  `4.4.4`. `AndroidManifest.xml`: the channel meta-data.
- Delete `scripts/web-release.mjs` (Deploy Web uploads the maps now) and
  `web:export:maps` in `app/package.json`; `firebase.json` hosting
  `predeploy` → `npm run web:export -w @sabeel/app`; the old pipeline and
  `app/android/sentry.properties` leave `scripts/prod-smoke.mjs`'s comment,
  `docs/DEPLOY.md`, `docs/SECRETS.md` and `docs/IOS-BUILD.md`.
- Emulators: `demo-sabeel-recordings` → `demo-sabeel-lms` in
  `packages/shared/src/constants.ts` and `functions/.env.demo-sabeel-recordings`
  (rename); `.emulators.project` → `emulatorProject(...)` in
  `scripts/e2e-stack.sh` (`npx sabeel-ci ports --project`),
  `scripts/lib/media-store.mjs`, `scripts/lib/seed-world.mjs`,
  `scripts/repro-stale-scope.mjs`, `scripts/screens-e2e.mjs`,
  `scripts/seed-emulator-world.mjs`, `scripts/seed-guide.mjs`,
  `scripts/tutorials/record.mjs`,
  `scripts/web-e2e.mjs`; `scripts/set-min-version.mjs`'s comment;
  `docs/DEV-TOOLING.md`.
- Seed: `scripts/seed-emulator-world.mjs` → `scripts/seed-emulators.mjs`;
  `package.json` `seed:emulators`, `maestro/staff.yaml`,
  `maestro/student.yaml`, `docs/DEV-TOOLING.md`.
- `.gitignore`: the key patterns; `.github/dependabot.yml` loses its
  `github-actions` entry (check-app already fails on it).

## Time Tracker (`mig-tt`, branch `ci/ci-tools`)

- `ci-tools.json` `sentry`: `{ "org": "devnull-ke", "projects": { "native":
  "sabeel-time-tracker-app", "web": "sabeel-time-tracker-app", "functions":
  "sabeel-time-tracker-functions" } }`.
- `app/src/sentry.ts` → `EXPO_PUBLIC_SENTRY_DSN_NATIVE`,
  `app/src/sentry.web.ts` → `EXPO_PUBLIC_SENTRY_DSN_WEB`; also
  `docs/DEPLOY.md`, `docs/IOS-BUILD.md`, `docs/SECRETS.md`.
- `app/android/app/build.gradle`: the `sentry.properties` gate becomes the
  `.env.sentry-build-plugin` one; add the release-key stop; delete
  `app/android/sentry.properties.example` and its mentions in `.gitignore`,
  `TODO.md`, `docs/DEPLOY.md`, `docs/IOS-BUILD.md`, `docs/SECRETS.md`.
- `IOS_BUILD_ENV` → `BUILD_ENV` in `docs/GITHUB-ACTIONS.md`,
  `docs/IOS-BUILD.md`, `docs/SECRETS.md`; `render-manual` in `CLAUDE.md`,
  `docs/DEPLOY.md`, `docs/DEV-TOOLING.md`.
- `firebase.json` hosting: LMS's headers (drop `X-Frame-Options:
  SAMEORIGIN` and the others from `**`), `/assets/**` immutable, the
  `!/_expo/**` rewrite. `.firebaserc`: rename the `dev` alias to `default`.
- `.gitignore`: the key patterns.
- Emulators: `demo-sabeel` → `demo-sabeel-time-tracker` in
  `packages/shared/src/constants.ts`, `functions/.env.demo-sabeel` (rename),
  `functions/test/setup.ts` and the `projectId: 'demo-sabeel'` literals in
  `functions/test/integration/*.ts` (import `EMULATOR_PROJECT_ID`);
  `emulatorProject(...)` in `scripts/grant-admin.mjs`,
  `scripts/lib/e2e-stack.mjs`; `docs/PRODUCT_BRIEF.md`, `docs/SECRETS.md`.
- Seed: `scripts/seed-native.mjs` → `scripts/seed-emulators.mjs`;
  `maestro/timesheet.yaml`, `docs/DEV-TOOLING.md`.
- knip: the root `knip.json` workspace stops ignoring `@sabeel/shared`; the
  root `package.json` declares `"@sabeel/shared": "*"` in `devDependencies`,
  as LMS and Kanban do.
- `functions/test/unit/pushChannel.test.ts`'s manifest assertion may go:
  check-app holds it now.

## Kanban (`mig-kanban`, branch `ci/ci-tools`, on top of its migration)

- `ci-tools.json` `sentry`: `{ "org": "devnull-ke", "projects": { "native":
  "sabeel-kanban-mobile", "web": "sabeel-kanban-web", "functions":
  "sabeel-kanban-functions" } }`. The emulator project stays
  `demo-sabeel-kanban`.
- `app/android/app/build.gradle`: the gate drops `||
  System.getenv("SENTRY_AUTH_TOKEN")` (its warning branch may stay).
- `app/metro.config.js`: `getDefaultConfig` → `getSentryExpoConfig`.
- `firebase.json` hosting: LMS's headers, `/assets/**` immutable, the
  `!/_expo/**` rewrite. `AndroidManifest.xml`: the channel meta-data.
- `.gitignore`: add `*firebase-adminsdk*.json`.
- Seed: `scripts/seed-dev.mjs` → `scripts/seed-emulators.mjs`;
  `package.json` `seed`, `scripts/dev.sh`, `maestro/board.yaml`,
  `docs/DEVELOPING.md`, `docs/GITHUB-ACTIONS.md`, `docs/IOS-BUILD.md`.
- Manual: copy `app/assets/brand/sabeel-logo.png` to `app/assets/logo.png`
  (the same image); in `docs/USER-MANUAL.md` `<figure><img class="wide"` →
  `<figure class="wd"><img`, `<figure><img class="narrow"` → `<figure
  class="ph"><img`, phone figure first; re-render.
- `IOS_BUILD_ENV` → `BUILD_ENV` in `docs/GITHUB-ACTIONS.md`,
  `docs/IOS-BUILD.md`, `docs/SECRETS.md`.

## Open decisions for the owner

- R8 mappings: `sentry.gradle` uploads the JavaScript source map only.
  Kanban alone minifies (`android.enableMinifyInReleaseBuilds=true`), so its
  Java and Kotlin frames reach Sentry obfuscated. Either minification goes
  off, as in LMS and TT, or every app adds the Sentry Android Gradle plugin
  (`io.sentry.android.gradle`, `autoUploadProguardMapping`).
- The manual's screenshot pairs stack, phone above computer (LMS's layout).
  Kanban's side-by-side pairs become stacked: its PDF grows from 34 to 51
  pages. One CSS rule in `scripts/lib/render-manual.py` changes all three.
- `build-ios` now refuses to build without `SENTRY_AUTH_TOKEN`, like the
  Android and web builds; it used to warn and build.
