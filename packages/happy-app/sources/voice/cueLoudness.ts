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

/** The voice, in LUFS integrated. See the note above for how it was measured. */
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
 *   - The MIC answers (DROVE-225) are the loudest, alone at 0. They are the
 *     only cues that reply to something Clay just did, and a press with no
 *     audible answer is indistinguishable from a press that did nothing.
 *   - The WAITING pulses sit one dB under. They are meant to be found in a
 *     pocket, which is what "roughly the same level as the voice" buys them.
 *   - WORKING is two dB under. Clay named the heartbeat specifically, so it is
 *     close to the voice; it stays the quietest of the ambient family because
 *     it repeats all day and is the one you are meant to stop noticing.
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
    waitingNeedsYou: -1,
    waitingQuestion: -1,
    waitingPermission: -1,
    waitingExpiry: -1,
    working: -2,
    agentStart: -4,
    agentFailed: -4,
    agentDone: -5,
    skipAhead: -6,
    reply: -7,
    toolCall: -10,
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
export function cueAmplitudeFor(key: CueGainKey): number {
    return cueUnityAmplitude * dbToAmplitude(cueGainDb[key]);
}

/** What a cue at this amplitude should measure, in LUFS. The script's target. */
export function expectedLufs(amplitude: number): number {
    return sineFullScaleLufs + amplitudeToDb(amplitude);
}
