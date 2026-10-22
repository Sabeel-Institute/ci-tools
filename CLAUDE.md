# ci-tools: working rules

Shared CI, release and device-test tooling for `Sabeel-Institute/lms`,
`sabeel-institute-kanban` and `sabeel-institute-time-tracker`. Usage is in
`README.md`; the consolidation still under way is `docs/PLAN.md`.

**This repository is PUBLIC**, like the three apps. No secrets, no real names,
no data. Identifiers already public in the apps (bundle ids, project ids) are
fine.

## Invariants

- **Scripts run at the app's root.** `bin/sabeel-ci.mjs` finds the directory
  holding `ci-tools.json` and runs the script there, with `CI_TOOLS` naming this
  package. Read app files by relative path; never `cd "$(dirname "$0")/.."`.
- **What differs between the apps lives in `ci-tools.json`,** declared in
  `lib/config.mjs`'s SCHEMA. Never branch on which app this is (no
  `root.endsWith('/lms')`, no `existsSync('scripts/<app-only>.mjs')`). An app
  that differs only by accident changes instead (`docs/PLAN.md`, stage 3).
- **Ports come from `lib/ports.mjs` and the app's `emulators.base`.** No
  script here states an app's port. `free-emulator-ports` reaches no further
  than the app's suite ports and stops only processes working inside the
  checkout: the apps share one machine, and a wider sweep killed a sibling's
  emulator.
- **Scripts that run before `npm ci` use Node built-ins only,** and so does
  everything they import: `ci-platform` (with `build-aab`, `build-web` and
  theirs), `ci-play` and `publish-play`, `ci-hosting-smoke`, `ci-functions
  require-ci`, `ci-premerge prepare`, `check-release`, `testflight-check`, the
  shell scripts. The release jobs never install the app's dependencies before
  verifying provenance; Publish Android and the device check never install
  them at all.
- **The push tools run the app's own sender.** `check-push` and
  `send-test-push` load `functions/src/{fcm,apns,testPush}.ts` from source and
  `firebase-admin` from `functions/` (`scripts/lib/push.mjs`), never a copy
  here, and never print a key. Their tests stand fakes in for every service.
- **The version is written once, in `app/app.json`.** Android's versionCode
  and the iOS build number follow from it (`lib/version.mjs`); nothing else
  states one, and `check-app` refuses an app where something does.
- **Releases go through pull requests.** `release` pushes only
  `release/v<version>` and opens its pull request; the owner merges it, and
  `release --ship`, run by the owner, creates the tag with the GitHub release.
- **The fetch step (`workflows/partials/ci-tools.yml`) is a security boundary.**
  It takes the commit from the app's lockfile, refuses one that is not on this
  repository's `main`, and installs with `--ignore-scripts`. Release jobs fetch
  before they check out the build being released, so validators always come
  from main's pin.
- **Workflow files are rendered, never edited in an app.** `sabeel-ci workflows
  --check` (inside `check-app`) fails on drift.
- **`scripts/lib/` is shared code, not commands.** `sabeel-ci` runs only
  `scripts/*.{mjs,sh}`; `load-build-env.sh` is sourced, `release-access.mjs`
  and `ci-sdk.mjs` are imported.

## Tests

`npm test` (Vitest), `npm run lint:shell` (shellcheck), `npm run
lint:workflows` (actionlint over this repository's workflows and every
template as rendered). CI runs all three. A test about an app's own files
belongs in `check-app`, not here; tests here use fixtures and the templates.

## Commits

Same conventions as the apps: 50-character imperative subject, body wrapped at
70. `main` takes changes by pull request only, merged by the owner.
