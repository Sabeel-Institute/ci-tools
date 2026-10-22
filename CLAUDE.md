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
  Two holdovers remain until then: `ci-platform` probes for an app's
  `gen-build-info`, `build-aab` and `check-web-push` scripts, and
  `check-release` boots a local AVD with the app's `scripts/emulator.sh`.
- **Scripts that run before `npm ci` use Node built-ins only:** `ci-platform`,
  `ci-play`, `ci-hosting-smoke`, `ci-functions require-ci`, `ci-premerge
  prepare`, `check-release`, the shell scripts. The release jobs never install
  the app's dependencies before verifying provenance, and the device check
  never installs them at all.
- **The fetch step (`workflows/partials/ci-tools.yml`) is a security boundary.**
  It takes the commit from the app's lockfile, refuses one that is not on this
  repository's `main`, and installs with `--ignore-scripts`. Release jobs fetch
  before they check out the build being released, so validators always come
  from main's pin.
- **Workflow files are rendered, never edited in an app.** `sabeel-ci workflows
  --check` (inside `check-app`) fails on drift.

## Tests

`npm test` (Vitest), `npm run lint:shell` (shellcheck), `npm run
lint:workflows` (actionlint over this repository's workflows and every
template as rendered). CI runs all three. A test about an app's own files
belongs in `check-app`, not here; tests here use fixtures and the templates.

## Commits

Same conventions as the apps: 50-character imperative subject, body wrapped at
70. `main` takes changes by pull request only, merged by the owner.
