#!/bin/sh
# Typecheck the phone's watch bridge without a prebuild (DROVE-275).
#
# DroverWatchModule.swift is the phone half of every wrist feature, and until
# now the only way to learn it did not compile was a full `expo prebuild` +
# `pod install` + `xcodebuild`. The watch app has had a cheap check since
# DROVE-130 and the speech module got one tonight; this is the third file that
# a player change touches and it had nothing.
#
# All of the work is in the speech module's script, which takes the files to
# check as its arguments. One copy of the DerivedData hunt, not three.
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
speech=$(cd "$root/../drover-speech" && pwd)

sh "$speech/scripts/typecheck.sh" "$root/ios/DroverWatchModule.swift"
