#!/bin/sh
# Measure the audio cues against the voice, and fail when one has drifted.
#
# DROVE-341. Clay: "the beeping sounds, like the heartbeat and stuff, are a lot
# quieter than the voice that talks back."
#
# The cue table in sources/voice/cueLoudness.ts states each cue's level in dB
# relative to the voice, with the voice pinned at -16 LUFS integrated. That is a
# claim about sound, so a unit test cannot check it. This can:
#
#   1. Speak a sentence with `say`, which drives the same AVSpeechSynthesizer
#      voices the reader uses, and measure it with ffmpeg loudnorm.
#   2. Render every cue from the app's own generator and measure each one.
#   3. Compare each cue against what its table entry claims, and against the
#      voice, and exit nonzero if anything is outside tolerance.
#
# There are no cue assets to normalise: every cue is synthesised. So the
# "original" that is kept is the generator, and the calibration lives in
# cueLoudness.ts rather than in a wav somebody re-recorded.
#
# The voice measured here is the BUILD MACHINE's voice, not the phone's, and
# the two are not the same voice. The system voices on this Mac measured -16.20
# and -18.92 LUFS, so -16 is the loud end of that band; the final word is a
# phone with the media slider at one setting. This script is what stops the
# arithmetic drifting between those checks.
#
# Usage:
#   sh scripts/measure-cue-loudness.sh              measure and check
#   sh scripts/measure-cue-loudness.sh --keep DIR   leave the wavs in DIR

set -eu

tolerance_lu=2
voice_target=-16
voice_text="The heartbeat should be roughly the same level as the voice that talks back, so he does not have to blast the audio just to hear the beeping. This sentence is long enough to give the loudness meter several complete gating blocks to chew on."

app_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
keep_dir=""
if [ "${1:-}" = "--keep" ]; then
    keep_dir=${2:?--keep needs a directory}
fi

for tool in ffmpeg node npx; do
    command -v "$tool" >/dev/null 2>&1 || {
        printf 'measure-cue-loudness: %s is not on PATH\n' "$tool" >&2
        exit 2
    }
done

if [ -n "$keep_dir" ]; then
    mkdir -p "$keep_dir"
    work=$keep_dir
else
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT INT TERM
fi

# Integrated loudness of one file, in LUFS, from ffmpeg's loudnorm analysis
# pass. -nostdin matters: without it ffmpeg eats the loop's stdin and every
# iteration after the first measures nothing.
integrated() {
    ffmpeg -nostdin -hide_banner -nostats -i "$1" \
        -af loudnorm=print_format=json -f null - 2>&1 |
        grep '"input_i"' |
        sed 's/.*: "//; s/".*//'
}

printf 'measuring the voice reference with say(1)\n'
if command -v say >/dev/null 2>&1; then
    say -o "$work/voice.aiff" "$voice_text"
    voice_lufs=$(integrated "$work/voice.aiff")
else
    printf '  say(1) is not here, so the pinned reference stands in\n'
    voice_lufs=$voice_target
fi
printf '  voice: %s LUFS (table is pinned at %s)\n\n' "$voice_lufs" "$voice_target"

printf 'rendering the cues from the app generator\n'
(cd "$app_dir" && npx tsx scripts/render-cues.ts "$work/cues") >/dev/null
printf '\n'

printf '%-18s %9s %9s %9s %9s  %s\n' CUE CLAIM MEASURED 'vs CLAIM' 'vs VOICE' VERDICT
failed=0
while IFS='	' read -r id file expected; do
    [ -n "$id" ] || continue
    measured=$(integrated "$work/cues/$file")
    verdict=$(awk -v m="$measured" -v e="$expected" -v v="$voice_lufs" -v t="$tolerance_lu" '
        BEGIN {
            dc = m - e
            dv = m - v
            printf "%+.2f\t%+.2f\t%s", dc, dv, ((dc < 0 ? -dc : dc) <= t ? "ok" : "DRIFTED")
        }')
    d_claim=$(printf '%s' "$verdict" | cut -f1)
    d_voice=$(printf '%s' "$verdict" | cut -f2)
    state=$(printf '%s' "$verdict" | cut -f3)
    printf '%-18s %9s %9s %9s %9s  %s\n' \
        "$id" "$expected" "$measured" "$d_claim" "$d_voice" "$state"
    [ "$state" = ok ] || failed=$((failed + 1))
done <<EOF
$(node -e '
const cues = require(process.argv[1]);
for (const cue of cues) console.log([cue.id, cue.file, cue.expectedLufs].join("\t"));
' "$work/cues/cues.json")
EOF

printf '\n'
if [ "$failed" -gt 0 ]; then
    printf 'measure-cue-loudness: %d cue(s) outside %s LU of what the table claims\n' \
        "$failed" "$tolerance_lu" >&2
    exit 1
fi
printf 'measure-cue-loudness: every cue is within %s LU of its table entry\n' "$tolerance_lu"
