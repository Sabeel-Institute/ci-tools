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
