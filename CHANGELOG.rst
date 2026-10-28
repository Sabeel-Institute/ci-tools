Changelog
=========

Unreleased
----------

- A pull request that changes documentation alone (Markdown,
  reStructuredText, ``docs/``; the new ``docs-only`` command) skips CI's
  integration and browser jobs, Native and the Pre-merge builds. A
  ``changes`` job in each workflow decides, and ``build-test``, ``native``
  and ``premerge-builds`` accept those jobs skipped only on its word. CI's
  quality job still runs.
- CI's integration and browser jobs start beside quality instead of after
  it.
- The browser jobs and Native's seed install Chromium without apt: the
  libraries it needs are on GitHub's Ubuntu image, and an apt mirror held
  the step for over five minutes in one run in ten. The browser jobs keep
  the download per Playwright version.
- Native keeps each platform's debug build under the Expo fingerprint of
  the native inputs it compiles (``native-fingerprint debug``) and builds it
  only for a new one. A debug build loads its JavaScript from Metro, so a
  commit that changes no native input runs the flows on the build kept from
  main or from an earlier run of its pull request: the Xcode build took 14
  minutes of the iOS job and Gradle 10 to 15 of Android's. On a main push the
  iOS job runs only to keep a build for new native inputs.
- ``native-build android|ios <dir>`` builds that debug app; ``native-e2e
  --build <dir>`` installs it, and builds one itself when given none.
  ``ios-sim-build`` is gone.
- The Native iOS job starts the simulator's boot first (``ios-boot``), and
  ``native-e2e`` waits for the Mac's one-minute load average to fall under
  60 (ten minutes at most) before it starts the emulators. A simulator that
  has just booted keeps a 3-core CI Mac busy for about eleven minutes (load
  past 500 four minutes in, measured with nothing else running), and with
  the build kept nothing else took that time: in it LMS's seed missed the
  Auth emulator's deadline, Kanban's seed clicked at a page that would not
  hold still, Maestro's driver missed its two-minute startup and a callable
  took 40 s. Maestro's iOS driver gets ten minutes to start
  (``MAESTRO_DRIVER_STARTUP_TIMEOUT``).
- Native restores Gradle's cache only when it builds the APK: restoring it
  took half a minute that a kept build has no use for.
- ``native-e2e`` reads the iOS simulator's log only when a flow failed. It
  read it after every run, 2 to 10 minutes of each iOS job.
- Pre-merge Builds records the fingerprint of each release build that
  compiled (``native-fingerprint release``), on main pushes as well, and
  skips the native compile of a platform whose fingerprint compiled before.
  The new ``javascript`` job, which replaces ``web``, compiles both phones'
  production JavaScript through Hermes on every run (``ci-premerge
  bundles``), and the gate accepts a skipped platform only when the
  fingerprint job found it compiled.
- ``check-push`` and ``send-test-push`` reach FCM through firebase-admin's
  modular entry points (``firebase-admin/app``, ``firebase-admin/messaging``),
  as the functions do. firebase-admin 14 has no ``admin.messaging()``, and
  since the apps moved to it the FCM check failed with "admin.messaging is
  not a function" while the send path itself was fine. The tests' stand-in
  firebase-admin now has 14's shape.
- The Native iOS job ends macOS's temporary port range at 60999, as
  Linux's ends. macOS hands them out up to 65535, across every app's
  emulator block, and a connection that drew 61303 kept LMS's Functions
  emulator from starting (1 of about 50 iOS runs).
- Native runs on every pull request to main, not only those that change
  the flows, their seed or the lockfile, and its new ``native`` job passes
  only when the flows passed on both Android and iOS, for main's ruleset to
  require. A pull request that changed only app code merged without the
  flows ever running on it.
- ``native-e2e`` no longer runs Android's runner out of memory. Gradle's
  daemon and a Kotlin compile daemon kept 5.4 GB after the debug build,
  beside the emulator's 4.7 GB; the seed's web Metro and Chromium then took
  the runner to 0.6 GB free and GitHub shut it down (LMS: 7 of 40 runs, 4 of
  4 with the sampler watching). Kotlin now compiles inside Gradle's process
  and the daemon stops once the APK exists.
- ``native-e2e`` builds the scripts the web page loads before the seed
  loads it. The page answers at once, but a cold Metro builds its bundle on
  first request, past the seed's 30 s page load on a busy runner (5 iOS
  runs).
- The flows' shared steps live here, in ``maestro/``, and ``native-e2e``
  copies them into the app's ``maestro/ci-tools/`` for each run (``check-app``
  requires it ignored): ``tap-until.yaml`` and ``back-until.yaml`` take a step
  again only while its screen is still showing, for the taps a saturated
  simulator drops (27 iOS failures), and ``back.yaml`` and ``wait.yaml``
  move here from the apps.
- The Native iOS job stops Spotlight indexing first: the simulator alone
  holds the runner's load average past 300 during the flows.
- The emulators' downloads (their jars and the Emulator UI) are cached per
  Firebase CLI version in CI and Native. A download that failed mid-stream
  ended the emulators.
- ``native-e2e`` records memory, swap, disk, load and the largest processes
  by role every 20 s, from before the build to the end, in
  ``shots/native/logs/resources.log`` and, in CI, in the job's log. LMS's
  Android job has been ended by GitHub ("The runner has received a shutdown
  signal") right after the debug build, which leaves no artifact; the job
  log is all that survives. Its cleanup now also covers a failed build.
- ``check-app`` fails when ``functions/package.json`` does not depend on
  ``@google-cloud/functions-framework``. Without it, Google's buildpack
  installs a framework of its own, from its own lock, to serve every
  request: neither ``functions/package-lock.json`` nor Dependabot covered
  the code parsing every request body.
- ``build-web`` tree-shakes every web export, ``--emulators`` included.
  Metro otherwise bundles every module an import reaches, used or not; with
  named Sentry imports it took Kanban's bundle from 904 KB to 622 KB
  gzipped. Expo still calls the switches unstable: Kanban's and the Time
  Tracker's browser suites passed in full on tree-shaken builds first, and
  each app's suites run on one from now on.
- ``icons`` and ``lib/icons.mjs``: an app's icon font cut to the Material
  Icons glyphs it names, and ``iconProblems()`` for its unit tests, which
  fails when the font lags the list or does not draw a glyph the map names.
  The stock font is 156 KB over the wire, and on a slow connection it missed
  ``@expo/vector-icons``' 12 s and left every icon blank.
- ``play-apk`` refuses an APK carrying Play's installer check, which Play
  Console's automatic protection adds: installed by anything but Play, it
  asks for Google Play and does not open, so the release check and a
  GitHub-release install cannot run it. The setting is per app and no API
  reads it; the error names where to turn it off.
- ``release --ship`` watches the Publish Android run its own dispatch
  started. It took the newest run started in the last minute, which was the
  check run whenever GitHub had not yet listed the upload, and went on to
  Play's APK before the upload began.
- ``ci-functions warm`` reads the bundle the emulators already built instead
  of building it again: a rebuild under running emulators made them reload
  every function, discarding the workers it had just started.
- The APK on a GitHub release is the universal one Google Play generated
  from the published bundle, signed exactly as Play installs it
  (``play-apk``, refusing any signer but ``release.appSigningCertificate``),
  so a sideloaded install and Play's update each other in every app,
  Kanban's included. ``release --ship`` builds and signs nothing on the
  owner's machine: no Gradle, no ``apksigner``, no release key. The
  arm64-only APK goes, since Play makes one universal APK. The order is now
  Publish Android's check, its upload, Play's APK fetched and cold-started,
  and last the GitHub release, made as a draft and then published, which
  creates the tag: a tagged release always has its APK and manual, and a
  failure before it leaves no tag and is resumed by shipping again.
- ``check-app`` holds every app's Android release build to one shape: R8 and
  resource shrinking on, Sentry's Android Gradle plugin uploading each
  build's mapping file (at the version ``@sentry/react-native`` pairs with,
  the token handed to sentry-cli as ``SENTRY_DOTENV_PATH``), no Android
  backup, and ``lib/android/NetworkClient.kt``, the connect timeout and HTTP/2
  ping Kanban's client had, with uploads (Cloud Storage requests and PUTs)
  exempt from the ping, installed before React Native starts.
- Every app commits its Firebase app config: ``app/google-services.json``,
  the identical ``app/android/app/google-services.json`` and
  ``app/GoogleService-Info.plist``. ``check-app`` requires all three, naming
  the app's package, bundle id and ``.firebaserc`` project. CI no longer
  writes them from the ``ANDROID_GOOGLE_SERVICES_JSON`` and
  ``GOOGLE_SERVICE_INFO_PLIST`` secrets (LMS's), so it cannot overwrite a
  committed file, and the native flows' placeholder step is gone.
- The Nightly workflow checks production each night, read-only: the live
  web app must be, byte for byte, the Web workflow's build of the commit its
  scripts are stamped with (``ci-hosting-smoke --live``), and every callable
  must answer (``ci-functions health``). A failure opens or updates one
  ``nightly`` issue (``nightly-issue``); a night that passes closes it. The
  Web workflow keeps its builds 90 days for it. The push credentials are not
  checked: that needs production credentials in a scheduled job.
- ``release --ship`` publishes the bundle CI built from the release commit,
  as LMS 0.2.1 went out: it waits for the Android workflow's run (signed in
  ``release-build``, cold-started five times) and refuses one that failed,
  has Publish Android check that bundle and Play's permission before the
  tag, and upload it after. No bundle is built or uploaded on the owner's
  machine; the APKs on the GitHub release are still built there, checked
  against the key on CI's bundle.
- ``render-manual`` prints a phone/computer screenshot pair side by side,
  the phone on the left (46 mm and 116 mm), as Kanban's manual was: LMS's
  manual goes from 81 pages to 52, Kanban's stays at 34.
- ``native-e2e`` calls every callable on the emulators once after the seed
  (``ci-functions warm``), so a flow meets functions whose workers are up. A
  first call on a busy CI Mac took longer than LMS's iPhone flow waits.
- The Health workflow calls every callable every half hour (``ci-functions
  health``, no credentials) and fails when one does not answer for itself.
  On 2026-10-22 Google's automatic base-image update moved every function of
  all three apps onto a Node 22 runtime release (22.23.4, the eMudhra
  certificate fix) that did not start; every call answered 500 from about
  21:00 to 22:35 UTC, and the first to notice was a person who could not
  sign in.
- ``sync-functions-lock`` brings ``functions/package-lock.json`` in step
  with ``functions/package.json``, updated in place with each direct
  dependency at the root lock's version; ``check-app`` names it when the two
  disagree, which every Dependabot update of a functions dependency causes.
- ``pods [--check|--write]`` is the one way the pods are installed:
  ``build-ios``, ``ios-sim-build`` and the pre-merge iOS build run it. When
  pod install refuses the lock because a package moved a pod built from
  ``node_modules``, it updates those pods alone, so the trunk's stay pinned;
  ``--write`` on a Mac makes the ``app/Podfile.lock`` a native dependency
  update needs. The pre-merge SDK check names the ``npm install`` that takes
  a recommended version.
- The Linux runners take ffmpeg 7.0.2 as a static build from
  ffmpeg-static's ``b6.1.1`` GitHub release, checksum-pinned, with ffprobe,
  in place of apt: the runners' apt mirror stalled about one ffmpeg install in
  five, for up to 41 minutes, and failed pull requests at the step's timeout.
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
- ``check-app`` also requires Hosting's ``predeploy`` to be ``npm run
  web:export -w @sabeel/app`` alone; finds another emulator project named
  anywhere in ``scripts/``, the ``package.json`` files, ``firebase.json``,
  ``.firebaserc`` or ``functions/.env*``, not only after ``--project``; and
  requires the web push key committed as ``VAPID_PUBLIC_KEY`` in
  ``app/src/firebase-config.ts``, a P-256 public key. A ``sentry.gradle`` gate
  above ``def projectRoot``, or with none, is named as such by ``check-app``
  and ``build-aab``: Gradle stops on the unknown property.
- ``check-web-push`` sends people to ``VAPID_PUBLIC_KEY`` in
  ``app/src/firebase-config.ts``, where every app commits the public key.
- The uniform configuration's handoff is done: ``docs/PLAN.md`` is gone.
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
  code" when it migrates. ``ci-platform web`` runs ``check-web-push`` on
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
  ``test:emulator:functions``.
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
