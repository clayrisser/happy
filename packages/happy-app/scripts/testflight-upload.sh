#!/bin/sh
# Export the archive and upload it to TestFlight (BASED-98).
#
# altool EXITS 0 ON A FAILED UPLOAD (it burned three uploads on SHC-108), so
# the verdict is the literal string "UPLOAD SUCCEEDED", never the exit code.
# Uploading is also not distributing: after processing, the build must still
# be ASSIGNED to a beta group and the assignment VERIFIED by re-reading
# GET /v1/betaGroups/{id}/builds. See cattle-drover/docs/wrist-install.md.
set -eu

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
IOS_DIR="$APP_DIR/ios"
BUILD_DIR="$IOS_DIR/build"

die() {
	printf 'testflight-upload: %s\n' "$*" >&2
	exit 1
}
log() { printf '==> %s\n' "$*"; }

DROVER_DIR="${DROVER_DIR:-$HOME/Projects/bitspur/cattle-drover}"
[ -r "$DROVER_DIR/etc/asc.env" ] && . "$DROVER_DIR/etc/asc.env"
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_PATH ASC_TEAM_ID; do
	eval "val=\${$v:-}"
	[ -n "$val" ] || die "$v is not set (see cattle-drover/etc/asc.env)"
done

WORKSPACE=$(find "$IOS_DIR" -maxdepth 1 -name '*.xcworkspace' ! -name 'Pods*' | head -n 1)
SCHEME=$(basename "$WORKSPACE" .xcworkspace)
ARCHIVE="$BUILD_DIR/$SCHEME.xcarchive"
IPA="$BUILD_DIR/$SCHEME.ipa"
[ -d "$ARCHIVE" ] || die "no archive at $ARCHIVE — run testflight-archive.sh first"
[ -f "$BUILD_DIR/build-number.txt" ] || die "no build-number.txt — run testflight-archive.sh first"
expect=$(cat "$BUILD_DIR/build-number.txt")

# Render ExportOptions with the team id; the file is tiny and deterministic.
EXPORT_OPTS="$BUILD_DIR/ExportOptions.plist"
cat >"$EXPORT_OPTS" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>destination</key>
	<string>export</string>
	<key>method</key>
	<string>app-store-connect</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>stripSwiftSymbols</key>
	<true/>
	<key>teamID</key>
	<string>$ASC_TEAM_ID</string>
	<key>uploadSymbols</key>
	<true/>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
</dict>
</plist>
EOF

log "exporting ipa"
rm -f "$IPA"
xcodebuild -exportArchive \
	-archivePath "$ARCHIVE" \
	-exportOptionsPlist "$EXPORT_OPTS" \
	-exportPath "$BUILD_DIR" \
	-allowProvisioningUpdates \
	-authenticationKeyPath "$ASC_KEY_PATH" \
	-authenticationKeyID "$ASC_KEY_ID" \
	-authenticationKeyIssuerID "$ASC_ISSUER_ID"

if [ ! -f "$IPA" ]; then
	found=$(find "$BUILD_DIR" -maxdepth 1 -name '*.ipa' | head -n 1)
	[ -n "$found" ] || die "export produced no .ipa in $BUILD_DIR"
	mv "$found" "$IPA"
fi

# Last gate before the one irreversible step: a build number is spent the
# moment Apple accepts it, so read it out of the actual .ipa.
tmp=$(mktemp -d)
unzip -o -q "$IPA" 'Payload/*' -d "$tmp" || die "could not unpack $IPA"
ipa_app=$(find "$tmp/Payload" -maxdepth 1 -name '*.app' 2>/dev/null | head -n 1)
[ -n "$ipa_app" ] || die "no Payload/*.app inside $IPA"
got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ipa_app/Info.plist" 2>/dev/null || true)

# The push entitlement, read off the artifact Apple actually receives. This is
# the only place it can be read: automatic signing picks a DEVELOPMENT identity
# at archive time and the export is what re-signs Apple Distribution, so the
# archive reads development on a build whose ipa reads production (measured on
# build 4, 2026-08-29). `expo prebuild` writes development into the
# entitlements every single run and ios/ is generated, so the value cannot be
# committed — testflight-archive.sh sets it, and this proves it survived. A
# build carrying development registers its tokens against the APNs SANDBOX
# while Expo pushes to production: the phone stays silent and every other
# signal — token registered, server says sent — still reads healthy.
aps=$(codesign -d --entitlements :- "$ipa_app" 2>/dev/null |
	plutil -extract aps-environment raw -o - - 2>/dev/null || true)
rm -rf "$tmp"
[ "$got" = "$expect" ] || die "ipa carries CFBundleVersion '$got', expected '$expect'"
case "$aps" in
production) log "aps-environment is production — push will reach the phone" ;;
development) die "the ipa carries aps-environment=development — its push tokens would land on the APNs sandbox and no notification would ever arrive" ;;
*) log "warning: could not read aps-environment off the ipa" ;;
esac

log "uploading $IPA (build $expect) to TestFlight"
out_file=$(mktemp)
trap 'rm -f "$out_file"' EXIT INT TERM
xcrun altool --upload-app -f "$IPA" -t ios \
	--apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | tee "$out_file" || true

grep -q "UPLOAD SUCCEEDED" "$out_file" ||
	die "altool did not report UPLOAD SUCCEEDED — the build was NOT delivered"
log "UPLOAD SUCCEEDED — build $expect; Apple processing usually takes 5-15 minutes"
