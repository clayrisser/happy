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
#   1. Speak a sentence through the STREAMED path -- `AVSpeechSynthesizer.write`
#      at streamTalk's rate and pitch with the voice `pickVoice` chose, which is
#      what DroverSpeechModule actually does (render-stream-voice.swift) -- and
#      measure it with ffmpeg loudnorm. It used to be `say`, and `say` is a
#      different voice at a different rate; see DROVE-385.
#   2. Render every cue from the app's own generator and measure each one.
#   3. Compare each cue against what its table entry claims, and against the
#      voice, and exit nonzero if anything is outside tolerance.
#
# There are no cue assets to normalise: every cue is synthesised. So the
# "original" that is kept is the generator, and the calibration lives in
# cueLoudness.ts rather than in a wav somebody re-recorded.
#
# The voice measured here is the BUILD MACHINE's voice, not the phone's, and
# the two are not the same voice. Through the streamed path this Mac measured
# Samantha (the compact en-US voice an iPhone speaks with) at -16.16, en-GB
# Daniel at -18.80, and the voice `pickVoice` lands on here with no enhanced
# voice installed at -24.03. So -16 is the LOUD end of that band, which is the
# end the reference has to sit at: a lower reference renders every cue quieter,
# and quiet is the bug. The final word is a phone with the media slider at one
# setting, and the trim in settings is what covers the gap between them
# (DROVE-385). This script is what stops the arithmetic drifting in between.
#
# VOICE_ID=<identifier> measures a particular voice instead of the picked one,
# which is how the band above was taken.
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

printf 'measuring the voice reference through the streamed path\n'
if command -v swift >/dev/null 2>&1; then
    VOICE_TEXT=$voice_text swift "$app_dir/scripts/render-stream-voice.swift" \
        "$work/voice.wav" "${VOICE_LANGUAGE:-en-US}" "${VOICE_RATE:-0.52}" "${VOICE_PITCH:-1.0}" 2>&1 |
        sed 's/^/  /'
    voice_lufs=$(integrated "$work/voice.wav")
else
    printf '  swift is not here, so the pinned reference stands in\n'
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
