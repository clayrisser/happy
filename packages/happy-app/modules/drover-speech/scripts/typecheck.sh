#!/bin/sh
# Typecheck the phone's speech module without a prebuild (DROVE-275).
#
# WHY THIS EXISTS. The watch has had `watch/scripts/test-shared.sh` since
# DROVE-130 and it catches a typo in about eight seconds. DroverSpeechModule
# had NOTHING: the only way to learn it did not compile was a full
# `expo prebuild` + `pod install` + `xcodebuild`, which is half an hour, so in
# practice nobody ran it and player changes went to a build unverified. That is
# the procedural half of why the now-playing card shipped three times and was
# never seen working — every piece needed a native build and none of them were
# cheap to check.
#
# It typechecks ONLY. It does not link, sign, or run, and it cannot tell you
# the module still registers with Expo. It tells you the file compiles, which
# is the failure that actually kept happening.
#
# ANY MODULE SOURCE, not only this one (DROVE-275). DroverWatchModule.swift had
# the same nothing, and the wrist half of the player is written in it, so the
# arguments are the files to check and this module's own is the default. The
# wrapper at modules/drover-watch/scripts/typecheck.sh is the second caller.
#
# HOW IT FINDS ExpoModulesCore. The module imports it, so the check needs the
# compiled `.swiftmodule` plus the Clang headers behind it. Both are dropped by
# any real build of the app, so this reuses the newest DerivedData for
# CattleDrover rather than building anything itself. No build on this box yet
# means no module to check against, and the script SKIPS rather than fails --
# the same rule test-shared.sh uses for a missing watchOS SDK, so a fresh
# checkout is not a red X for a thing it cannot do anything about.
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
app=$(cd "$root/../.." && pwd)
pods="$app/ios/Pods"

if [ ! -d "$pods/Headers/Public" ]; then
	echo "skip: no ios/Pods here, so the speech module was not typechecked"
	exit 0
fi

# Newest first: a stale DerivedData still typechecks fine, but the newest one
# matches the pods on disk, and a mismatch shows up as a missing header rather
# than as a wrong answer.
products=""
for d in $(ls -dt "$HOME"/Library/Developer/Xcode/DerivedData/CattleDrover-* 2>/dev/null); do
	found=$(find "$d" -type d -name ExpoModulesCore -path '*BuildProductsPath*' 2>/dev/null | head -1)
	if [ -n "$found" ] && [ -f "$found/ExpoModulesCore.modulemap" ]; then
		products="$found"
		break
	fi
done
if [ -z "$products" ]; then
	echo "skip: no built ExpoModulesCore in DerivedData, so the speech module was not typechecked"
	exit 0
fi

sdk=$(xcrun --sdk iphoneos --show-sdk-path 2>/dev/null || true)
if [ -z "$sdk" ]; then
	echo "skip: no iPhoneOS SDK here, so the speech module was not typechecked"
	exit 0
fi

# Every pod's public headers. The umbrella header of ExpoModulesCore reaches
# into ExpoModulesJSI and React-Core, and those reach further still, so naming
# them one at a time is a losing game -- the whole directory is cheaper and the
# only cost is a longer command line.
incs=""
for d in "$pods"/Headers/Public/*/; do
	incs="$incs -Xcc -I$d"
done

# The files to check. This module's own source unless the caller named others,
# so `sh typecheck.sh` still means what it always meant.
if [ "$#" -eq 0 ]; then
	set -- "$root/ios/DroverSpeechModule.swift"
fi

# shellcheck disable=SC2086
swiftc -typecheck -sdk "$sdk" -target arm64-apple-ios15.1 \
	-I "$products" \
	-Xcc -fmodule-map-file="$products/ExpoModulesCore.modulemap" \
	-Xcc -I"$products" \
	-Xcc -I"$pods/Headers/Public" \
	$incs \
	"$@" 2>&1 |
	grep -v '^ *[0-9]* |' |
	grep -v "warning: umbrella header" |
	grep -v '^ *| ' |
	grep -v '^$' || true

# The pipe above eats swiftc's status, so ask again for the answer only.
# shellcheck disable=SC2086
if swiftc -typecheck -sdk "$sdk" -target arm64-apple-ios15.1 \
	-I "$products" \
	-Xcc -fmodule-map-file="$products/ExpoModulesCore.modulemap" \
	-Xcc -I"$products" \
	-Xcc -I"$pods/Headers/Public" \
	$incs \
	"$@" >/dev/null 2>&1; then
	for f in "$@"; do
		echo "ok: $(basename "$f" .swift) typechecks against $(basename "$sdk")"
	done
else
	echo "FAIL: $* does not typecheck"
	exit 1
fi
