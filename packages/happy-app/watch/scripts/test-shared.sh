#!/bin/sh
# Run the watch wire checks on the Mac (BASED-98).
#
# Not an XCTest bundle: DroverSnapshot.swift imports Foundation and nothing
# else, so it compiles and runs here in about a second with no simulator, no
# test host and no scheme in the grafted project. `pnpm watch:verify` and an
# xcodebuild of the DroverWatch target prove the app builds; this proves the
# format the phone and the wrist have to agree on.
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
out=$(mktemp -d)

swiftc -o "$out/shared-wire-test" \
	"$root/DroverWatch/Shared/DroverSnapshot.swift" \
	"$root/tests/SharedWireTests.swift"

"$out/shared-wire-test"
