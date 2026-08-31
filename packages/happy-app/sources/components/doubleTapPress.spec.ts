import { describe, expect, it } from 'vitest';
import { type DoubleTapState, doubleTapWindowMs, pressDoubleTap } from './doubleTapPress';

/**
 * Counting two taps where a gesture recogniser cannot go (DROVE-235).
 *
 * Clay: "I thought I had told you DOUBLE press changes where we read not
 * single." He had. The seek was a single tap, which is the gesture a finger
 * makes by accident on body text, so it is two taps now.
 *
 * The count is by hand because a sentence run is a `Text` inline inside a
 * paragraph `Text`, and a GestureDetector renders a View that would break the
 * line. So the window logic lives on its own and is measured here rather than
 * inferred from a mounted component.
 */

/** Press a sequence of times, at the given clock readings. */
function presses(times: number[]): boolean[] {
    let pending: DoubleTapState = null;
    return times.map((now) => {
        const next = pressDoubleTap(pending, now);
        pending = next.pendingSince;
        return next.fired;
    });
}

describe('two presses inside the window', () => {
    it('does nothing on one press', () => {
        expect(presses([1000])).toEqual([false]);
    });

    it('fires on the second press inside the window', () => {
        expect(presses([1000, 1200])).toEqual([false, true]);
    });

    it('does not fire when the second press is late', () => {
        expect(presses([1000, 1000 + doubleTapWindowMs])).toEqual([false, false]);
    });

    /** A slow pair is the start of the next pair, not a dead press. */
    it('makes a late press the first tap of a fresh pair', () => {
        expect(presses([1000, 5000, 5100])).toEqual([false, false, true]);
    });

    it('fires once on three presses and twice on four', () => {
        expect(presses([0, 100, 200])).toEqual([false, true, false]);
        expect(presses([0, 100, 200, 300])).toEqual([false, true, false, true]);
    });

    /**
     * The seek is the thing this guards. One press must never move the read
     * head, however long the finger rests between taps.
     */
    it('never fires on a press with nothing pending', () => {
        expect(pressDoubleTap(null, 0).fired).toBe(false);
        expect(pressDoubleTap(null, 1_000_000).fired).toBe(false);
    });

    it('clears the pending tap when it fires, so the third press starts over', () => {
        const first = pressDoubleTap(null, 1000);
        const second = pressDoubleTap(first.pendingSince, 1100);
        expect(second.fired).toBe(true);
        expect(second.pendingSince).toBeNull();
    });

    /** Matches the native recogniser's maxDelay, so both halves feel the same. */
    it('uses the same window as Gesture.Tap().numberOfTaps(2)', () => {
        expect(doubleTapWindowMs).toBe(350);
    });
});
