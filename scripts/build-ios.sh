#!/usr/bin/env bash
set -euo pipefail

# Build the iOS app and export a signed App Store .ipa, without Xcode's UI.
#
#   sabeel-ci build-ios           # every gate, then archive and export to build/ios/export
#   sabeel-ci build-ios --check   # every gate, build nothing
#
# Runs on a Mac and on GitHub's macOS runners (the iOS workflow). It never
# uploads: the workflow's TestFlight job is the one way a build reaches Apple,
# and it first asks whether this is the released commit and whether the build
# number is free (sabeel-ci testflight-check).
#
# Signing is AUTOMATIC by default: Xcode mints and fetches the distribution
# certificate and profile through the App Store Connect key, which suits a Mac
# a person keeps. With IOS_PROFILE_NAME set it is MANUAL: the app target signs
# with the Apple Distribution identity already in the keychain and that App
# Store profile, and nothing is minted. A runner needs manual: automatic
# signing on a fresh machine creates a certificate every run and throws its
# private key away, until Apple's certificate limit stops every build of the
# team (the apps share one certificate).
#
# Command line rather than the Xcode GUI: Xcode runs build phases in a
# sanitised environment and, since Xcode 15, ignores the terminal that launched
# it, so a GUI archive cannot see the Sentry token and uploads no symbols, with
# no error. xcodebuild inherits this shell.

CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    -h | --help)
      sed -n '4,/^$/s/^# \{0,1\}//p' "$0"
      exit 0
      ;;
    *)
      echo "build-ios: unknown option $arg (sabeel-ci build-ios [--check])" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "$@" >&2
  exit 1
}
: "${CI_TOOLS:?build-ios runs through sabeel-ci: npx sabeel-ci build-ios}"

# ---------------------------------------------------------------- gates

# The platform. Elsewhere the failure would name a missing binary, not the reason.
[ "$(uname -s)" = Darwin ] || die "build-ios needs macOS: an iOS archive cannot be made elsewhere."
command -v xcodebuild >/dev/null || die "xcodebuild not found. Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app"
command -v pod >/dev/null || die "CocoaPods not found: brew install cocoapods"

# A release talks to production. Metro inlines every EXPO_PUBLIC_* from the
# environment and from app/.env.local, so the dev loop's
# EXPO_PUBLIC_USE_EMULATORS=1 in either would ship an app that talks to
# 127.0.0.1, and nothing in the archive would say so.
[ -z "${EXPO_PUBLIC_USE_EMULATORS:-}" ] || die "EXPO_PUBLIC_USE_EMULATORS is set in this shell.
A build from here would point at the local emulators. Unset it, or use a fresh terminal."
if grep -qE '^[[:space:]]*EXPO_PUBLIC_USE_EMULATORS[[:space:]]*=[[:space:]]*[^[:space:]]' app/.env.local 2>/dev/null; then
  die "app/.env.local sets EXPO_PUBLIC_USE_EMULATORS. A build from here would point at the
local emulators. Remove the line; the dev loop passes the flag on its own command line."
fi

# The build machine's values, loaded before the config check so it does not
# warn about values this script is about to supply.
# shellcheck source-path=SCRIPTDIR source=lib/load-build-env.sh
. "$CI_TOOLS/scripts/lib/load-build-env.sh"

app_json() { node -p "require('./app/app.json').expo.$1"; }
setting() { node -p "require('./ci-tools.json').ios.$1 === true"; }

# The iOS config: the plist against app.json, the Firebase project, the
# sign-in URL scheme, the push entitlement's plugin, export compliance, Apple's
# version shape, the build number, the icon, the native Sentry DSN, the privacy
# manifest. It also validates ci-tools.json, which `setting` reads below.
node "$CI_TOOLS/scripts/check-ios-config.mjs"

NAME="$(app_json name)"
VERSION="$(app_json version)"
BUILD_NUMBER="$(app_json ios.buildNumber)"
BUNDLE_ID="$(app_json ios.bundleIdentifier)"

# Release notes, where the app keeps them (ci-tools.json ios.releaseNotes):
# they must exist BEFORE the build, as for an Android release. They are the
# release's notes and the only record of why it exists.
if [ "$(setting releaseNotes)" = true ]; then
  npm run --silent release-notes -- "$VERSION" >/dev/null || die "No release notes for v${VERSION} (npm run release-notes -- ${VERSION}).
Write them first: they are the release's notes and the only record of why it exists."
fi

[ -n "${IOS_TEAM_ID:-}" ] || die "IOS_TEAM_ID is not set.
Put it in app/.env.sentry-build-plugin: developer.apple.com -> Membership details -> Team ID."

missing_sentry=""
for v in SENTRY_ORG SENTRY_PROJECT SENTRY_AUTH_TOKEN; do
  [ -n "${!v:-}" ] || missing_sentry="${missing_sentry} ${v}"
done
if [ -n "$missing_sentry" ]; then
  echo "WARNING:${missing_sentry} not set: this build uploads no debug symbols or source maps," >&2
  echo "so iOS crashes will report raw addresses. Building anyway." >&2
fi

# The App Store Connect key. In automatic mode `-allowProvisioningUpdates`
# MINTS AND DOWNLOADS the signing assets through it, so the archive needs it,
# not only an upload. ASC_KEY_PATH defaults to where Apple's own tooling looks;
# `~` is expanded here because a dotenv value is a literal string.
if [ -n "${ASC_KEY_ID:-}" ]; then
  : "${ASC_KEY_PATH:=${HOME}/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
  ASC_KEY_PATH="${ASC_KEY_PATH/#\~/$HOME}"
fi

# Manual signing: the named profile must be installed, be for THIS app, and
# not have expired. Xcode says each of these too, but only after prebuild and
# pod install. The apps sign with one certificate, so another app's profile is
# the easy one to install here by mistake.
PROFILE_PLIST=""
PROFILE_EXPIRES=""
if [ -n "${IOS_PROFILE_NAME:-}" ]; then
  PROFILE_PLIST="$(mktemp)"
  trap 'rm -f "$PROFILE_PLIST"' EXIT
  found=false
  for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision \
    "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision; do
    [ -f "$f" ] || continue
    security cms -D -i "$f" >"$PROFILE_PLIST" 2>/dev/null || continue
    if [ "$(plutil -extract Name raw "$PROFILE_PLIST")" = "$IOS_PROFILE_NAME" ]; then
      found=true
      break
    fi
  done
  [ "$found" = true ] || die "IOS_PROFILE_NAME is \"${IOS_PROFILE_NAME}\", and no installed provisioning profile has that name.
Xcode reads them from ~/Library/Developer/Xcode/UserData/Provisioning Profiles."
  PROFILE_APP="$(plutil -extract Entitlements.application-identifier raw "$PROFILE_PLIST")"
  [ "$PROFILE_APP" = "${IOS_TEAM_ID}.${BUNDLE_ID}" ] || die "Profile \"${IOS_PROFILE_NAME}\" is for ${PROFILE_APP}, not ${IOS_TEAM_ID}.${BUNDLE_ID}."
  PROFILE_EXPIRES="$(plutil -extract ExpirationDate raw "$PROFILE_PLIST")"
  [[ "$PROFILE_EXPIRES" > "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ]] || die "Profile \"${IOS_PROFILE_NAME}\" expired ${PROFILE_EXPIRES}.
docs/IOS-BUILD.md, \"Builds on GitHub\", has how to renew it."
fi

# The signing keychain has to be USABLE, and the only proof is signing
# something. On a Mac reached over ssh the login keychain is LOCKED (it unlocks
# at GUI login; `launchctl managername` says Background, not Aqua). `security
# find-identity` still lists valid identities, because a certificate is public
# data, and the archive then dies at the first framework it signs with
# errSecInternalComponent, twenty minutes in.
KEYCHAIN="$(security default-keychain -d user | tr -d ' "')"
UNLOCK_HELP="Unlock it in THIS session, then re-run:

  security unlock-keychain ${KEYCHAIN}

Type the password at the prompt rather than passing -p, which puts the account
password in shell history. Over ssh each login is its own security session, so
unlock in the same one that builds. It does not survive a reboot."

security show-keychain-info "$KEYCHAIN" >/dev/null 2>&1 || die "The signing keychain is locked:
  ${KEYCHAIN}

${UNLOCK_HELP}"

# Locked is the usual cause but not the only one: a private key's ACL can refuse
# a session with no window server even when the keychain is open. Signing a
# throwaway binary exercises the mechanism the archive uses, in about a second.
#
# In automatic mode no identity is not an error: -allowProvisioningUpdates
# mints one through the App Store Connect key. Manual mode signs as "Apple
# Distribution", so that identity must be here, and the profile must carry its
# certificate: a renewed certificate needs a profile made on it, and installing
# one without the other is the mistake to expect.
if [ -n "${IOS_PROFILE_NAME:-}" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | awk '/"Apple Distribution: / {print $2; exit}')"
  [ -n "$SIGN_ID" ] || die "IOS_PROFILE_NAME is set (manual signing), but the keychain holds no Apple Distribution identity.
Import the distribution .p12 first."
  carried=false
  n="$(plutil -extract DeveloperCertificates raw "$PROFILE_PLIST")"
  for ((i = 0; i < n; i++)); do
    sha="$(plutil -extract "DeveloperCertificates.$i" raw "$PROFILE_PLIST" | base64 --decode | shasum -a 1 | awk '{print toupper($1)}')"
    [ "$sha" != "$SIGN_ID" ] || carried=true
  done
  [ "$carried" = true ] || die "Profile \"${IOS_PROFILE_NAME}\" does not carry the certificate of the
Apple Distribution identity in the keychain (${SIGN_ID}). Make a profile on that
certificate, or import the certificate the profile was made on."
else
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | awk '/^ *1\)/ {print $2}')"
fi
if [ -n "$SIGN_ID" ]; then
  PROBE_DIR="$(mktemp -d)"
  cp /bin/echo "${PROBE_DIR}/probe"
  if ! codesign --force --sign "$SIGN_ID" "${PROBE_DIR}/probe" >/dev/null 2>&1; then
    rm -rf "$PROBE_DIR"
    die "The keychain is unlocked, but codesign cannot USE the signing identity.
Signing a throwaway binary with ${SIGN_ID} failed; the archive would fail the
same way at its first framework, twenty minutes from now.

Usually the private key's ACL refuses a session with no window server:

  security set-key-partition-list -S apple-tool:,apple:,codesign: -s ${KEYCHAIN}

${UNLOCK_HELP}"
  fi
  rm -rf "$PROBE_DIR"
else
  echo "note: no codesigning identity in the keychain; automatic signing mints" >&2
  echo "one during the archive. Nothing to prove here yet." >&2
fi

# The commit the sign-in screen will show. `+` marks a dirty tree: a build
# that maps to no commit, which the workflow refuses to ship.
COMMIT="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  COMMIT="${COMMIT}+"
  echo "WARNING: uncommitted changes; this build is stamped ${COMMIT} and maps to no commit." >&2
fi

echo
echo "app          ${NAME} (${BUNDLE_ID})"
echo "version      ${VERSION}  (build ${BUILD_NUMBER}, commit ${COMMIT})"
echo "team         ${IOS_TEAM_ID}"
echo "signing      $([ -n "${IOS_PROFILE_NAME:-}" ] && echo "manual, profile \"${IOS_PROFILE_NAME}\" (expires ${PROFILE_EXPIRES})" || echo "automatic")"
echo "symbols      ${SENTRY_PROJECT:-<none>}"
echo

if [ "$CHECK_ONLY" = true ]; then
  echo "--check: every gate passed; nothing was built."
  exit 0
fi

# ---------------------------------------------------------------- build

# Stamp the commit, immediately before the build so the stamp is the commit
# that is built: through EXPO_PUBLIC_COMMIT, which Metro inlines when the
# archive's bundle phase runs, and through the app's own build-info hook where
# it has one (ci-tools.json ios.buildInfo).
export EXPO_PUBLIC_COMMIT="$COMMIT"
if [ "$(setting buildInfo)" = true ]; then npm run --silent build-info; fi

# Regenerate app/ios. ALWAYS --platform ios: prebuild is clean by default, and
# a bare one would delete the committed, hand-edited app/android.
# --no-install, because the pods are installed below against the pinned lock.
(cd app && CI=1 npx --no-install expo prebuild --platform ios --no-install)

# The pods the app ships, pinned by the committed app/Podfile.lock. app/ios is
# regenerated on every build, so without the lock each build resolves the
# third-party pods afresh and two builds of one commit can ship different
# native code (seen: a Mac and a runner a patch apart on AppCheckCore and
# GoogleUtilities). --repo-update, because a machine's local specs index goes
# stale and cannot find a pinned version; it cannot move a version, the lock
# decides those. Only PODS: is compared, as the pre-merge build does: the
# checksums of locally generated podspecs differ per machine.
cp app/Podfile.lock app/ios/Podfile.lock
(cd app/ios && pod install --repo-update)
pods_of() { sed -n '/^PODS:/,/^DEPENDENCIES:/p' "$1"; }
if [ "$(pods_of app/Podfile.lock)" != "$(pods_of app/ios/Podfile.lock)" ]; then
  die "pod install resolved other pods than app/Podfile.lock pins (a native dependency changed?).
If that is intended: cp app/ios/Podfile.lock app/Podfile.lock, commit it, and build again."
fi

WORKSPACE="$(find app/ios -maxdepth 1 -name '*.xcworkspace' | head -1)"
[ -n "$WORKSPACE" ] || die "no .xcworkspace under app/ios after prebuild and pod install."

# The scheme comes from the APP PROJECT, never the workspace: once pods are
# integrated the workspace has a scheme per pod, the first alphabetically is
# `AppAuth`, and archiving a pod SUCCEEDS with no app inside. The pre-merge
# build picks it by the same rule.
PROJECT="$(find app/ios -maxdepth 1 -name '*.xcodeproj' | head -1)"
[ -n "$PROJECT" ] || die "no .xcodeproj under app/ios after prebuild."
SCHEME="$(xcodebuild -project "$PROJECT" -list -json | node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { appScheme } = await import(process.env.CI_TOOLS + "/scripts/ci-premerge.mjs");
  console.log(appScheme(JSON.parse(readFileSync(0, "utf8")).project, process.argv[1]));
' "$(basename "$PROJECT" .xcodeproj)")" || die "could not determine the app's Xcode scheme from $PROJECT."
echo "scheme       ${SCHEME}"

# Manual signing for the APP TARGET ONLY, written into the regenerated project.
# On the xcodebuild command line PROVISIONING_PROFILE_SPECIFIER would reach
# every pod target too, and each fails with "does not support provisioning
# profiles". The xcodeproj gem ships with CocoaPods.
if [ -n "${IOS_PROFILE_NAME:-}" ]; then
  ruby -rxcodeproj -e '
    project = Xcodeproj::Project.open(ARGV[0])
    target = project.native_targets.find { |t| t.name == ARGV[1] } or abort("no target #{ARGV[1]} in #{ARGV[0]}")
    target.build_configurations.select { |c| c.name == "Release" }.each do |c|
      c.build_settings["CODE_SIGN_STYLE"] = "Manual"
      c.build_settings["CODE_SIGN_IDENTITY"] = "Apple Distribution"
      c.build_settings["CODE_SIGN_IDENTITY[sdk=iphoneos*]"] = "Apple Distribution"
      c.build_settings["PROVISIONING_PROFILE_SPECIFIER"] = ARGV[2]
      c.build_settings["DEVELOPMENT_TEAM"] = ARGV[3]
    end
    attributes = (project.root_object.attributes["TargetAttributes"] ||= {})
    (attributes[target.uuid] ||= {})["ProvisioningStyle"] = "Manual"
    project.save
  ' "$PROJECT" "$SCHEME" "$IOS_PROFILE_NAME" "$IOS_TEAM_ID"
fi

OUT=build/ios
ARCHIVE="${OUT}/${SCHEME}-${VERSION}-${BUILD_NUMBER}.xcarchive"
EXPORT_DIR="${OUT}/export"
rm -rf "$ARCHIVE" "$EXPORT_DIR"
mkdir -p "$OUT"

# Manual signing fetches nothing, so it takes neither the key nor
# -allowProvisioningUpdates: with either, Xcode could still mint. In automatic
# mode the key goes in whole or not at all, and its file must exist.
#
# Both arrays expand as ${A[@]+"${A[@]}"}: macOS ships bash 3.2, where an EMPTY
# array under `set -u` is "unbound" and the script would die naming a variable
# declared right here. Bash 4.4 and later do not, so it cannot be reproduced
# elsewhere.
AUTH=()
PROVISIONING=()
if [ -z "${IOS_PROFILE_NAME:-}" ]; then
  PROVISIONING=(-allowProvisioningUpdates)
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -f "${ASC_KEY_PATH:-}" ]; then
    AUTH=(-authenticationKeyPath "${ASC_KEY_PATH}"
      -authenticationKeyID "${ASC_KEY_ID}"
      -authenticationKeyIssuerID "${ASC_ISSUER_ID}")
  fi
fi

xcodebuild -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  ${PROVISIONING[@]+"${PROVISIONING[@]}"} \
  ${AUTH[@]+"${AUTH[@]}"} \
  DEVELOPMENT_TEAM="$IOS_TEAM_ID" \
  archive

[ -d "$ARCHIVE" ] || die "xcodebuild reported success but produced no archive at $ARCHIVE."
# An archive of a library is a valid .xcarchive with no app in it; the only
# later symptom is an export error about the `method` key.
[ -d "$ARCHIVE/Products/Applications" ] || die "archive at $ARCHIVE contains no app: scheme '$SCHEME' is not the app's."

# Export a signed .ipa for App Store Connect. `destination: export` writes it
# to disk and sends nothing anywhere.
PLIST="${OUT}/ExportOptions.plist"
if [ -n "${IOS_PROFILE_NAME:-}" ]; then
  SIGNING="<key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${IOS_PROFILE_NAME}</string></dict>"
else
  SIGNING="<key>signingStyle</key><string>automatic</string>"
fi
cat >"$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>${IOS_TEAM_ID}</string>
  ${SIGNING}
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLISTEOF

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$PLIST" \
  ${PROVISIONING[@]+"${PROVISIONING[@]}"} \
  ${AUTH[@]+"${AUTH[@]}"}

IPA="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' | head -1)"
[ -n "$IPA" ] || die "the export wrote no .ipa to ${EXPORT_DIR}."
echo
echo "Exported v${VERSION} (build ${BUILD_NUMBER}, commit ${COMMIT}) to ${IPA}. Nothing was uploaded;"
echo "TestFlight takes the iOS workflow's build of the release tag, with testflight=true."
