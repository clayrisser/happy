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
	"$root/DroverWatch/Shared/DroverDemo.swift" \
	"$root/tests/SharedWireTests.swift"

"$out/shared-wire-test"

# Every push in the navigation stack has to be VALUE-based (DROVE-10).
#
# A view-based `NavigationLink { SessionListView() }` in the toolbar silently
# killed the value-based links on the session rows inside it: SwiftUI built
# SessionDetailView — its strings showed up in the log — and then never
# presented it, so tapping a session did nothing at all. No warning, no crash,
# no missing destination. Nothing about that shows up in a compile or in the
# wire checks above, and it survived two builds on Clay's wrist, so the guard
# has to be on the source itself. Comment lines are skipped because the one in
# GateListView describes the bug.
offenders=$(grep -rn 'NavigationLink' "$root/DroverWatch" |
	grep -v 'NavigationLink(value:' |
	grep -v '^[^:]*:[0-9]*:[[:space:]]*//' || true)
if [ -n "$offenders" ]; then
	echo "FAIL: a NavigationLink that is not value-based (DROVE-10):"
	echo "$offenders"
	exit 1
fi
echo "ok: every NavigationLink in DroverWatch is value-based (DROVE-10)"
