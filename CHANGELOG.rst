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
