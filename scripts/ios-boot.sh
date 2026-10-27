#!/usr/bin/env bash
set -euo pipefail
# Start booting the iPhone simulator native-build builds for and native-e2e
# runs on, and return at once:
#
#   sabeel-ci ios-boot
#
# A simulator that has just booted keeps a CI Mac busy for about eleven
# minutes: widget extensions, health, shortcuts and diagnostics services
# (measured on macos-26, 3 cores, nothing else running: load past 500 four
# minutes in, under 60 at eleven). Whatever runs in that time runs slowly, and
# the seed, Maestro's driver and the emulated functions missed their
# timeouts. The Native workflow starts the boot first, so the time passes
# under its setup and any build, and native-e2e waits out what is left.

[ "$(uname)" = Darwin ] || { echo "ios-boot: needs macOS and Xcode" >&2; exit 2; }
: "${CI_TOOLS:?run this as sabeel-ci ios-boot}"
# shellcheck source-path=SCRIPTDIR source=lib/ios-simulator.sh
. "$CI_TOOLS/scripts/lib/ios-simulator.sh"
udid=$(ios_simulator)
xcrun simctl boot "$udid" >/dev/null 2>&1 &
echo "Booting simulator $udid"
