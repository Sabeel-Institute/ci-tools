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
- The iOS release path, merged from the apps' drifted copies: ``build-ios``,
  ``check-ios-config``, ``testflight-check``, the ``load-build-env`` loader
  and the ``ios`` workflow template, with ``ci-platform prepare-ios`` and
  ``asc-key`` for its secrets. ``build-ios`` never uploads; TestFlight takes
  the workflow's build of the commit tagged ``v<version>``, with a build
  number Apple has not taken. Each app states its native Sentry DSN variable
  in ``ci-tools.json`` (``ios.sentryDsnVariable``), and opts into
  ``ios.backgroundPlayback``, ``ios.releaseNotes`` and ``ios.buildInfo``.
  ``check-app`` holds the release-access rules over every workflow an app
  has and requires ``.gitignore`` to cover ``app/.env.sentry-build-plugin``.
