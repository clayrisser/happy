import { describe, expect, it } from 'vitest';
import { readDetourFromHere, readFromHere, readSentenceFromHere, type ReadAloudTapTarget } from './readAloudTap';
import type { ReadAloudDetourSentence } from './readAloud';

/**
 * The two guards every seek passes, whatever gesture asked for it.
 *
 * The gesture is a DOUBLE tap on a sentence (DROVE-235, back to what
 * DROVE-146 asked for). It reaches `readSentenceFromHere` below, and the
 * block-level `readFromHere` is now only that call's fallback: no surface
 * binds a gesture to it, which is what keeps exactly one route to the
 * playhead.
 */

interface Fake extends ReadAloudTapTarget {
    /** createdAts the block-level seek was asked for. */
    sought: number[];
    /** What `setPaused` was asked for, in order (DROVE-275). */
    pauses: boolean[];
    /** (messageId, sentence) pairs the sentence-level seek was asked for. */
    soughtSentences: [string, string][];
    /** Borrowed transcripts the reader was handed (DROVE-195). */
    detours: readonly ReadAloudDetourSentence[][];
}

function target(over: Partial<ReadAloudTapTarget> & { hasSentence?: boolean } = {}): Fake {
    const sought: number[] = [];
    const soughtSentences: [string, string][] = [];
    const detours: readonly ReadAloudDetourSentence[][] = [];
    const pauses: boolean[] = [];
    const { hasSentence = true, ...rest } = over;
    return {
        isEnabled: true,
        isPaused: false,
        focusedSessionId: 's1',
        setPaused(paused: boolean) { pauses.push(paused); },
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
        pauses,
        ...rest,
    };
}

describe('the block-level seek, now only the sentence seek\'s fallback (DROVE-146)', () => {
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

describe('double tap a SENTENCE to read from there (DROVE-163, DROVE-235)', () => {
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
describe('double tap a sentence on a subagent screen (DROVE-195)', () => {
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

/**
 * A tap while PAUSED (DROVE-275).
 *
 * The bug this pins was silent in both senses. `steers` asked whether
 * read-aloud was on and never whether it was paused, so two deliberate taps
 * ran the entire seek and then died against the pause inside `pump`: no
 * sound, a `true` return, the tap banked as used, and the position he had
 * paused on cleared on the way past. Nothing anywhere said so.
 *
 * The ORDER is the half worth guarding. `setPaused(false)` pumps, so a resume
 * before the seek speaks from the old cursor — a word or two of the wrong
 * sentence every time a paused tap lands. These assert the seek is asked for
 * first and the resume second.
 */
describe('a tap lifts a pause, after it has moved the read head (DROVE-275)', () => {
    it('resumes when the tapped sentence is in the queue', () => {
        const it1 = target({ isPaused: true });
        expect(readSentenceFromHere(it1, 's1', 'm1', 'A sentence.', 42)).toBe(true);
        expect(it1.soughtSentences).toEqual([['m1', 'A sentence.']]);
        expect(it1.pauses).toEqual([false]);
    });

    it('resumes on the block-level fallback too, so a missed hit test still speaks', () => {
        const it1 = target({ isPaused: true, hasSentence: false });
        expect(readSentenceFromHere(it1, 's1', 'm1', 'A sentence.', 42)).toBe(true);
        expect(it1.sought).toEqual([42]);
        expect(it1.pauses).toEqual([false]);
    });

    it('resumes a detour, which pumps against the same pause (DROVE-195)', () => {
        const it1 = target({ isPaused: true });
        expect(readDetourFromHere(it1, 's1', [{ messageId: 'm1', text: 'A.', createdAt: 1 }])).toBe(true);
        expect(it1.pauses).toEqual([false]);
    });

    it('leaves a reading reader alone, so an ordinary tap costs no transport call', () => {
        const it1 = target();
        expect(readSentenceFromHere(it1, 's1', 'm1', 'A sentence.', 42)).toBe(true);
        expect(it1.pauses).toEqual([]);
    });

    it('does not resume a tap the guards refused, so a background pane cannot start the voice', () => {
        const off = target({ isPaused: true, isEnabled: false });
        expect(readSentenceFromHere(off, 's1', 'm1', 'A sentence.', 42)).toBe(false);
        expect(off.pauses).toEqual([]);

        const elsewhere = target({ isPaused: true, focusedSessionId: 's2' });
        expect(readSentenceFromHere(elsewhere, 's1', 'm1', 'A sentence.', 42)).toBe(false);
        expect(elsewhere.pauses).toEqual([]);
    });

    it('does not resume a detour with nothing under the finger', () => {
        const it1 = target({ isPaused: true });
        expect(readDetourFromHere(it1, 's1', [])).toBe(false);
        expect(it1.pauses).toEqual([]);
    });
});
