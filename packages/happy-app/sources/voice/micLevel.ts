/**
 * The input level behind the waveform (DROVE-74).
 *
 * The native tap hands over a raw RMS per PCM buffer, at most twenty a
 * second. Turning that into a bar height is done here, in plain arithmetic
 * with a test beside it, rather than in Swift where nothing can check it.
 */

/** Quieter than this reads as silence: a flat line. */
export const SILENCE_DB = -50;
/** This loud or louder fills the bar. */
export const FULL_SCALE_DB = 0;

/**
 * Bar height 0..1 for an RMS in 0..1. Logarithmic, because a linear map
 * makes normal speech (around -25 dB) a sliver and only a shout registers.
 */
export function rmsToLevel(rms: number): number {
    if (!Number.isFinite(rms) || rms <= 0) return 0;
    const db = 20 * Math.log10(rms);
    const level = (db - SILENCE_DB) / (FULL_SCALE_DB - SILENCE_DB);
    if (level <= 0) return 0;
    if (level >= 1) return 1;
    return level;
}

/**
 * How many bars the strip shows at once. New samples enter on the right and
 * the oldest leaves on the left, which is what makes it scroll.
 */
export const WAVEFORM_BARS = 36;

/** A strip with nothing heard yet. */
export function flatWaveform(bars = WAVEFORM_BARS): number[] {
    return new Array<number>(bars).fill(0);
}

/** Shift one level in on the right. Never grows past the strip's width. */
export function pushLevel(levels: number[], level: number, bars = WAVEFORM_BARS): number[] {
    const next = levels.length >= bars ? levels.slice(levels.length - bars + 1) : levels.slice();
    next.push(level);
    return next;
}
