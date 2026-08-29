#!/bin/sh
# Run a ruby script under an interpreter that actually has the xcodeproj gem
# (BASED-98).
#
# Never `ruby <script>`. A bare command resolves through PATH and the first
# ruby on a stock Mac is /usr/bin/ruby — system 2.6, with no xcodeproj — so
# the graft dies with "cannot load such file -- xcodeproj" and the watch app
# is simply absent from the generated project. The Podfile hook learned this
# and uses Gem.ruby; every other caller (prebuild's config plugin, the
# watch:graft and watch:verify package scripts) shelled out to the bare name
# and could not prebuild at all from a shell whose PATH did not front-load
# homebrew's ruby.
#
# Candidates are PROBED rather than assumed: the interpreter that counts is
# the one that can `require "xcodeproj"`, so ask it. DROVER_RUBY overrides for
# a box that keeps its ruby elsewhere.
set -eu

[ $# -ge 1 ] || {
	printf 'with-ruby: usage: with-ruby.sh <script.rb> [args...]\n' >&2
	exit 2
}

candidates="${DROVER_RUBY:-} /opt/homebrew/opt/ruby/bin/ruby /opt/homebrew/bin/ruby /usr/local/opt/ruby/bin/ruby /usr/local/bin/ruby ruby"

for ruby in $candidates; do
	if "$ruby" -e 'require "xcodeproj"' >/dev/null 2>&1; then
		exec "$ruby" "$@"
	fi
done

printf 'with-ruby: no ruby here can require the xcodeproj gem (tried:%s).\n' "$candidates" >&2
printf 'with-ruby: install CocoaPods, or point DROVER_RUBY at a ruby that has it.\n' >&2
exit 1
