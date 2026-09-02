#!/bin/sh
# Run the voice pick over a fixture list on the Mac (DROVE-390).
#
# Not an XCTest bundle, and not the typecheck: ios/DroverVoicePick.swift
# imports Foundation and nothing else, so it compiles and runs here in about a
# second with no simulator, no pods and no DerivedData, the same way
# watch/scripts/test-shared.sh proves the wrist decisions. `typecheck.sh`
# proves the module still compiles against ExpoModulesCore; this proves what
# it PICKS, which is the thing that shipped wrong: a phone with only compact
# en-US voices read with Albert.
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
out=$(mktemp -d)

swiftc -o "$out/voice-pick-test" \
	"$root/ios/DroverVoicePick.swift" \
	"$root/tests/VoicePickTests.swift"

"$out/voice-pick-test"
