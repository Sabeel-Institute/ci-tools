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
- ``sabeel-ci check-app``: what ci-tools assumes of an app, including the
  checks that were spread through the apps' copies of these tests.
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
