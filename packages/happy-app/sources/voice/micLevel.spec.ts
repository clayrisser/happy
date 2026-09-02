import { describe, expect, it } from 'vitest';
import {
    BASELINE_BAR_HEIGHT,
    flatWaveform,
    FULL_SCALE_DB,
    levelToHeight,
    pushLevel,
    rmsToLevel,
    SILENCE_DB,
    TALKING_DISTANCE_DB,
    WAVEFORM_BARS,
} from './micLevel';

/** An RMS that measures the given dB, so the tests can speak in dB. */
const atDb = (db: number) => Math.pow(10, db / 20);

describe('rmsToLevel', () => {
    it('is flat for silence, zero, and garbage', () => {
        expect(rmsToLevel(0)).toBe(0);
        expect(rmsToLevel(-1)).toBe(0);
        expect(rmsToLevel(Number.NaN)).toBe(0);
        // -60 dB: quieter than the floor.
        expect(rmsToLevel(0.001)).toBe(0);
    });

    it('fills the bar at full scale and clamps above it', () => {
        expect(rmsToLevel(1)).toBe(1);
        expect(rmsToLevel(4)).toBe(1);
        // Full scale is -10 dBFS, not 0: the top of the meter is where a loud
        // voice gets, not where the converter clips (DROVE-383, second pass).
        expect(FULL_SCALE_DB).toBe(-10);
        expect(rmsToLevel(atDb(FULL_SCALE_DB))).toBe(1);
        expect(rmsToLevel(atDb(-5))).toBe(1);
        expect(rmsToLevel(atDb(FULL_SCALE_DB - 1))).toBeLessThan(1);
    });

    it('puts ordinary speech in the visible middle, not a sliver', () => {
        // -25 dB, a person talking at a phone.
        const speech = rmsToLevel(Math.pow(10, -25 / 20));
        expect(speech).toBeGreaterThan(0.4);
        expect(speech).toBeLessThan(0.6);
    });

    it('is monotonic: louder is never a shorter bar', () => {
        let last = 0;
        for (let db = -60; db <= 0; db += 5) {
            const level = rmsToLevel(Math.pow(10, db / 20));
            expect(level).toBeGreaterThanOrEqual(last);
            last = level;
        }
    });
});

describe('the strip', () => {
    it('starts flat and full width', () => {
        const flat = flatWaveform();
        expect(flat).toHaveLength(WAVEFORM_BARS);
        expect(flat.every((v) => v === 0)).toBe(true);
    });

    it('scrolls: the newest level enters on the right and the oldest leaves', () => {
        let strip = flatWaveform(4);
        strip = pushLevel(strip, 0.5, 4);
        expect(strip).toEqual([0, 0, 0, 0.5]);
        strip = pushLevel(strip, 0.9, 4);
        expect(strip).toEqual([0, 0, 0.5, 0.9]);
    });

    it('never grows past the width', () => {
        let strip: number[] = [];
        for (let i = 0; i < 100; i++) strip = pushLevel(strip, i / 100, 8);
        expect(strip).toHaveLength(8);
        expect(strip[7]).toBe(0.99);
    });

    it('does not mutate the strip it was given', () => {
        const before = flatWaveform(3);
        pushLevel(before, 1, 3);
        expect(before).toEqual([0, 0, 0]);
    });
});

describe('the level to height mapping (DROVE-383)', () => {
    // The strip is the pill's inner height. Kept as a literal here on purpose:
    // if the pill ever changes, this spec should be the thing that argues.
    const strip = 16;

    it('puts silence on a thin baseline, not on nothing', () => {
        expect(levelToHeight(0, strip)).toBe(BASELINE_BAR_HEIGHT);
        expect(levelToHeight(-1, strip)).toBe(BASELINE_BAR_HEIGHT);
        expect(levelToHeight(Number.NaN, strip)).toBe(BASELINE_BAR_HEIGHT);
    });

    it('fills the strip at full scale and never overflows it', () => {
        expect(levelToHeight(1, strip)).toBe(strip);
        expect(levelToHeight(4, strip)).toBe(strip);
    });

    /**
     * The second pass (IMG_0647 on DROVE-383). Full scale used to be 0 dBFS
     * and -20 landed about half way; a phone at talking distance peaks near
     * -20 and never gets within 10 dB of 0, so the top third of the strip was
     * reserved for a level that never came. Now the loud edge of talking
     * distance is three quarters of the way up (a voice a couple of dB under
     * it, 70%) and -10 dBFS is the top.
     */
    it('lands the loud edge of talking distance three quarters up, and -10 dBFS at the top', () => {
        const loud = levelToHeight(rmsToLevel(atDb(TALKING_DISTANCE_DB.loud)), strip);
        expect(loud).toBeGreaterThanOrEqual(strip * 0.7);
        expect(loud).toBeLessThanOrEqual(strip * 0.8);
        // Two dB under the loud edge is an ordinary voice, and it is 70% up.
        expect(levelToHeight(rmsToLevel(atDb(-22)), strip)).toBeCloseTo(strip * 0.7, 10);
        expect(FULL_SCALE_DB).toBe(-10);
        expect(levelToHeight(rmsToLevel(atDb(FULL_SCALE_DB)), strip)).toBe(strip);
        expect(levelToHeight(rmsToLevel(atDb(-5)), strip)).toBe(strip);
        expect(levelToHeight(rmsToLevel(atDb(0)), strip)).toBe(strip);
    });

    it('spends the strip on talking distance: the band starts half way up and is a fifth of the strip wide', () => {
        const quiet = levelToHeight(rmsToLevel(atDb(TALKING_DISTANCE_DB.quiet)), strip);
        const loud = levelToHeight(rmsToLevel(atDb(TALKING_DISTANCE_DB.loud)), strip);
        expect(TALKING_DISTANCE_DB.quiet).toBeLessThan(TALKING_DISTANCE_DB.loud);
        expect(quiet).toBeGreaterThanOrEqual(strip * 0.5);
        expect(loud - quiet).toBeGreaterThan(strip * 0.2);
        expect(loud).toBeLessThan(strip);
    });

    it('gives the quietest audible sample its own height, above the baseline', () => {
        // This is the defect: a sixth of the range used to collapse onto the
        // floor, so a phone at talking distance drew the same square as silence.
        const audible = levelToHeight(rmsToLevel(atDb(SILENCE_DB + 1)), strip);
        expect(audible).toBeGreaterThan(BASELINE_BAR_HEIGHT);
        expect(levelToHeight(rmsToLevel(atDb(SILENCE_DB - 1)), strip))
            .toBe(BASELINE_BAR_HEIGHT);
    });

    it('separates ordinary speech into distinct heights rather than one dot', () => {
        const heights = [-35, -30, -25, -20, -15]
            .map((db) => levelToHeight(rmsToLevel(atDb(db)), strip));
        for (let i = 1; i < heights.length; i++) {
            expect(heights[i] - heights[i - 1]).toBeGreaterThan(1);
        }
        // The whole speech range sits clear of the baseline and under the top.
        expect(heights[0]).toBeGreaterThan(BASELINE_BAR_HEIGHT + 1);
        expect(heights[heights.length - 1]).toBeLessThanOrEqual(strip);
    });

    it('is monotonic in the level', () => {
        let last = -1;
        for (let level = 0; level <= 1.0001; level += 0.05) {
            const h = levelToHeight(level, strip);
            expect(h).toBeGreaterThanOrEqual(last);
            last = h;
        }
    });

    it('never returns less than the baseline, even for an absurd strip', () => {
        expect(levelToHeight(1, 0)).toBe(BASELINE_BAR_HEIGHT);
        expect(levelToHeight(0.5, 1)).toBe(BASELINE_BAR_HEIGHT);
    });
});

describe('the window (DROVE-383)', () => {
    it('is wide enough to read as a waveform and narrow enough to fit', () => {
        expect(WAVEFORM_BARS).toBeGreaterThanOrEqual(40);
        expect(WAVEFORM_BARS).toBeLessThanOrEqual(60);
    });

    it('fits the narrowest phone: bars at 4pt leave room for the clock and glyphs', () => {
        // 320pt screen, 10pt gutter each side, 10pt pill padding each side,
        // and 84pt of dot, clock, gaps and outcome glyph.
        const available = 320 - 2 * 10 - 2 * 10 - 84;
        expect(WAVEFORM_BARS * 4).toBeLessThanOrEqual(available);
    });
});
