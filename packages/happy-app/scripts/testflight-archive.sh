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

mkdir -p "$BUILD_DIR"
printf '%s\n' "$build_number" >"$BUILD_DIR/build-number.txt"
log "archived build $build_number at $ARCHIVE"
