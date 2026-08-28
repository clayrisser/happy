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
unzip -o -q -j "$IPA" 'Payload/*.app/Info.plist' -d "$tmp" ||
	die "could not read Payload/*.app/Info.plist out of $IPA"
got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$tmp/Info.plist" 2>/dev/null || true)
rm -rf "$tmp"
[ "$got" = "$expect" ] || die "ipa carries CFBundleVersion '$got', expected '$expect'"

log "uploading $IPA (build $expect) to TestFlight"
out_file=$(mktemp)
trap 'rm -f "$out_file"' EXIT INT TERM
xcrun altool --upload-app -f "$IPA" -t ios \
	--apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | tee "$out_file" || true

grep -q "UPLOAD SUCCEEDED" "$out_file" ||
	die "altool did not report UPLOAD SUCCEEDED — the build was NOT delivered"
log "UPLOAD SUCCEEDED — build $expect; Apple processing usually takes 5-15 minutes"
