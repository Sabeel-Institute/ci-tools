# shellcheck shell=bash
# Source me, at the app's root. Exports the build machine's values from the
# gitignored app/.env.sentry-build-plugin.
#
#   . "$CI_TOOLS/scripts/lib/load-build-env.sh"
#
# A release build needs values that are not the app's and must never be
# committed: the Sentry auth token for the symbol upload, the Apple team id,
# and the App Store Connect key id and issuer. xcodebuild and the Sentry build
# phase read the process environment; neither reads app/.env.local, which is
# Expo's, for inlining EXPO_PUBLIC_* into the bundle. One gitignored file
# instead of shell exports survives a new terminal and stays out of shell
# history. On GitHub it is written from the BUILD_ENV secret (sabeel-ci
# ci-platform prepare-ios, and prepare-android, whose sentry.gradle reads the
# token from it too). The Sentry org and project are ci-tools.json's.
#
# Parsed rather than sourced: a dotenv file is not shell, and sourcing one runs
# whatever is in it. Comments and blank lines are skipped, a value keeps any
# `=` it contains, and the space and one pair of quotes around it are dropped,
# as the dotenv reader that masks it in CI drops them. An empty value
# is not a value (the file may carry blank placeholders), and a variable
# already in the environment wins, so `IOS_TEAM_ID=... sabeel-ci build-ios`
# is not overwritten by the file.
if [ -f app/.env.sentry-build-plugin ]; then
  while IFS='=' read -r _lb_key _lb_val || [ -n "$_lb_key" ]; do
    _lb_key="${_lb_key#"${_lb_key%%[![:space:]]*}"}"
    _lb_key="${_lb_key%"${_lb_key##*[![:space:]]}"}"
    case "$_lb_key" in '' | '#'*) continue ;; esac
    case "$_lb_key" in
      [!A-Za-z_]* | *[!A-Za-z0-9_]*)
        echo "app/.env.sentry-build-plugin: \"$_lb_key\" is not a variable name" >&2
        unset _lb_key _lb_val
        return 1
        ;;
    esac
    _lb_val="${_lb_val%$'\r'}"
    _lb_val="${_lb_val#"${_lb_val%%[![:space:]]*}"}"
    _lb_val="${_lb_val%"${_lb_val##*[![:space:]]}"}"
    case "$_lb_val" in \"*\" | \'*\') _lb_val="${_lb_val:1:${#_lb_val}-2}" ;; esac
    [ -n "$_lb_val" ] || continue
    [ -z "${!_lb_key:-}" ] || continue
    export "$_lb_key=$_lb_val"
  done <app/.env.sentry-build-plugin
  unset _lb_key _lb_val
fi
