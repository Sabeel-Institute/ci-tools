#!/usr/bin/env bash
set -euo pipefail

# Install the Android SDK packages the Gradle build would otherwise fetch for
# itself, with retries: the NDK and build tools at the versions React Native's
# version catalog names, and CMake at the Android Gradle Plugin's default, which
# every native module that names no version builds with. Gradle fetches them
# once and fails the build on a bad download: Google's SDK downloads arrived
# truncated ("Error on ZipFile unknown archive") three times on 2026-10-21, and
# on 2026-10-23 two modules configuring at once both fetched CMake and one read
# the other's half-written archive. Run after `npm ci`.
#
#   sabeel-ci ci-android-sdk

: "${ANDROID_HOME:?ANDROID_HOME is not set}"
catalog=node_modules/react-native/gradle/libs.versions.toml
version() {
  local found
  found=$(sed -n "s/^$1 = \"\(.*\)\"$/\1/p" "$catalog")
  [ -n "$found" ] || { echo "ci-android-sdk.sh: no $1 in $catalog" >&2; exit 1; }
  echo "$found"
}
# AGP's default CMake (8.12 uses 3.22.1); a build that wants another still
# fetches it, as before.
cmake=3.22.1
packages=("ndk;$(version ndkVersion)" "build-tools;$(version buildTools)" "cmake;$cmake")
sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

yes | "$sdkmanager" --licenses >/dev/null || true
for attempt in 1 2 3; do
  if "$sdkmanager" --install "${packages[@]}" >/dev/null; then
    echo "Installed ${packages[*]}"
    exit 0
  fi
  echo "SDK install failed (attempt $attempt); retrying" >&2
  sleep 10
done
echo "ci-android-sdk.sh: ${packages[*]} would not install" >&2
exit 1
