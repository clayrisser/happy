/**
 * The input level behind the waveform (DROVE-74, DROVE-383).
 *
 * The native tap hands over a raw RMS per PCM buffer, at most twenty a
 * second. Turning that into a bar height is done here, in plain arithmetic
 * with a test beside it, rather than in Swift where nothing can check it.
 *
 * WHY IT LOOKED LIKE DOTS (DROVE-383). The mapping used to stop at a level in
 * 0..1 and the component turned that into `max(2, round(level * 12))`. Two
 * things were wrong with it, and both were about the BOTTOM of the range.
 * Twelve points was the whole canvas, and the 2pt floor swallowed everything
 * under level 0.17, so a phone held at talking distance — which lands around
 * -35..-20 dB, level 0.2..0.55 — drew bars four to seven points tall with a
 * floor at two. The signal was there. It was one or two pixels wide, which is
 * a row of dots that flickers, not a waveform.
 *
 * So the height mapping moved in here beside the curve, where a test can
 * falsify it, and it spends the range differently: silence sits on a thin
 * baseline and EVERY audible level gets its own height between that baseline
 * and the top, instead of a sixth of the range collapsing onto one square.
 */

/**
 * The noise gate. Quieter than this reads as silence and draws the baseline.
 *
 * -45 rather than -50: a phone's own room tone sits a little under it, and it
 * puts ordinary speech in the top two thirds of the range rather than the
 * middle third.
 */
export const SILENCE_DB = -45;
/** This loud or louder fills the bar. */
export const FULL_SCALE_DB = 0;

/**
 * Silence is a thin line, not nothing: the strip stays a strip, and a dead
 * mic is visible as a line that never leaves the floor while you speak.
 */
export const BASELINE_BAR_HEIGHT = 2;

/**
 * Bar level 0..1 for an RMS in 0..1.
 *
 * dB IS the perceptual curve — loudness runs with the logarithm of amplitude,
 * so a straight line in dB is a straight line in what an ear hears, and a
 * straight line in RMS is not. Linear in RMS makes normal speech a sliver and
 * only a shout registers.
 *
 * The anchors, which the spec holds: at or below the gate, 0. At -20 dB,
 * about half. At full scale, 1.
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
 * A level's height in points, inside a strip `height` points tall.
 *
 * Silence is the baseline. Anything above the gate is spread across the whole
 * span from the baseline to the top, so the quietest audible sample is a
 * visibly taller bar than silence rather than the same square. Not rounded:
 * this feeds a `scaleY`, and the GPU is happy with a fraction.
 */
export function levelToHeight(level: number, height: number): number {
    const top = Math.max(BASELINE_BAR_HEIGHT, height);
    if (!Number.isFinite(level) || level <= 0) return BASELINE_BAR_HEIGHT;
    const capped = level >= 1 ? 1 : level;
    return BASELINE_BAR_HEIGHT + capped * (top - BASELINE_BAR_HEIGHT);
}

/**
 * How many bars the strip shows at once. New samples enter on the right and
 * the oldest leaves on the left, which is what makes it scroll.
 *
 * 48 at 20 samples a second is a two-and-a-half-second window: long enough to
 * read as a waveform with a shape rather than a handful of twitching bars, and
 * at 4pt a bar it is 192pt, which still fits the strip on the narrowest phone.
 */
export const WAVEFORM_BARS = 48;

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
