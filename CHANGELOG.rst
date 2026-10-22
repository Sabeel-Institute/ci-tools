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
