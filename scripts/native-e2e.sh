#!/usr/bin/env bash
set -euo pipefail
# Native flows: the debug build against the emulators, driven by Maestro
# (`maestro/*.yaml`), on Android or the iOS simulator. They cover the seams the
# browser suites cannot reach (Yoga's layout, the keyboard, gestures, native
# pickers and editors, playback in the background) on a real build. CI runs
# exactly this.
#
#   sabeel-ci native-e2e                     # every flow, Android
#   sabeel-ci native-e2e maestro/<flow>.yaml # one flow
#   sabeel-ci native-e2e --ios [flow]        # the iOS simulator (macOS)
#   sabeel-ci native-e2e --build <dir> ...   # install what native-build made in <dir>
#
# Android needs one booted emulator (`sabeel-ci emulator headless` here,
# `ci-avd` in CI); iOS boots the simulator it built for (lib/ios-simulator.sh).
# Maestro comes from `install-maestro`. Each flow is told the installed app's
# id as APP_ID.
#
# It stamps the build and builds the debug app (`native-build`) unless given
# one, as the Native workflow does from its cache, starts the app's emulators
# (`sabeel-ci emulators`), runs the app's seed, scripts/seed-emulators.mjs
# (with a web dev server on the app's `web` port, its address in E2E_BASE, when
# native.seedWeb says the seed drives the web app), calls every callable once
# so the emulated functions are up (`ci-functions warm`), serves the JavaScript
# from Metro on 8081 with EXPO_PUBLIC_USE_EMULATORS=1, and runs the flows.
# Screenshots, Maestro's report and the logs land in shots/native/. It stops
# what it started; a held 8081 or web port is refused, since Metro's port is
# shared with the sibling apps.

usage="usage: sabeel-ci native-e2e [--ios] [--build <dir>] [flow]"
PLATFORM=android
BUILD=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ios) PLATFORM=ios; shift ;;
    --build)
      [ -n "${2:-}" ] || { echo "native-e2e: --build needs the directory native-build wrote ($usage)" >&2; exit 2; }
      BUILD=$(cd "$2" && pwd); shift 2 ;;
    -*) echo "native-e2e: unknown option $1 ($usage)" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ "$#" -le 1 ] || { echo "native-e2e: one flow or directory at most ($usage)" >&2; exit 2; }
FLOWS="${1:-maestro}"
OUT="$PWD/shots/native"
LOGS="$OUT/logs"
METRO_PORT=8081
# `ports` reads ci-tools.json through its checks, so the settings below are sound.
WEB_PORT=$(node "$CI_TOOLS/scripts/ports.mjs" web)
FIRESTORE_PORT=$(node "$CI_TOOLS/scripts/ports.mjs" firestore)
SEED=scripts/seed-emulators.mjs
SEED_WEB=$(node -p "require('./ci-tools.json').native?.seedWeb === true")
REVERSE=$(node -p "(require('./ci-tools.json').native?.reversePorts ?? []).join(' ')")
[ -f "$SEED" ] || { echo "native-e2e: no $SEED, the script that seeds the emulators for the flows" >&2; exit 1; }

pids_on_port() {
  if command -v ss >/dev/null; then ss -lptn "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true
  else lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true; fi
}
cwd_of() { readlink "/proc/$1/cwd" 2>/dev/null || lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }
# shellcheck disable=SC2317,SC2329 # used by cleanup, the EXIT trap
pid_tree() { local child; for child in $(pgrep -P "$1" 2>/dev/null); do pid_tree "$child"; done; echo "$1"; }
# shellcheck disable=SC2317,SC2329 # used by cleanup, the EXIT trap
stop_tree() { # stop_tree <pid>: TERM the pid and everything under it, then KILL what is left
  local pids
  pids=$(pid_tree "$1")
  # shellcheck disable=SC2086 # a list of pids
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    # shellcheck disable=SC2086
    kill -0 $pids 2>/dev/null || return 0
    sleep 0.5
  done
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

# One line every 20 s: memory, swap, disk, load and the largest processes by
# role. A GitHub runner that runs out of memory is shut down mid-step, before
# any later step (the artifact upload included) can run, so in CI the line goes
# to the job's log as well, which GitHub keeps as it streams.
sample_resources() {
  set +e +o pipefail
  local memory load disk largest
  while :; do
    if [ -r /proc/meminfo ]; then
      memory=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } /^SwapTotal:/ { st = $2 } /^SwapFree:/ { sf = $2 }
        END { printf "memory %.1f of %.1f GB available, swap %.1f GB used", a / 1048576, t / 1048576, (st - sf) / 1048576 }' /proc/meminfo)
      load=$(cut -d' ' -f1-3 /proc/loadavg)
    else
      memory="memory $(memory_pressure -Q 2>/dev/null | sed -n 's/.*free percentage: //p') free"
      load=$(sysctl -n vm.loadavg | tr -d '{}' | xargs)
    fi
    disk=$(df -Pk . | awk 'NR == 2 { printf "disk %.1f GB free", $4 / 1048576 }')
    largest=$(ps -Ao rss=,args= | sort -rn | head -7 | awk '{
        rss = $1; $1 = ""; n = split($2, path, "/"); role = path[n]
        if ($0 ~ /GradleDaemon/) role = "gradle"
        else if ($0 ~ /KotlinCompileDaemon/) role = "kotlin-daemon"
        else if ($0 ~ /cloud-firestore-emulator/) role = "firestore"
        else if ($0 ~ /qemu-system/) role = "avd"
        else if ($0 ~ /maestro/) role = "maestro"
        else if ($0 ~ /expo start/) role = "metro"
        else if ($0 ~ /firebase|emulators\.mjs/) role = "firebase"
        else if ($0 ~ /weed/) role = "seaweedfs"
        printf "%s%s %.1f", (NR > 1 ? ", " : ""), role, rss / 1048576 }')
    printf '[resources %s] %s, %s, load %s | largest (GB): %s\n' "$(date -u +%H:%M:%S)" "$memory" "$disk" "$load" "$largest"
    sleep 20
  done
}

# wait_for_quiet <load> <seconds> (macOS): until the one-minute load average
# is under <load>, for <seconds> at most; says how long it waited, and goes on
# regardless.
wait_for_quiet() {
  local waited=0 load
  while :; do
    load=$(sysctl -n vm.loadavg | awk '{ print int($2) }')
    if [ "$load" -lt "$1" ]; then
      echo "native-e2e: load $load after waiting ${waited}s for the simulator to quieten"
      return 0
    fi
    if [ "$waited" -ge "$2" ]; then
      echo "native-e2e: load still $load after ${waited}s; going on" >&2
      return 0
    fi
    sleep 10
    waited=$((waited + 10))
  done
}

if [ "$PLATFORM" = android ]; then
  APP_ID=$(node --input-type=module -e "import { debugAppId } from '$CI_TOOLS/scripts/lib/android-app.mjs'; process.stdout.write(debugAppId())")
  devices=$(adb devices | sed -n 's/\tdevice$//p')
  if [ "$(printf '%s\n' "$devices" | grep -c .)" -ne 1 ]; then
    echo "native-e2e: needs exactly one booted Android device; found: ${devices:-none}" >&2
    exit 1
  fi
else
  APP_ID=$(node -p "require('./app/app.json').expo.ios.bundleIdentifier")
fi
command -v maestro >/dev/null || PATH="$(bash "$CI_TOOLS/scripts/install-maestro.sh"):$PATH"
for port in "$METRO_PORT" "$WEB_PORT"; do
  for holder in $(pids_on_port "$port"); do
    echo "native-e2e: port $port is held by pid $holder ($(cwd_of "$holder")); refusing to start beside it" >&2
    exit 1
  done
done
rm -rf "$OUT"
mkdir -p "$LOGS"
# The flows' shared steps (ci-tools/tap-until.yaml, back-until.yaml, back.yaml,
# wait.yaml) come from here, copied in for each run: one copy across the apps,
# which Git ignores in each.
rm -rf maestro/ci-tools
cp -R "$CI_TOOLS/maestro" maestro/ci-tools

# shellcheck disable=SC2317,SC2329 # invoked by the EXIT trap
cleanup() {
  local rc=$? pid
  trap - EXIT INT TERM HUP
  for pid in "${MAESTRO_PID:-}" "${METRO_PID:-}" "${WEB_PID:-}" "${FB_PID:-}" "${RESOURCES_PID:-}"; do
    [ -z "$pid" ] || stop_tree "$pid"
  done
  # The Firebase CLI's own logs: why a function failed to load, which its
  # console line does not say.
  for log in firebase-debug.log firestore-debug.log; do
    [ ! -f "$log" ] || cp "$log" "$LOGS/"
  done
  bash "$CI_TOOLS/scripts/free-emulator-ports.sh" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

(
  if [ "${GITHUB_ACTIONS:-}" = true ]; then sample_resources | tee -a "$LOGS/resources.log"
  else sample_resources >>"$LOGS/resources.log"; fi
) &
RESOURCES_PID=$!

node "$CI_TOOLS/scripts/build-info.mjs"
if [ -z "$BUILD" ]; then
  BUILD="$OUT/build"
  echo "Building the debug app…"
  bash "$CI_TOOLS/scripts/native-build.sh" "$PLATFORM" "$BUILD" >/dev/null
fi
if [ "$PLATFORM" = android ]; then
  apk="$BUILD/app-debug.apk"
  [ -f "$apk" ] || { echo "native-e2e: no debug APK in $BUILD (sabeel-ci native-build android)" >&2; exit 1; }
  adb install -r "$apk" >/dev/null 2>&1 || { adb uninstall "$APP_ID" >/dev/null 2>&1 || true; adb install "$apk" >/dev/null; }
  echo "Installed $apk"
else
  app=$(find "$BUILD" -maxdepth 1 -name '*.app' | head -1)
  [ -n "$app" ] || { echo "native-e2e: no simulator app in $BUILD (sabeel-ci native-build ios)" >&2; exit 1; }
  # shellcheck source-path=SCRIPTDIR source=lib/ios-simulator.sh
  . "$CI_TOOLS/scripts/lib/ios-simulator.sh"
  DEVICE=$(ios_simulator)
  # Booted, or its boot (`sabeel-ci ios-boot`, the Native workflow's first
  # step) finished, then left to quieten before anything else starts. A
  # simulator that has just booted keeps a CI Mac busy for about eleven
  # minutes (load past 500 four minutes in, under 60 at eleven, measured with
  # nothing else running), and in that time LMS's seed missed the Auth
  # emulator's deadline, Kanban's seed clicked at a page that would not hold
  # still, Maestro's driver missed its startup timeout and a callable took
  # 40 s. Before the build was kept, the build took that time.
  xcrun simctl bootstatus "$DEVICE" -b >"$LOGS/simulator-boot.log" 2>&1 \
    || { echo "native-e2e: simulator $DEVICE did not boot; see $LOGS/simulator-boot.log" >&2; exit 1; }
  xcrun simctl install "$DEVICE" "$app"
  echo "Installed $APP_ID on simulator $DEVICE"
  wait_for_quiet 60 600
  # Maestro's driver starts on the simulator; ten minutes rather than its two.
  export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-600000}"
fi

wait_for() { # wait_for <url> <label> <tries>
  for _ in $(seq 1 "$3"); do
    curl -sf -o /dev/null "$1" && return 0
    sleep 3
  done
  echo "native-e2e: $2 never came up" >&2
  return 1
}

# NO_COLOR: in CI the Firebase CLI colours its log, which splits the line
# grepped below.
NO_COLOR=1 node "$CI_TOOLS/scripts/emulators.mjs" >"$LOGS/emulators.log" 2>&1 &
FB_PID=$!
wait_for "http://127.0.0.1:${FIRESTORE_PORT}/" firestore 100
# A seed that runs before onUserCreate is registered strands an account with
# no profile.
for _ in $(seq 1 60); do
  grep -q 'onUserCreate.*initialized' "$LOGS/emulators.log" && break
  sleep 3
done
grep -q 'onUserCreate.*initialized' "$LOGS/emulators.log" \
  || { echo "native-e2e: onUserCreate never registered; see $LOGS/emulators.log" >&2; exit 1; }

if [ "$SEED_WEB" = true ]; then
  # The seed drives the web app, so a web dev server runs for the seed alone.
  ( cd app && CI=1 EXPO_PUBLIC_USE_EMULATORS=1 exec npx expo start --web --port "$WEB_PORT" --clear \
      >"$LOGS/web.log" 2>&1 ) &
  WEB_PID=$!
  wait_for "http://127.0.0.1:${WEB_PORT}/" "the web dev server" 90
  # The page answers at once, but Metro builds the scripts it loads on their
  # first request, from a cleared cache: longer than the seed's page load waits
  # on a busy runner. Build them here, with Metro's own time to do it.
  scripts=$(curl -sf "http://127.0.0.1:${WEB_PORT}/" | grep -o '<script[^>]*src="[^"]*"' | sed 's/.*src="\([^"]*\)".*/\1/; s/&amp;/\&/g') || true
  [ -n "$scripts" ] || { echo "native-e2e: the web dev server's page loads no script; see $LOGS/web.log" >&2; exit 1; }
  for script in $scripts; do
    curl -sf -o /dev/null --max-time 600 "http://127.0.0.1:${WEB_PORT}${script}" \
      || { echo "native-e2e: Metro could not bundle the web app; see $LOGS/web.log" >&2; exit 1; }
  done
fi
E2E_BASE="http://127.0.0.1:${WEB_PORT}/" node "$SEED" >"$LOGS/seed.log" 2>&1 \
  || { echo "native-e2e: the seed failed; see $LOGS/seed.log" >&2; exit 1; }
# Every callable once, so each emulated function's worker is up before a flow
# needs it: a first call can take longer than a flow waits (`ci-functions warm`).
node "$CI_TOOLS/scripts/ci-functions.mjs" warm >"$LOGS/warm.log" 2>&1 \
  || { echo "native-e2e: the emulated functions did not all start; see $LOGS/warm.log" >&2; exit 1; }
if [ -n "${WEB_PID:-}" ]; then stop_tree "$WEB_PID"; WEB_PID=; fi
# What the app reaches on this machine's 127.0.0.1 (LMS's media store signs
# its URLs for it), which on the Android emulator is the emulator itself. The
# iOS simulator shares this machine's network.
if [ "$PLATFORM" = android ]; then
  for name in $REVERSE; do
    port=$(node "$CI_TOOLS/scripts/ports.mjs" "$name")
    adb reverse "tcp:$port" "tcp:$port" >/dev/null
  done
fi

# The debug build loads its JavaScript from 10.0.2.2:8081 at launch.
( cd app && CI=1 EXPO_PUBLIC_USE_EMULATORS=1 EXPO_PUBLIC_E2E=1 exec npx expo start --port "$METRO_PORT" --clear \
    >"$LOGS/metro.log" 2>&1 ) &
METRO_PID=$!
wait_for "http://127.0.0.1:${METRO_PORT}/status" Metro 60
# Bundle before launch, so a bundling failure fails here with Metro's log rather
# than as a flow timing out on a red screen. Expo serves the app's entry at its
# virtual path; /index.bundle is a 404.
echo "Bundling for ${PLATFORM}…"
curl -sf -o /dev/null --max-time 600 \
  "http://127.0.0.1:${METRO_PORT}/.expo/.virtual-metro-entry.bundle?platform=${PLATFORM}&dev=true&minify=false" \
  || { echo "native-e2e: Metro could not bundle the app; see $LOGS/metro.log" >&2; exit 1; }

run_flows() {
  maestro ${DEVICE:+--device "$DEVICE"} test "$FLOWS" -e APP_ID="$APP_ID" \
    --format junit --output "$OUT/report.xml" --test-output-dir "$OUT" &
  MAESTRO_PID=$!
  local status=0
  wait "$MAESTRO_PID" || status=$?
  MAESTRO_PID=
  return "$status"
}

rc=0
[ "$PLATFORM" = ios ] || adb logcat -c
run_flows || rc=$?
if [ "$PLATFORM" = android ]; then
  adb logcat -d >"$LOGS/logcat.txt" 2>&1 || true
  # Debug builds only: React Native's renderer sometimes dies in
  # MountingCoordinator::pullTransaction as the app loads from Metro (three
  # times across the apps on 2026-10-21; never in a release build, which
  # check-release cold-starts on every build). When that is the failure, the
  # flows run once more and the first try's log is kept. Any other failure
  # stands.
  if [ "$rc" -ne 0 ] && grep -q 'MountingCoordinator::pullTransaction' "$LOGS/logcat.txt"; then
    echo "native-e2e: the debug build hit React Native's pullTransaction crash; running the flows once more" >&2
    mv "$LOGS/logcat.txt" "$LOGS/logcat-first-try.txt"
    adb logcat -c
    rc=0
    run_flows || rc=$?
    adb logcat -d >"$LOGS/logcat.txt" 2>&1 || true
  fi
else
  # Maestro's iOS driver sometimes loses an element it is snapshotting while
  # the screen changes, and reports the device unreachable: the driver failed,
  # not the app. Run the flows once more when that is the failure.
  if [ "$rc" -ne 0 ] && grep -q 'DeviceUnreachableException' "$OUT/report.xml" 2>/dev/null; then
    echo "native-e2e: Maestro lost its iOS driver; running the flows once more" >&2
    mv "$OUT/report.xml" "$OUT/report-first-try.xml"
    rc=0
    run_flows || rc=$?
  fi
  # Only for a failure: reading the simulator's log takes minutes (2 to 10 in CI).
  if [ "$rc" -ne 0 ]; then
    xcrun simctl spawn "$DEVICE" log show --last 30m --style compact 2>/dev/null | tail -n 20000 >"$LOGS/device.txt" || true
  fi
fi
# What Maestro could see when the flows failed: the labels to match against.
if [ "$rc" -ne 0 ]; then
  maestro ${DEVICE:+--device "$DEVICE"} hierarchy >"$LOGS/hierarchy-at-failure.json" 2>/dev/null || true
fi
exit "$rc"
