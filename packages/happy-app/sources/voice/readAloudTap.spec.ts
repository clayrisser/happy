import { describe, expect, it } from 'vitest';
import { readFromHere, type ReadAloudTapTarget } from './readAloudTap';

function target(over: Partial<ReadAloudTapTarget> = {}): ReadAloudTapTarget & { sought: number[] } {
    const sought: number[] = [];
    return {
        isEnabled: true,
        focusedSessionId: 's1',
        seekTo(createdAt: number) { sought.push(createdAt); },
        sought,
        ...over,
    };
}

describe('double tap a section to read from there (DROVE-146)', () => {
    it('moves reading to the tapped section', () => {
        const it1 = target();
        expect(readFromHere(it1, 's1', 42)).toBe(true);
        expect(it1.sought).toEqual([42]);
    });

    it('does nothing while read-aloud is off, so the gesture is free', () => {
        const it1 = target({ isEnabled: false });
        expect(readFromHere(it1, 's1', 42)).toBe(false);
        expect(it1.sought).toEqual([]);
    });

    /**
     * A subagent transcript or a side panel is tapped on its own and must not
     * steer the session's voice. The same rule the old viewport feed had, kept
     * because it was the only part of it that was right.
     */
    it('does nothing from a surface the voice is not reading', () => {
        const it1 = target({ focusedSessionId: 's2' });
        expect(readFromHere(it1, 's1', 42)).toBe(false);
        expect(it1.sought).toEqual([]);
    });

    it('does nothing when no session is focused at all', () => {
        const it1 = target({ focusedSessionId: null });
        expect(readFromHere(it1, 's1', 42)).toBe(false);
        expect(it1.sought).toEqual([]);
    });
});
