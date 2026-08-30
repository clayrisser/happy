#!/bin/sh
# Run the watch wire checks on the Mac (BASED-98).
#
# Not an XCTest bundle: everything under DroverWatch/Shared imports Foundation
# and nothing else, so it compiles and runs here in about a second with no
# simulator, no test host and no scheme in the grafted project. `pnpm
# watch:verify` and an xcodebuild of the DroverWatch target prove the app
# builds; this proves the format the phone and the wrist have to agree on, and
# the decision behind the wrist buzz (DROVE-62) — which matters here because
# the watch simulator has no Taptic Engine, so that decision cannot be checked
# anywhere else short of a real wrist.
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
out=$(mktemp -d)

swiftc -o "$out/shared-wire-test" \
	"$root/DroverWatch/Shared/DroverSnapshot.swift" \
	"$root/DroverWatch/Shared/WristCue.swift" \
	"$root/tests/SharedWireTests.swift"

"$out/shared-wire-test"
