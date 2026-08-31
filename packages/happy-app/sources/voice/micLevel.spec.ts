import { describe, expect, it } from 'vitest';
import { flatWaveform, pushLevel, rmsToLevel, WAVEFORM_BARS } from './micLevel';

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
