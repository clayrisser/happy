#!/bin/sh
# DROVE-104. Proves the wire dist-freshness guard actually catches a stale dist,
# by making one real. It moves ONE source file's mtime forward, runs the check,
# and puts the mtime back. It never writes file contents and never deletes the
# dist, so it is safe to run while other worktrees are building.
#
#   sh packages/happy-wire/bin/prove-stale-dist-check.sh [wire-dir]
#
# Default wire-dir is the wire package this script lives in. In a git worktree
# that is the worktree's OWN copy, which is what you want here: the shared main
# checkout keeps its mtimes untouched.
set -e

bin_dir=$(cd "$(dirname "$0")" && pwd)
checker="$bin_dir/check-dist-fresh.cjs"
wire_dir=${1:-$(cd "$bin_dir/.." && pwd)}
target="$wire_dir/src/sessionProtocol.ts"

if [ ! -f "$target" ]; then
	echo "prove-stale-dist-check: no such source file: $target" >&2
	exit 2
fi

if [ ! -d "$wire_dir/dist" ]; then
	echo "== building $wire_dir so there is a dist to make stale"
	(cd "$wire_dir" && pnpm --filter @slopus/happy-wire build >/dev/null)
fi

original=$(node -e 'process.stdout.write(String(require("node:fs").statSync(process.argv[1]).mtimeMs))' "$target")

restore() {
	node -e 'const f=require("node:fs");const d=new Date(Number(process.argv[2]));f.utimesSync(process.argv[1],d,d)' "$target" "$original"
}
trap restore EXIT INT TERM

echo "== 1. fresh dist: the check must PASS"
if ! node "$checker" --wire-dir "$wire_dir"; then
	echo "prove-stale-dist-check: precondition failed, the dist was already stale." >&2
	echo "Run 'pnpm --filter @slopus/happy-wire build' first." >&2
	exit 2
fi

echo
echo "== 2. stale dist: mtime of src/sessionProtocol.ts moved 60s past the dist"
node -e 'const f=require("node:fs");const d=new Date(Date.now()+60000);f.utimesSync(process.argv[1],d,d)' "$target"
if node "$checker" --wire-dir "$wire_dir"; then
	echo "prove-stale-dist-check: FAILED. A stale dist was accepted." >&2
	exit 1
fi
echo "(exit 1, as it must be)"

echo
echo "== 3. mtime restored: the check must PASS again"
restore
trap - EXIT INT TERM
node "$checker" --wire-dir "$wire_dir"

echo
echo "prove-stale-dist-check: PASS. The guard catches a stale dist and clears once rebuilt."
