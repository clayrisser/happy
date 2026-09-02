/**
 * The words the phone uses for what the wrist can do (DROVE-391).
 *
 * The one-sentence version, "no wakes left today, or the Drover complication
 * is on no watch face", is what Clay read when none of the watch worked. The
 * two causes have different fixes, so every helper here tells them apart, and
 * says "unknown" for a status that cannot tell rather than picking a side.
 */
import { describe, expect, it } from 'vitest';

import {
    describeDroverComplication,
    describeDroverWakeBudget,
    describeDroverWakeRefusal,
    describeDroverWakesLeft,
    droverWatchWakesPerDay,
} from './droverWatchStatus';

describe('the wake budget line', () => {
    it('counts against the day', () => {
        expect(describeDroverWakeBudget({ wakes: 37 })).toBe('wake budget 37/50 today');
        expect(describeDroverWakeBudget({ wakes: 0 })).toBe(`wake budget 0/${droverWatchWakesPerDay} today`);
    });

    it('says unknown for a build or a moment that cannot count, never 0', () => {
        expect(describeDroverWakeBudget({})).toBe('wake budget unknown');
        expect(describeDroverWakeBudget({})).not.toContain('0/');
    });
});

describe('the complication row', () => {
    it('says yes or no, and what to do about no', () => {
        expect(describeDroverComplication({ complicationEnabled: true })).toBe('Yes');
        const off = describeDroverComplication({ complicationEnabled: false });
        expect(off.startsWith('No')).toBe(true);
        expect(off).toContain('add it to a face');
        // A row subtitle: one short fragment (DROVE-346's 40).
        expect(off.length).toBeLessThanOrEqual(40);
    });

    it('says unknown until the link activates, and unknown on an older build', () => {
        expect(describeDroverComplication({ activated: false })).toContain('until the watch link activates');
        expect(describeDroverComplication({ activated: true })).toBe('Unknown on this build');
        expect(describeDroverComplication({})).toBe('Unknown on this build');
    });
});

describe('the wakes-left row', () => {
    it('reads N of 50', () => {
        expect(describeDroverWakesLeft({ wakes: 37 })).toBe('37 of 50');
        expect(describeDroverWakesLeft({ wakes: 0 })).toBe('0 of 50');
    });

    it('never invents a number', () => {
        expect(describeDroverWakesLeft({ activated: false })).toContain('until the watch link activates');
        expect(describeDroverWakesLeft({})).toBe('Unknown on this build');
    });
});

/**
 * Why the Playground's second tap could not spend a wake. Each line names
 * exactly one cause, and the fallback names both and says it cannot tell.
 */
describe('the refusal line', () => {
    it('is null while a wake can be spent', () => {
        expect(describeDroverWakeRefusal({ wakes: 5 })).toBeNull();
        expect(describeDroverWakeRefusal({ wakes: 5, complicationEnabled: true })).toBeNull();
        expect(describeDroverWakeRefusal({})).toBeNull();
    });

    it('names the complication when it is on no face, and nothing about the budget', () => {
        const line = describeDroverWakeRefusal({ wakes: 0, complicationEnabled: false });
        expect(line).toContain('complication is on no watch face');
        expect(line).toContain('add it to a face');
        expect(line).not.toContain('no wakes left');
    });

    it('names the complication even when the count has not reached 0 yet', () => {
        expect(describeDroverWakeRefusal({ wakes: 3, complicationEnabled: false })).toContain('complication');
    });

    it('names the spent budget when the complication is on a face, and nothing about the face', () => {
        const line = describeDroverWakeRefusal({ wakes: 0, complicationEnabled: true });
        expect(line).toContain('no wakes left today');
        expect(line).toContain('back tomorrow');
        expect(line).not.toContain('complication');
    });

    it('says it cannot tell on a build that reports no complication state', () => {
        const line = describeDroverWakeRefusal({ wakes: 0 });
        expect(line).toContain('no wakes left today');
        expect(line).toContain('complication is on no watch face');
        expect(line).toContain('cannot tell');
    });
});
