#!/usr/bin/env bash
# Print the home of a JDK 21 or later, for the Firebase emulators, which are
# Java and refuse an older one. The Android build keeps 17 as the default
# `java`, so this changes nothing; a caller points only the emulators at it:
#
#   JAVA_HOME=$(npx --no sabeel-ci jdk21) && export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
#
# Looks, in order, at SABEEL_JDK21_HOME, ~/opt/jdk-21, JAVA_HOME (CI's
# setup-java), the `java` on PATH, then where a Mac keeps one: `java_home -v
# 21`, Homebrew's openjdk@21, Android Studio's runtime. Each is run, not trusted
# for existing: on a Mac /usr/bin/java always exists, as a stub that exits 1.
# Without this the failure comes from firebase, after the emulators' banner, as
# "Process `java -version` has exited with code 1", and reads like emulators
# that started and then died.
set -uo pipefail

# The major version of the java at $1, or nothing when it does not run.
major() {
  "$1" -version 2>&1 | sed -n '1s/.*version "\([0-9]*\)\.\{0,1\}\([0-9]*\).*/\1 \2/p' | {
    read -r first second || exit 0
    if [ "$first" = 1 ]; then echo "$second"; else echo "$first"; fi
  }
}

tried=()
# Print $2 and succeed when it is the home of a JDK 21+; note what $1 held.
try() {
  local found=""
  if [ -n "$2" ] && [ -x "$2/bin/java" ]; then found=$(major "$2/bin/java"); fi
  if [ -n "$found" ] && [ "$found" -ge 21 ]; then
    echo "$2"
    return 0
  fi
  if [ -n "$found" ]; then tried+=("$1: Java $found"); else tried+=("$1: none"); fi
  return 1
}

if [ -n "${SABEEL_JDK21_HOME:-}" ]; then
  try SABEEL_JDK21_HOME "$SABEEL_JDK21_HOME" && exit 0
  echo "SABEEL_JDK21_HOME is $SABEEL_JDK21_HOME, which is not the home of a JDK 21 or later (${tried[0]#*: })" >&2
  exit 1
fi
try "$HOME/opt/jdk-21" "$HOME/opt/jdk-21" && exit 0
try JAVA_HOME "${JAVA_HOME:-}" && exit 0
if command -v java >/dev/null 2>&1; then
  try "the java on PATH" "$(java -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java\.home = //p')" && exit 0
fi
try "java_home -v 21" "$(/usr/libexec/java_home -v 21 2>/dev/null)" && exit 0
try "Homebrew's openjdk@21" /opt/homebrew/opt/openjdk@21 && exit 0
try "Homebrew's openjdk@21 (Intel)" /usr/local/opt/openjdk@21 && exit 0
try "Android Studio's runtime" "/Applications/Android Studio.app/Contents/jbr/Contents/Home" && exit 0

{
  echo "No JDK 21 or later found; the Firebase emulators are Java and need one. Looked at:"
  printf '  %s\n' "${tried[@]}"
  echo "Set SABEEL_JDK21_HOME to the home of a JDK 21, or install one at ~/opt/jdk-21."
} >&2
exit 1
