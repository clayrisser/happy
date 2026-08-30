#!/bin/sh
# Archive the Cattle Drover build for TestFlight (BASED-98).
#
# Run AFTER `pnpm prebuild:ios` with the drover overrides exported
# (DROVER_BUNDLE_ID, DROVER_APP_NAME, APP_ENV). ASC identity comes from
# ~/Projects/bitspur/cattle-drover/etc/asc.env or the environment.
#
# The assertions are ported from the Lookout lane (BASED-88/BASED-94):
# xcodebuild's exit status alone shipped a build that aborted on first launch,
# so the archive is only trusted after its artifacts are read back.
set -eu

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
IOS_DIR="$APP_DIR/ios"
BUILD_DIR="$IOS_DIR/build"

die() {
	printf 'testflight-archive: %s\n' "$*" >&2
	exit 1
}
log() { printf '==> %s\n' "$*"; }

DROVER_DIR="${DROVER_DIR:-$HOME/Projects/bitspur/cattle-drover}"
[ -r "$DROVER_DIR/etc/asc.env" ] && . "$DROVER_DIR/etc/asc.env"
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_PATH ASC_TEAM_ID; do
	eval "val=\${$v:-}"
	[ -n "$val" ] || die "$v is not set (see cattle-drover/etc/asc.env)"
done
[ -f "$ASC_KEY_PATH" ] || die "no ASC key at $ASC_KEY_PATH"

# Discover the generated project: the name follows the (overridable) Expo app
# name, so never hardcode it — the same rule as the watch graft.
WORKSPACE=$(find "$IOS_DIR" -maxdepth 1 -name '*.xcworkspace' ! -name 'Pods*' | head -n 1)
[ -n "$WORKSPACE" ] || die "no .xcworkspace under $IOS_DIR — run pnpm prebuild:ios first"
SCHEME=$(basename "$WORKSPACE" .xcworkspace)
ARCHIVE="$BUILD_DIR/$SCHEME.xcarchive"
INFO_PLIST="$IOS_DIR/$SCHEME/Info.plist"

build_number=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO_PLIST")
marketing=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")

# The hermesc that ships INSIDE the hermes-engine pod is the only compiler
# that cannot disagree with the VM the app embeds. The Lookout lane shipped a
# build that passed archive, export, App Store validation and ASC processing
# and then aborted on every device with "Wrong bytecode version. Expected 98
# but got 96" because the Pods xcconfig pointed HERMES_CLI_PATH at
# node_modules/hermes-compiler instead. Passing the pod's own hermesc on the
# command line beats the xcconfig; the assertion below is the proof.
HERMESC="$IOS_DIR/Pods/hermes-engine/destroot/bin/hermesc"
[ -x "$HERMESC" ] || die "no hermesc at $HERMESC — has pod install run?"

hbc_version() {
	xxd -s 8 -l 4 -p "$1" 2>/dev/null || true
}

# Every pod expo's autolinking resolves must be in the CocoaPods lockfile. A
# module that lands in node_modules while `pod install` has not run since is
# absent from the generated ExpoModulesProvider, and nothing in the build path
# says so: the app compiles, signs, uploads and passes App Store processing,
# then JS dies before React mounts with "Cannot find native module
# 'ExpoTaskManager'" — a black screen, no card, nothing on the wrist. Build 4
# reached TestFlight exactly that way (2026-08-29), because expo-task-manager
# arrived with the background-wake commit and ios/ predated it.
LOCKFILE="$IOS_DIR/Podfile.lock"
[ -f "$LOCKFILE" ] || die "no Podfile.lock at $LOCKFILE — has pod install run?"
autolinked=$(cd "$APP_DIR" && node --no-warnings -e "require('expo/bin/autolinking')" \
	expo-modules-autolinking resolve --platform apple --json 2>/dev/null |
	node -e 'let s = "";
	process.stdin.on("data", function (d) { s += d; }).on("end", function () {
		(JSON.parse(s).modules || []).forEach(function (m) {
			(m.pods || []).forEach(function (p) { console.log(p.podName); });
		});
	});')
[ -n "$autolinked" ] || die "expo-modules-autolinking resolved no pods — cannot tell whether the integrated native module set is stale"
for pod in $autolinked; do
	grep -qE "^  - $pod( |\(|:)" "$LOCKFILE" ||
		die "$pod is autolinked but absent from $LOCKFILE — run 'cd ios && pod install'; without it this build launches to a black screen with \"Cannot find native module '$pod'\""
done
log "all $(printf '%s\n' "$autolinked" | wc -l | tr -d ' ') autolinked pods are integrated"

# `expo prebuild` writes aps-environment=development into the entitlements
# every single time, and ios/ is generated so the value cannot be committed.
# A TestFlight build carrying it registers its device tokens against the APNs
# SANDBOX while Expo pushes to production, so the phone stays silent and every
# other signal — token registered, server says sent — still reads healthy.
# EAS Build rewrites this for a release profile; a hand-rolled xcodebuild does
# not, so set it here.
#
# Do NOT try to prove it by reading the entitlement back off the signed
# ARCHIVE. Automatic signing picks a DEVELOPMENT identity at archive time on
# this Mac, and a development profile clamps aps-environment to development —
# measured on build 4 (2026-08-29): the archive was signed "Apple Development:
# Benjamin RISSER" and read development, while the ipa exported from that same
# archive was re-signed "Apple Distribution" and read production. So the
# assertion could never pass, and it failed a build that was perfectly good.
# The signed read-back that means anything is on the ipa Apple receives, and it
# lives in testflight-upload.sh.
ENTITLEMENTS="$IOS_DIR/$SCHEME/$SCHEME.entitlements"
[ -f "$ENTITLEMENTS" ] || die "no entitlements at $ENTITLEMENTS — run pnpm prebuild:ios first"
/usr/libexec/PlistBuddy -c 'Set :aps-environment production' "$ENTITLEMENTS" 2>/dev/null ||
	/usr/libexec/PlistBuddy -c 'Add :aps-environment string production' "$ENTITLEMENTS" ||
	die "could not set aps-environment in $ENTITLEMENTS"
# Set can report success on a plist it did not actually change, so read it back.
[ "$(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$ENTITLEMENTS" 2>/dev/null || true)" = production ] ||
	die "aps-environment is still not production in $ENTITLEMENTS"

log "archiving $SCHEME $marketing ($build_number) for the App Store"
rm -rf "$ARCHIVE"
xcodebuild archive \
	-workspace "$WORKSPACE" \
	-scheme "$SCHEME" \
	-configuration Release \
	-destination 'generic/platform=iOS' \
	-archivePath "$ARCHIVE" \
	-allowProvisioningUpdates \
	-authenticationKeyPath "$ASC_KEY_PATH" \
	-authenticationKeyID "$ASC_KEY_ID" \
	-authenticationKeyIssuerID "$ASC_ISSUER_ID" \
	DEVELOPMENT_TEAM="$ASC_TEAM_ID" \
	HERMES_CLI_PATH="$HERMESC"

APP="$ARCHIVE/Products/Applications/$SCHEME.app"
[ -d "$APP" ] || die "archive has no $APP"

assert_version() {
	got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$1" 2>/dev/null || true)
	[ "$got" = "$build_number" ] ||
		die "CFBundleVersion in $1 is '$got', expected '$build_number' — phone and watch must agree or Apple rejects the upload"
}
assert_version "$APP/Info.plist"
watch_app=$(find "$APP/Watch" -maxdepth 1 -name '*.app' 2>/dev/null | head -n 1)
[ -n "$watch_app" ] || die "archive contains no embedded watch app — the graft did not reach this build"
assert_version "$watch_app/Info.plist"
widget=$(find "$watch_app/PlugIns" -maxdepth 1 -name '*.appex' 2>/dev/null | head -n 1)
[ -n "$widget" ] || die "watch app embeds no widget appex"
assert_version "$widget/Info.plist"

# The archived JS must carry the bytecode version the embedded VM reads.
probe_dir=$(mktemp -d)
printf 'var drover_hbc_probe = 1;\n' >"$probe_dir/probe.js"
"$HERMESC" -emit-binary -out "$probe_dir/probe.hbc" "$probe_dir/probe.js" >/dev/null 2>&1 ||
	die "hermesc probe compile failed with $HERMESC"
want_hbc=$(hbc_version "$probe_dir/probe.hbc")
got_hbc=$(hbc_version "$APP/main.jsbundle")
rm -rf "$probe_dir"
[ -n "$got_hbc" ] || die "no readable main.jsbundle in the archive"
[ "$got_hbc" = "$want_hbc" ] ||
	die "main.jsbundle bytecode version $got_hbc != hermesc's $want_hbc — this build would abort on first launch (Lookout build 202608280323)"
log "hermes bytecode version $got_hbc matches the embedded VM"

# The JS half of the app reads its identity from a SECOND copy of the config,
# which expo-constants generates from app.config.js during the build — so it
# takes the DROVER_* environment of whatever shell ran xcodebuild, not the
# values prebuild stamped into Info.plist. Archive without the overrides
# exported and you get a build that is named, signed and versioned correctly
# and still tells everything reading Constants that it is upstream's app.
# Nothing else in the build disagrees, which is what makes it worth asserting.
CONFIG="$APP/EXConstants.bundle/app.config"
[ -f "$CONFIG" ] || die "archive has no $CONFIG"
config_id=$(plutil -extract ios.bundleIdentifier raw -o - "$CONFIG" 2>/dev/null || true)
plist_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2>/dev/null || true)
[ "$config_id" = "$plist_id" ] ||
	die "the embedded app.config says bundle id '$config_id' but the signed app is '$plist_id' — export DROVER_BUNDLE_ID before archiving"

# Expo looks push credentials up per (experience, bundle id), so upstream's
# project id with our bundle id is a pair nobody can hold an APNs key for:
# every send dies at Expo with InvalidCredentials while the app, the server and
# the bridge all still read healthy (BASED-98). The literal below is the
# fallback in app.config.js. A warning, not a die — the build ships fine, it
# just cannot push.
case "$(plutil -extract extra.eas.projectId raw -o - "$CONFIG" 2>/dev/null || true)" in
4558dd3d-cd5a-47cd-bad9-e591a241cc06)
	log "warning: this build registers under upstream's Expo project, so every push fails with InvalidCredentials — set DROVER_EAS_PROJECT_ID and DROVER_EAS_OWNER to fix it"
	;;
esac

mkdir -p "$BUILD_DIR"
printf '%s\n' "$build_number" >"$BUILD_DIR/build-number.txt"
log "archived build $build_number at $ARCHIVE"
