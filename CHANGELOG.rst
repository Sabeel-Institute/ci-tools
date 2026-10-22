Changelog
=========

Unreleased
----------

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
  which each app brings to the contract in README's "Push" when it migrates
  (``docs/PLAN.md``, stage 3). ``ci-platform web`` runs ``check-web-push`` on
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
