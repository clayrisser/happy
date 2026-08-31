/**
 * WHAT THE STRIP MAY HONESTLY SAY ABOUT THE NEXT COMPACTION (DROVE-231).
 *
 * Clay: "Also should show something for context or something so we know when
 * compaction happens next." The constraint is that a countdown that lies is
 * worse than nothing, so this spec is as much about what is REFUSED as about
 * what is returned.
 */
import { describe, expect, it } from 'vitest';
import {
    CONTEXT_COMPACTION_PERCENT,
    contextCompactionPercent,
    contextReading,
} from './contextCompaction';

describe('the reading, and what it is measured from', () => {
    it('is the transcript context against the model window', () => {
        const reading = contextReading(84_000, 200_000)!;
        expect(reading.usedTokens).toBe(84_000);
        expect(reading.windowTokens).toBe(200_000);
        expect(reading.usedPercent).toBe(42);
    });

    it('names both numbers and the compaction point in the tap text', () => {
        expect(contextReading(84_000, 200_000)!.detail)
            .toBe('84.0k of 200.0k context, compacts near 184.0k');
    });

    it('fills toward COMPACTION, not toward the window', () => {
        // Full means compact now. A ring measured against the raw window would
        // never fill, because the agent compacts before the window does.
        const reading = contextReading(184_000, 200_000)!;
        expect(reading.fraction).toBe(1);
        expect(reading.atCompaction).toBe(true);
        expect(contextCompactionPercent(reading)).toBe(100);
    });

    it('reads under half way at the point the old gauge first appeared', () => {
        expect(contextCompactionPercent(contextReading(84_000, 200_000)!)).toBe(46);
    });

    it('clamps rather than overflowing past the compaction point', () => {
        const reading = contextReading(199_000, 200_000)!;
        expect(reading.fraction).toBe(1);
        expect(contextCompactionPercent(reading)).toBe(100);
    });
});

describe('what it refuses', () => {
    it('says nothing at all without a window to divide by', () => {
        // A percentage against a guessed window corrects itself upward later,
        // and a context gauge that goes DOWN reads as the context refilling.
        expect(contextReading(84_000, undefined)).toBeNull();
        expect(contextReading(84_000, 0)).toBeNull();
        expect(contextReading(84_000, Number.NaN)).toBeNull();
    });

    it('says nothing without a context figure either', () => {
        expect(contextReading(undefined, 200_000)).toBeNull();
        expect(contextReading(null, 200_000)).toBeNull();
    });

    it('offers no count of turns and no clock, because neither is knowable', () => {
        const reading = contextReading(84_000, 200_000)!;
        expect(Object.keys(reading).sort()).toEqual([
            'atCompaction', 'compactionAtTokens', 'detail', 'fraction',
            'usedPercent', 'usedTokens', 'windowTokens',
        ]);
    });
});

describe('the compaction point', () => {
    it('is 92% of the window, named and written down', () => {
        expect(CONTEXT_COMPACTION_PERCENT).toBe(92);
        expect(contextReading(0, 200_000)!.compactionAtTokens).toBe(184_000);
        expect(contextReading(0, 1_000_000)!.compactionAtTokens).toBe(920_000);
    });

    it('moves only the ring if the real point is a few percent out', () => {
        // The property that makes a constant acceptable here: being wrong by
        // three points changes a fill by three points and changes nothing
        // else. Nothing counts down off it.
        const at90 = 84_000 / (200_000 * 0.90);
        const at92 = contextReading(84_000, 200_000)!.fraction;
        expect(Math.abs(at90 - at92)).toBeLessThan(0.02);
    });
});
