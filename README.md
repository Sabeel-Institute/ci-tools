# ci-tools

The CI, release and device-test tooling of the Sabeel Institute apps (LMS,
Kanban, Time Tracker): one copy, which each app pins to a commit. What differs
between the apps is said once, in each app's `ci-tools.json`.

```mermaid
flowchart LR
  T[ci-tools main] -- "commit pinned in package-lock.json" --> A[app repository]
  A -- "npm ci (local)" --> L["npx sabeel-ci &lt;command&gt;"]
  A -- "first step of every CI job" --> C["clone at the pin, refuse a commit not on main,<br/>sabeel-ci on PATH"]
  T -- "workflows/*.yml, rendered by sabeel-ci workflows" --> W[app .github/workflows]
```

## In an app

```sh
npm install --save-dev github:Sabeel-Institute/ci-tools#<commit>
npx sabeel-ci workflows        # render the shared workflows into .github/workflows/
npx sabeel-ci check-app        # what ci-tools assumes of the app
npx sabeel-ci <command> [args] # any command below
```

`sabeel-ci` runs from anywhere inside the app; each command works at the app's
root, the directory holding `ci-tools.json`.

| Command | What it does |
|---|---|
| `check-app` | The app meets what these tools assume: `ci-tools.json`, the rendered workflows, `.gitignore` covering the files CI writes from secrets, signing secrets read only inside the `release-build` environment and every release checking its owner first (in the app's own workflows too), identifiers the premerge fixtures accept, `functions/package-lock.json` in step with its manifest |
| `workflows [--check]` | Render `workflows/*.yml` into `.github/workflows/`, or fail on any difference |
| `ci-platform <task>` | Signed release builds and their provenance: `prepare-android`, `prepare-web`, `prepare-ios`, `asc-key`, `android`, `web`, `resolve-build`, `resolve-android-build`, `deploy-config`, `validate-auth` |
| `ci-play verify\|release` | Check a downloaded Play bundle, then check Play access or publish to internal testing |
| `ci-hosting-smoke [--preflight]` | Read-only checks of a Hosting release, before and after publishing |
| `ci-functions require-ci\|plan\|verify` | Guards around a Cloud Functions deploy |
| `ci-premerge <task>` | Pull-request builds with no secrets: `sdk`, `backend`, `prepare`, `android`, `ios` |
| `ci-android-sdk` | The Android SDK packages Gradle needs, with retries |
| `ci-avd` | Boot an emulator on a GitHub runner |
| `check-release <aab>` | Five cold starts of a release bundle on an emulator |
| `install-maestro` | Maestro at a checksum-pinned version; prints its bin directory |
| `ios-sim-build <dir>` | Build the debug app for the iOS simulator and install it |
| `check-ios-config` | The iOS configuration that otherwise fails at upload, review or runtime: the plist against `app.json` and the Firebase project, plugins, export compliance, version and build number, icon, Sentry DSN, privacy manifest |
| `build-ios [--check]` | On a Mac: every gate, then archive and export a signed App Store `.ipa` to `build/ios/export`; never uploads. `--check` runs the gates and builds nothing |
| `testflight-check <bundle-id> <version> <build> <commit>` | Before a TestFlight upload: the commit is the one tagged `v<version>` on GitHub, and App Store Connect has not taken the build number |
| `screens-report <shots>` | An HTML report of a screenshot run, diffed against main's last one |

## Changing ci-tools

A change here lands through a pull request merged by the owner, like the apps.
An app picks it up by moving its pin
(`npm install --save-dev github:Sabeel-Institute/ci-tools#<new commit>`),
re-rendering (`npx sabeel-ci workflows`) and passing its own CI. CI refuses a
pin that is not on this repository's `main`.

`CHANGELOG.rst` records what each change means for the apps. `docs/PLAN.md` is
the consolidation still in progress.
