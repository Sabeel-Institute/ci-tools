#!/usr/bin/env bash
set -euo pipefail

# The app's pods, installed into a freshly generated app/ios against the
# committed app/Podfile.lock. Needs macOS, Xcode and CocoaPods.
#
#   sabeel-ci pods            prebuild, then install the pods the lock pins
#   sabeel-ci pods --check    and fail unless they are the pods installed
#   sabeel-ci pods --write    and write the pods installed to app/Podfile.lock
#
# app/ios is regenerated every time, so without the lock each build resolves
# the third-party pods afresh and two builds of one commit can ship different
# native code (seen: a Mac and a runner a patch apart on AppCheckCore and
# GoogleUtilities). --repo-update, because a machine's local specs index goes
# stale and cannot find a pinned version; it cannot move a version, the lock
# decides those.
#
# A pod built from node_modules (the lock's EXTERNAL SOURCES) follows its npm
# package, and once a dependency update moves one, pod install refuses the
# lock. Those pods alone are then updated, so every pod from the CocoaPods
# trunk stays at the version the lock pins. Only PODS: is compared: the
# checksums of locally generated podspecs differ per machine.

usage="sabeel-ci pods [--check|--write]"
mode=${1:-}
case "$mode" in
  '' | --check | --write) ;;
  *) echo "pods: unknown option $mode ($usage)" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "pods: one option at most ($usage)" >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo "pods: needs macOS, Xcode and CocoaPods" >&2; exit 2; }
[ -f app/Podfile.lock ] || { echo "pods: there is no app/Podfile.lock to install against" >&2; exit 1; }

# ALWAYS --platform ios: prebuild is clean by default, and a bare one would
# delete the committed, hand-edited app/android. --no-install, because the pods
# are installed below against the pinned lock.
(cd app && CI=1 npx --no-install expo prebuild --platform ios --no-install)
cp app/Podfile.lock app/ios/Podfile.lock
if ! (cd app/ios && pod install --repo-update); then
  local_pods=()
  while IFS= read -r name; do local_pods+=("$name"); done < <(
    sed -n '/^EXTERNAL SOURCES:/,/^[A-Z]/s/^  "\{0,1\}\([^ :"][^:"]*\)"\{0,1\}:$/\1/p' app/ios/Podfile.lock)
  [ "${#local_pods[@]}" -gt 0 ] || { echo "pods: pod install failed, and the lock names no pod built from node_modules" >&2; exit 1; }
  echo "pods: pod install refused the lock; updating the ${#local_pods[@]} pods built from node_modules" >&2
  (cd app/ios && pod update --no-repo-update "${local_pods[@]}")
fi

pods_of() { sed -n '/^PODS:/,/^DEPENDENCIES:/p' "$1"; }
[ -n "$(pods_of app/Podfile.lock)" ] || { echo "pods: app/Podfile.lock has no PODS: section" >&2; exit 1; }
[ "$(pods_of app/Podfile.lock)" != "$(pods_of app/ios/Podfile.lock)" ] || exit 0
case "$mode" in
  --write)
    cp app/ios/Podfile.lock app/Podfile.lock
    echo "pods: app/Podfile.lock now holds the pods installed; commit it" >&2 ;;
  --check)
    echo "pods: pod install resolved other pods than app/Podfile.lock pins (a native dependency changed?)." >&2
    echo "If that is intended, run npx sabeel-ci pods --write on a Mac and commit app/Podfile.lock." >&2
    exit 1 ;;
esac
