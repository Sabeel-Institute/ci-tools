#!/usr/bin/env bash
# This machine's Android emulator: the AVD tb_emu (or SABEEL_AVD), a Pixel 6
# at 1080x2400 on API 35 with a Google APIs image, so Play services and Google
# Sign-In work. A GitHub runner boots its own with ci-avd.
#
#   sabeel-ci emulator headless        # no window (automation; software GPU)
#   sabeel-ci emulator window          # a window, to use it at the computer
#   sabeel-ci emulator list            # running AVDs, who started them, and adb's devices
#   sabeel-ci emulator shot <name>     # a screenshot to shots/<name>.png
#   sabeel-ci emulator kill [serial]   # emulator-5554 unless named
#
# Every app's sessions share the one AVD, so `headless` and `window` refuse to
# boot it twice and name the process already running it, with the directory
# it was started in: it may be another session's run. Use it, or ask before
# stopping it.
set -euo pipefail

export ANDROID_HOME="${ANDROID_HOME:-$HOME/opt/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
AVD="${SABEEL_AVD:-tb_emu}"

usage() {
  echo "usage: sabeel-ci emulator headless|window|list|shot <name>|kill [serial]" >&2
  exit 2
}

# The emulators running an AVD, as "pid avd": matched on the program, never on
# a pattern over whole command lines, which would also match this script's
# callers.
running() {
  ps -eo pid=,args= | awk '$2 ~ /qemu-system/ {
    for (i = 3; i < NF; i++) if ($i == "-avd") { print $1, $(i + 1); next }
  }'
}

refuse_if_running() {
  local pid
  pid=$(running | awk -v avd="$AVD" '$2 == avd && !found { print $1; found = 1 }')
  [ -z "$pid" ] && return 0
  echo "$AVD is already running: pid $pid, started $(ps -o lstart= -p "$pid" 2>/dev/null) in $(readlink "/proc/$pid/cwd" 2>/dev/null || lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')." >&2
  echo "It may be another session's. Use it as it is, or ask before stopping it." >&2
  exit 1
}

# The CPU acceleration flags for this host, decided per boot.
#
# `-accel auto`, the default, does not fall back to software for an x86_64
# image: it exits at once with "x86_64 emulation currently requires hardware
# acceleration!", which reads as a broken emulator. Only `-accel off` selects
# QEMU's software CPU; `-gpu swiftshader_indirect` covers the GPU alone. A host
# with KVM, the usual case, gets no flag and runs at full speed. Both spellings
# of a usable result are matched: `-accel-check` says "accel: 0" on some builds
# and "KVM (version N) is installed and usable" on others, and matching one
# alone sends an accelerated host down the slow path.
ACCEL=()
accel_flags() {
  local out
  out=$(emulator -accel-check 2>&1 | tr '\n' ' ' || true)
  case "$out" in
    *"is installed and usable"* | *"accel:0"* | *"accel: 0"*) return 0 ;;
  esac
  ACCEL=(-accel off)
  echo "No CPU acceleration on this host ($out)." >&2
  echo "Falling back to software CPU (-accel off): expect several minutes to boot" >&2
  echo "and ~14 s per screencap. Input stays usable." >&2
}

boot() {
  [ -x "$ANDROID_HOME/emulator/emulator" ] || {
    echo "No Android emulator at $ANDROID_HOME/emulator: set ANDROID_HOME to the Android SDK" >&2
    exit 1
  }
  refuse_if_running
  accel_flags
}

case "${1:-}" in
  headless)
    boot
    exec emulator -avd "$AVD" -no-window -no-boot-anim -gpu swiftshader_indirect -no-snapshot ${ACCEL[@]+"${ACCEL[@]}"}
    ;;
  window)
    boot
    exec emulator -avd "$AVD" -gpu host -no-snapshot ${ACCEL[@]+"${ACCEL[@]}"}
    ;;
  list)
    running | while read -r pid avd; do
      echo "$avd: pid $pid, in $(readlink "/proc/$pid/cwd" 2>/dev/null || lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    done
    # `adb devices` starts adb's server when none runs: a live server is not a
    # running emulator, which is why the AVDs above come from ps.
    adb devices | grep -E 'emulator-|device$' || echo "no devices"
    ;;
  shot)
    name="${2:-shot}"
    case "$name" in */* | .*) usage ;; esac
    mkdir -p shots
    adb exec-out screencap -p >"shots/$name.png.part"
    mv "shots/$name.png.part" "shots/$name.png"
    echo "wrote shots/$name.png"
    ;;
  kill)
    adb -s "${2:-emulator-5554}" emu kill
    ;;
  *) usage ;;
esac
