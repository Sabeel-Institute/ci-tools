Changelog
=========

Unreleased
----------

- ``build-web`` and ``build-aab`` refuse while ``EXPO_PUBLIC_USE_EMULATORS``
  is set in the shell or in an ``app/.env*`` file, as LMS's
  ``web-release.mjs`` did before Hosting's predeploy became ``build-web``: a
  local ``firebase deploy --only hosting`` or ``release --ship`` from a
  dev-loop terminal would otherwise ship a bundle pointed at the emulators.
  ``build-web --emulators`` builds for the emulators on purpose and sets the
  flag itself.
- ``build-web --source-maps`` requires the debug ids itself (each script
  hands its id to the Sentry SDK and matches its map), so a local build shows
  what ``ci-platform web`` refuses.
- ``render-manual`` renders ``docs/USER-MANUAL.pdf`` for every app, in
  place of the three diverged ``docs/render-manual.py`` copies, and
  ``release`` runs it. It keeps the best of them: the version from
  ``app.json`` and this month on the cover, the manual's version line checked
  against ``app.json``, the cover title from ``app.json``'s name, LMS's
  phone-then-computer screenshot pairs (``figure.ph``, ``figure.wd``). The logo
  is ``app/assets/logo.png``. It is Python with inline dependencies
  (``markdown`` 3.10.3), run by ``uv run --script``.
- ``check-app`` holds more of each app to one shape: the Hosting site
  (security headers on ``!/__/**`` only, immutable ``/_expo/static/**`` and
  ``/assets/**``, the single-page rewrite from ``!/_expo/**``), a
  ``default`` alias in ``.firebaserc``, Android's default notification
  channel naming ``PUSH_CHANNEL_ID``, the google-services plugin at 4.4.4,
  ``build.gradle`` stopping a release it cannot sign
  (``gradle.taskGraph.whenReady``, Kanban's shape), and ``.gitignore``
  covering ``*.jks``, ``*.keystore``, ``*service-account*.json`` and
  ``*firebase-adminsdk*.json``.
- Sentry, one way in every app. The DSNs are always
  ``EXPO_PUBLIC_SENTRY_DSN_NATIVE`` and ``EXPO_PUBLIC_SENTRY_DSN_WEB``;
  ``build.sentryDsnVariable`` (and the ``build`` section) is gone. The org and
  project slugs live in ``ci-tools.json``'s new, required ``sentry`` section.
  The build secret ``IOS_BUILD_ENV`` is renamed ``BUILD_ENV``, holds
  ``SENTRY_AUTH_TOKEN`` and the App Store Connect ids, and is written to
  ``app/.env.sentry-build-plugin`` by the Android build too.
  ``build-aab`` refuses a release without the native DSN, the token or
  ``build.gradle``'s ``sentry.gradle`` gate, and runs Gradle with the org and
  native project; ``build-ios`` refuses one without the token.
  ``ci-platform web`` requires the web DSN and debug ids in every script and
  keeps the source maps beside the site; Deploy Web uploads them from a new
  ``sourcemaps`` job in ``release-build`` before it publishes, with a
  checksum-pinned ``sentry-cli``. ``check-app`` requires the gradle gate,
  ``getSentryExpoConfig`` in ``app/metro.config.js`` and the two DSN names
  in ``app/src``. Release access names the publishing jobs per workflow, and
  Deploy Web's ``sourcemaps`` starts with the owner check too.
- ``functions/.secret.local`` comes from ``ci.emulatorSecrets`` alone:
  ``emulators`` and ``test-emulator`` write it on every run, and the new
  ``emulator-secrets`` writes it for a stack the app starts itself (CI's
  browser job runs it; the integration and native jobs no longer need a
  step). ``check-app`` requires it ignored and not committed. The browser
  job's Chromium install times out after 10 minutes.
- The emulators' project is ``demo-sabeel-<name>``, derived from
  ``ci-tools.json``'s ``name`` (``emulatorProject()`` in ``lib/ports.mjs``,
  ``sabeel-ci ports --project``); ``emulators.project`` is gone and an app
  that sets it fails every command. ``name`` must make a project id:
  lowercase words joined by hyphens, at most 18 characters. The projects
  become ``demo-sabeel-lms``, ``demo-sabeel-time-tracker`` and
  ``demo-sabeel-kanban``; ``check-app`` holds ``EMULATOR_PROJECT_ID`` and
  ``functions/.env.demo-sabeel-<name>`` to it.
- The native flows' seed is ``scripts/seed-emulators.mjs`` in every app;
  ``native.seed`` is gone. ``native-e2e`` refuses to run without it, and
  ``check-app`` requires it where ``maestro/`` holds flows.
- ``emulators`` and ``test-emulator`` (and ``native-e2e`` through
  ``emulators``) set ``FUNCTIONS_DISCOVERY_TIMEOUT=120`` unless the caller
  set it: firebase-tools gives a new Functions worker 30 s to load, which a
  busy macOS runner exceeded, failing a request with "Failed to load
  function".
- The tools the three apps kept identical copies of, as one package:
  ``check-release``, ``ci-android-sdk``, ``ci-avd``, ``ci-functions``,
  ``ci-hosting-smoke``, ``ci-platform``, ``ci-play``, ``ci-premerge`` (with the
  Expo SDK check that lived in ``app/ci-sdk.mjs``), ``install-maestro``,
  ``ios-sim-build`` and ``screens-report``, run through ``sabeel-ci``.
- The workflows they kept identical (``android``, ``android-publish``,
  ``functions-deploy``, ``premerge``, ``web``, ``web-deploy``) as templates,
  rendered by ``sabeel-ci workflows``. Every job fetches ci-tools at the commit
  the app's lockfile pins; the release jobs no longer copy validators aside.
- ``ci.yml`` and ``codeql.yml`` as templates: the app's npm scripts for
  lint, typecheck, unit and emulator tests, a browser matrix from
  ``ci.browserSuites``, media tools and the dead-code audit only where
  ``ci-tools.json`` asks, emulator secret placeholders from
  ``ci.emulatorSecrets``, ``check-app`` before the app's own tests.
- ``sabeel-ci check-app``: what ci-tools assumes of an app, including the
  checks that were spread through the apps' copies of these tests.
- The push checks, merged: ``check-push`` (FCM and both Apple services;
  ``check-push apple`` is Kanban's ``check-apple-push``), ``check-web-push``
  and ``send-test-push``. They send through the app's own functions code,
  which each app brings to the contract in README's "Push from the app's own
  code" when it migrates (``docs/PLAN.md``). ``ci-platform web`` runs ``check-web-push`` on
  every web build, not only when the app has a copy; the check reads the
  scripts ``index.html`` loads and requires the key to be a P-256 point.
- Build stamping and the checks before a build, one way in every app:
  ``build-info`` (Kanban's and the Time Tracker's ``gen-build-info``; LMS
  stamps the same file instead of ``EXPO_PUBLIC_COMMIT``), ``build-web``,
  ``build-aab`` (Kanban's ``build-aab.sh`` gates: a store-legal version, a
  deploy-log entry for it, the native Sentry DSN, no unsigned or debug-signed
  bundle), ``check-version``, ``deploy-notes``, ``check-text-sources`` and
  ``preflight-metro``. ``ci-platform android`` and ``web`` build through them
  instead of looking for an app's scripts, and the web build refuses an export
  without HEAD's commit or marked ``+``, as the Android one does. The version
  check holds every version to Play's largest versionCode, 2100000000.
  ``ci-tools.json`` requires ``build.sentryDsnVariable``; ``check-app`` wants
  ``app/src/build-info.ts`` ignored and a deploy-log entry for the app's
  version.
- The iOS release path, merged from the apps' drifted copies: ``build-ios``,
  ``check-ios-config``, ``testflight-check``, the ``load-build-env`` loader
  and the ``ios`` workflow template, with ``ci-platform prepare-ios`` and
  ``asc-key`` for its secrets. ``build-ios`` never uploads; TestFlight takes
  the workflow's build of the commit tagged ``v<version>``, with a build
  number Apple has not taken. Like the Android build, it requires the
  version's deploy-log entry, stamps the commit with ``build-info``, and
  reads the native Sentry DSN variable from ``build.sentryDsnVariable``; an
  app that plays with the phone locked sets ``ios.backgroundPlayback``.
  ``check-app`` holds the release-access rules over every workflow an app
  has and requires ``.gitignore`` to cover ``app/.env.sentry-build-plugin``.
- Emulator control, merged from the apps' drifted copies: ``emulator`` (the
  local AVD), ``emulators``, ``test-emulator``, ``free-emulator-ports``,
  ``jdk21`` and ``ports``. One port layout for every app, computed from
  ``emulators`` in ``ci-tools.json``, which each app now sets; ``check-app``
  holds ``firebase.json``, ``app/src/env.ts`` and the shared emulator project
  to it in place of each app's emulator ports test. ``check-release`` boots
  the local AVD through ``sabeel-ci emulator``, and ``sabeel-ci`` passes a
  signal it receives on to the command it runs. At migration LMS moves its
  media store's S3 port to 61327 and swaps its web dev-server ports, Kanban
  pins Cloud Tasks and Eventarc, Time Tracker moves Eventarc to 61009, and the
  functions workspaces name their passes ``test:emulator:rules`` and
  ``test:emulator:functions`` (``docs/PLAN.md``).
- ``publish-play``: the one Play publisher, merged from the apps' three copies
  with every safeguard any of them had. It needs ``release.appSigningCertificate``
  in ``ci-tools.json`` (the certificate Play signs installs with) and the
  publishing key in ``PLAY_KEY`` or ``~/keys/sabeel-play-publisher.json``.
  Publish Android runs it from ci-tools at main's pin; the job no longer copies
  the app's publisher aside or installs the app's dependencies.
- ``release``: one release flow for every app. ``release X.Y.Z --notes
  <entry>`` opens the version's pull request; ``release --ship``, on main once
  the owner has merged it, builds, checks, creates the GitHub release and tag,
  and publishes to Play. Its notes are the version's deploy-log entry in
  ``docs/PHASE_STATUS.md``, read with ``deploy-notes``.
- Versions are written once, in ``app/app.json``: build.gradle must compute
  versionCode and versionName from it (``lib/version.mjs``), app.json carries
  no ``android.versionCode``, and ``expo.ios.buildNumber`` is the versionCode.
  ``check-app`` refuses an app where any of these, or the manual's "For app
  version" line, disagree.
- ``native-e2e`` and the ``native`` workflow template, merged from the apps'
  copies: the debug build's id from ``app.json`` and the debug build type's
  suffix, the emulators through ``sabeel-ci emulators``, the seed and what it
  needs from ``native`` in ``ci-tools.json``, screenshots in
  ``shots/native/``. ``check-app`` requires every Maestro flow to take its app
  as ``appId: ${APP_ID}``.
- One Android keystore variable: ``ci-platform prepare-android`` sets
  ``SABEEL_KEYSTORE_PROPERTIES`` alone and writes nothing into the checkout,
  and ``check-app`` requires ``build.gradle`` to read it.
