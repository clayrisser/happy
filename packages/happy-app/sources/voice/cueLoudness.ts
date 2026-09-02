/**
 * How loud a cue is, said in the same unit as the voice (DROVE-341).
 *
 * Clay: "the beeping sounds, like the heartbeat and stuff, are a lot quieter
 * than the voice that talks back. They should really be roughly around the
 * same level so I don't have to blast the audio just to hear the beeping."
 *
 * The cue table used to carry a bare 0..1 multiplier called `gain`, and a
 * multiplier has no reference point: there was no way to say what "0.45" was
 * quieter THAN, so nothing could notice when it drifted a dozen dB under the
 * synthesiser. This file gives the table a reference and a unit.
 *
 * THE REFERENCE is -16 LUFS integrated, and it is the VOICE. Measured with
 * ffmpeg's `loudnorm` on `say` output, which is the same AVSpeechSynthesizer
 * family the reader speaks with and whose utterance volume is never set, so it
 * speaks at 1.0. Two system voices on the build machine measured -16.20 and
 * -18.92 LUFS integrated, so -16 is the LOUDER end of the band a real voice
 * lands in. That is deliberate: if the phone's voice turns out quieter, the cue
 * is a shade loud, and a shade loud is the failure Clay can live with. A shade
 * quiet is the bug this file exists to end.
 *
 * THE UNIT is dB relative to that reference. `cueGainDb.toolCall` being -10
 * says a tool tick sits ten dB under a spoken sentence, which is a claim
 * scripts/measure-cue-loudness.sh can falsify. "0.3" said nothing.
 *
 * THE ARITHMETIC. Every cue is a sine, and a full-scale sine measures -3.0
 * LUFS (measured: -2.99 at 1 kHz, and the theory says -3.01). So the peak
 * amplitude that puts a sine at the reference is 10^((-16 + 3)/20) = 0.224,
 * and a cue at -10 dB is that times 10^(-10/20).
 *
 * K-WEIGHTING is inside the tolerance and is therefore not corrected for. The
 * table's frequencies run 175 Hz to 1568 Hz and the meter reads them -1.1 to
 * +1.5 LU against 1 kHz at equal amplitude (measured, ffmpeg ebur128 via
 * loudnorm). Correcting per frequency would tie the amplitude of every cue to
 * the pitch it happens to use, which is a thing DROVE-112 deliberately treats
 * as polish; the +-2 LU tolerance absorbs it instead.
 */

/**
 * MEASURED THROUGH THE STREAMED PATH, NOT `say(1)` (DROVE-385).
 *
 * The paragraph above says the reference was measured on `say` output, "which
 * is the same AVSpeechSynthesizer family the reader speaks with". Same family
 * is not the same voice. `say` runs its own default voice at its own default
 * rate; the reader builds an `AVSpeechUtterance` with `streamTalk.rate` (0.52),
 * `streamTalk.pitch`, and the voice `pickVoice` chose -- the best-quality
 * INSTALLED voice for the language (DroverSpeechModule.swift:412,
 * voicePick.ts). Three different parameters and a different voice.
 *
 * So it is measured through that path now:
 * `scripts/render-stream-voice.swift` renders the fixture sentence with
 * `AVSpeechSynthesizer.write` at exactly those settings, and
 * `scripts/measure-cue-loudness.sh` meters it. On the build machine
 * (2026-09-02, ffmpeg loudnorm, integrated):
 *
 *   Samantha, the compact en-US voice an iPhone speaks with by default   -16.16
 *   Daniel, compact en-GB                                                -18.80
 *   Albert, what `pickVoice` landed on with no enhanced voice, until DROVE-390  -24.03
 *   `say(1)` at its own defaults, which is what DROVE-341 measured        -18.92
 *
 * -16 SURVIVES, and knowing why is the point of redoing it. The band is real
 * and it is wide, so the reference has to be the LOUD end of it: a lower
 * reference makes `cueUnityAmplitude` smaller and every cue quieter, which is
 * the bug. -16.16 is the loudest real reading voice measured through the real
 * path, so it is the one pinned. The number did not move; the claim behind it
 * did, from "a voice" to "the voice he actually hears, at the top of its band".
 *
 * What was ACTUALLY costing the loudness was the table under it -- the
 * heartbeat sat two dB down and the waiting pulses one -- plus there being no
 * way for Clay to push past the table from the phone. Both are fixed below.
 */
export const voiceReferenceLufs = -16;

/**
 * A full-scale sine, in LUFS integrated.
 *
 * Not a constant anyone chose: it is what a sine IS, RMS being 1/sqrt(2) of
 * peak. Written down because the amplitude below is derived from it and a
 * derivation with an unnamed number in it is a magic number with extra steps.
 */
export const sineFullScaleLufs = -3;

/** Peak amplitude of a sine that measures `voiceReferenceLufs`. About 0.224. */
export const cueUnityAmplitude = 10 ** ((voiceReferenceLufs - sineFullScaleLufs) / 20);

/**
 * Every cue's level, in dB relative to the voice. THE table.
 *
 * Zero is "as loud as a spoken sentence". Nothing is above zero: a cue that
 * shouts over the voice is the opposite bug and just as unpleasant.
 *
 * The ordering is the argument, and it is the same argument the old
 * multipliers were making, now in a unit that can be checked:
 *
 *   - The PRESS answers are the loudest, and they are the only rows at 0. The
 *     mic's three (DROVE-225) and the double press's two (DROVE-300) are the
 *     only cues that reply to something Clay just did, and a press with no
 *     audible answer is indistinguishable from a press that did nothing.
 *   - The WAITING pulses are at 0 as well. They are meant to be found in a
 *     pocket, which is what "roughly the same level as the voice" buys them.
 *   - WORKING is at 0 (DROVE-385). It was two dB under, on the argument that
 *     the pulse repeating all day is the one you are meant to stop noticing --
 *     which is true, and is what the CADENCE is for, not the level. Clay,
 *     after DROVE-341 shipped: "please boost the audio more so that the beeps
 *     are basically the same level of loudness as the voice." A 190 ms thump
 *     at 196 Hz measures the same as a sentence long before it SOUNDS like
 *     one, so the ambient family gets the whole of what the ceiling allows and
 *     the trim below is what takes it back down if he wants it down.
 *
 * The three rows above are now one level, and that is deliberate rather than a
 * collapse. Nothing may go over the voice, Clay asked for the heartbeat AT the
 * voice, and the press answers were already there; a one-dB ladder between
 * three sounds at the ceiling was never audible as an ordering anyway. What
 * still carries an ordering is the EVENTS, and they kept their spacing exactly
 * -- every row below moved up by the same two dB the heartbeat did.
 *   - The EVENTS fan out below that by how much they interrupt: an agent
 *     spawning or failing is news, a reply landing is a herald for the
 *     sentence right behind it, and a tool tick is meant to sit UNDER a
 *     sentence rather than beside it.
 *
 * A row moved here moves the measured loudness with it, and
 * cueLoudness.spec.ts fails if the two disagree.
 */
export const cueGainDb = {
    micOpen: 0,
    micClosed: 0,
    micRefused: 0,
    sessionSkipped: 0,
    skipRefused: 0,
    waitingNeedsYou: 0,
    waitingQuestion: 0,
    waitingPermission: 0,
    waitingExpiry: 0,
    working: 0,
    agentStart: -2,
    agentFailed: -2,
    agentDone: -3,
    skipAhead: -4,
    reply: -5,
    toolCall: -8,
} as const;

export type CueGainKey = keyof typeof cueGainDb;

/**
 * The Morse ticks inside the heartbeat, relative to its marker thump.
 *
 * DROVE-182 requires the count to be quieter than the marker that starts it.
 * Seven dB down is 0.45 in the old units, which is what it already was: the
 * number did not change, only the unit it is stated in.
 */
export const morseTickDb = -7;

/** dB to a linear amplitude multiplier. */
export function dbToAmplitude(db: number): number {
    return 10 ** (db / 20);
}

/** A linear amplitude multiplier back to dB. Zero and below answer -Infinity. */
export function amplitudeToDb(amplitude: number): number {
    if (amplitude <= 0) return Number.NEGATIVE_INFINITY;
    return 20 * Math.log10(amplitude);
}

/**
 * The peak amplitude a cue's samples are rendered at.
 *
 * This is the WHOLE level, not a fraction of one: the user's volume setting is
 * applied once more by the player and nowhere else. Applying it in both places
 * is what made every cue play at the square of its intended level and put the
 * heartbeat sixteen dB under the voice at the shipped default (DROVE-341).
 */
export function cueAmplitudeFor(key: CueGainKey, offsetDb = 0): number {
    return clampCueAmplitude(cueUnityAmplitude * dbToAmplitude(cueGainDb[key] + cueOffsetDb(offsetDb)));
}

/**
 * HOW FAR CLAY MAY PUSH THE CUES, in dB either side of the table (DROVE-385).
 *
 * The table above is an argument about what a cue should be worth relative to
 * a spoken sentence, and the argument can be right while the NUMBER is still
 * wrong for one pair of ears, one phone and one pocket. That is not a thing a
 * measurement settles, and it is a bad thing to need a release for: DROVE-341
 * was a release, and it still came back "boost it more".
 *
 * So there is a trim, and it is stated in the table's own unit rather than as
 * another percentage. +12 puts the heartbeat four times the voice's amplitude,
 * which is past pleasant and is meant to be: the whole complaint is that the
 * ceiling was too low. -12 is the other end, for a quiet room.
 *
 * ZERO IS THE DEFAULT and the default has to be right on its own. A trim that
 * has to be moved before the app sounds correct is the table admitting it is
 * wrong, and the table is where that gets fixed.
 */
export const cueOffsetRangeDb = { min: -12, max: 12 } as const;

/** The trim, clamped to its range and NaN-proof. */
export function cueOffsetDb(offsetDb: number | null | undefined): number {
    if (typeof offsetDb !== 'number' || !Number.isFinite(offsetDb)) return 0;
    return Math.max(cueOffsetRangeDb.min, Math.min(cueOffsetRangeDb.max, offsetDb));
}

/**
 * The ceiling on a rendered sample, and why it is not 1.
 *
 * `renderCueWav` clamps to +-1 itself, so nothing here can produce a malformed
 * file; what it cannot do is stop a clamp from turning a sine into a square,
 * which is a different and much harsher sound arriving exactly when Clay has
 * asked for MORE. The unity amplitude is 0.224, so +12 dB reaches 0.89 and the
 * headroom is real; this only guards the corner where a future table row and a
 * full trim meet.
 */
export const cuePeakCeiling = 0.95;

/** An amplitude, held under the ceiling. */
export function clampCueAmplitude(amplitude: number): number {
    return Math.min(cuePeakCeiling, Math.max(0, amplitude));
}

/**
 * A cue's table amplitude with the user's trim on it.
 *
 * The one place the two are combined, so "the level is applied exactly once"
 * (DROVE-341) survives the trim existing. The trim is READ at play time from
 * live settings and lands here; it is not a second field on the table and it
 * is never multiplied into the player's volume as well, which is the shape of
 * the bug DROVE-341 was.
 */
export function cueAmplitudeWithOffset(amplitude: number, offsetDb: number | null | undefined): number {
    return clampCueAmplitude(amplitude * dbToAmplitude(cueOffsetDb(offsetDb)));
}

/** What a cue at this amplitude should measure, in LUFS. The script's target. */
export function expectedLufs(amplitude: number): number {
    return sineFullScaleLufs + amplitudeToDb(amplitude);
}
