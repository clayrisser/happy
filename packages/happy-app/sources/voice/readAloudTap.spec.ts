import { describe, expect, it } from 'vitest';
import { readDetourFromHere, readFromHere, readSentenceFromHere, type ReadAloudTapTarget } from './readAloudTap';
import type { ReadAloudDetourSentence } from './readAloud';

interface Fake extends ReadAloudTapTarget {
    /** createdAts the block-level seek was asked for. */
    sought: number[];
    /** (messageId, sentence) pairs the sentence-level seek was asked for. */
    soughtSentences: [string, string][];
    /** Borrowed transcripts the reader was handed (DROVE-195). */
    detours: readonly ReadAloudDetourSentence[][];
}

function target(over: Partial<ReadAloudTapTarget> & { hasSentence?: boolean } = {}): Fake {
    const sought: number[] = [];
    const soughtSentences: [string, string][] = [];
    const detours: readonly ReadAloudDetourSentence[][] = [];
    const { hasSentence = true, ...rest } = over;
    return {
        isEnabled: true,
        focusedSessionId: 's1',
        seekTo(createdAt: number) { sought.push(createdAt); },
        seekToSentence(messageId: string, sentence: string) {
            soughtSentences.push([messageId, sentence]);
            return hasSentence;
        },
        readDetour(sentences: readonly ReadAloudDetourSentence[]) {
            (detours as ReadAloudDetourSentence[][]).push([...sentences]);
            return true;
        },
        sought,
        soughtSentences,
        detours,
        ...rest,
    };
}

describe('tap a section to read from there (DROVE-146)', () => {
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

describe('tap a SENTENCE to read from there (DROVE-163)', () => {
    it('starts from the tapped sentence, not the block it is in', () => {
        const it1 = target();
        expect(readSentenceFromHere(it1, 's1', 'm1', 'The tests pass.', 42)).toBe(true);
        expect(it1.soughtSentences).toEqual([['m1', 'The tests pass.']]);
        // The block-level seek is the fallback and must not fire as well, or
        // the precise position would be immediately overwritten.
        expect(it1.sought).toEqual([]);
    });

    /**
     * Read-aloud off when the reply landed, or a sentence the renderer shows
     * and the speaker dropped. The worst case of a failed hit test is exactly
     * the behaviour DROVE-146 shipped.
     */
    it('falls back to the block when the queue has no such sentence', () => {
        const it1 = target({ hasSentence: false });
        expect(readSentenceFromHere(it1, 's1', 'm1', 'Not in the queue.', 42)).toBe(true);
        expect(it1.soughtSentences).toEqual([['m1', 'Not in the queue.']]);
        expect(it1.sought).toEqual([42]);
    });

    it('is bound by the same two guards as the block tap', () => {
        const off = target({ isEnabled: false });
        expect(readSentenceFromHere(off, 's1', 'm1', 'Anything.', 42)).toBe(false);
        expect(off.soughtSentences).toEqual([]);
        expect(off.sought).toEqual([]);

        const elsewhere = target({ focusedSessionId: 's2' });
        expect(readSentenceFromHere(elsewhere, 's1', 'm1', 'Anything.', 42)).toBe(false);
        expect(elsewhere.soughtSentences).toEqual([]);
        expect(elsewhere.sought).toEqual([]);
    });
});

/**
 * A subagent screen is a surface of the session, so both guards pass, but its
 * transcript is not in the reader's timeline and never can be (DROVE-195).
 */
describe('tap a sentence on a subagent screen (DROVE-195)', () => {
    const line = (text: string): ReadAloudDetourSentence => ({ messageId: 'a1', text, createdAt: 7 });

    it('hands the borrowed sentences to the reader and never seeks the session', () => {
        const it1 = target();
        expect(readDetourFromHere(it1, 's1', [line('One.'), line('Two.')])).toBe(true);
        expect(it1.detours).toEqual([[line('One.'), line('Two.')]]);
        // The session's own position is untouched: no createdAt was invented.
        expect(it1.sought).toEqual([]);
        expect(it1.soughtSentences).toEqual([]);
    });

    it('leaves the voice alone when the row has no prose in it', () => {
        const it1 = target();
        expect(readDetourFromHere(it1, 's1', [])).toBe(false);
        expect(it1.detours).toEqual([]);
        expect(it1.sought).toEqual([]);
    });

    it('takes the same two guards as the session tap', () => {
        const off = target({ isEnabled: false });
        expect(readDetourFromHere(off, 's1', [line('One.')])).toBe(false);
        const elsewhere = target({ focusedSessionId: 's2' });
        expect(readDetourFromHere(elsewhere, 's1', [line('One.')])).toBe(false);
        expect(off.detours).toEqual([]);
        expect(elsewhere.detours).toEqual([]);
    });
});
