import { describe, expect, it } from 'vitest';
import { applyVisibleRange, decideBound, decideSeek, type PlayheadTarget, type VisibleRange } from './readAloudSeek';

function view(oldest: number, newest: number, atLiveEdge = false): VisibleRange {
    return { oldestCreatedAt: oldest, newestCreatedAt: newest, atLiveEdge };
}

describe('scrolling as seeking (DROVE-114)', () => {
    it('seeks forwards when the reading position is above the screen', () => {
        // The user scrolled down, past what was being read.
        expect(decideSeek(10, view(20, 30))).toBe(20);
    });

    it('does not seek forwards while the list is following a live reply', () => {
        // At the live edge nobody scrolled: the list is following the reply and
        // the voice is just slower than the writing. Jumping it forward here
        // would cut the middle out of a reply with nothing said about it, which
        // is precisely what DROVE-108 stopped doing.
        expect(decideSeek(10, view(20, 30, true))).toBeNull();
    });

    it('still seeks backwards at the live edge, since only a scroll gets there', () => {
        expect(decideSeek(40, view(20, 30, true))).toBe(20);
    });

    it('seeks backwards when the reading position is below the screen', () => {
        // The user scrolled up, to something already said.
        expect(decideSeek(40, view(20, 30))).toBe(20);
    });

    it('leaves reading alone while it is on screen', () => {
        expect(decideSeek(25, view(20, 30))).toBeNull();
        expect(decideSeek(20, view(20, 30))).toBeNull();
        expect(decideSeek(30, view(20, 30))).toBeNull();
    });

    it('starts nothing when nothing has ever been read', () => {
        expect(decideSeek(null, view(20, 30))).toBeNull();
    });

    it('does nothing when the list can see nothing', () => {
        expect(decideSeek(25, null)).toBeNull();
        expect(decideBound(null)).toBeNull();
    });

    /**
     * The loop this feature could have had: a highlight moves the layout, the
     * layout reports a new viewport, the viewport seeks, the seek moves the
     * highlight. It is broken in three places, and this is the one that can be
     * proved. A seek only ever targets the top of the visible range, which
     * comes from the list; after it, the position is inside the range, so the
     * next decision is null. One step, then a fixpoint, from anywhere.
     */
    it('settles in one step from any starting position', () => {
        const range = view(20, 30);
        for (const start of [-5, 0, 19, 20, 25, 30, 31, 1000]) {
            const first = decideSeek(start, range);
            const after = first ?? start;
            expect(decideSeek(after, range)).toBeNull();
        }
    });

    it('a range with nothing sayable in it still settles', () => {
        // Reading cannot land inside the range (no sentence is in it), so the
        // decision repeats — but it repeats the SAME answer, and the reader
        // ignores a seek that does not move, so nothing oscillates.
        const range = view(20, 30);
        expect(decideSeek(40, range)).toBe(20);
        expect(decideSeek(40, range)).toBe(20);
    });

    it('bounds reading at the bottom of the screen, and not at all at the live edge', () => {
        expect(decideBound(view(20, 30))).toBe(30);
        expect(decideBound(view(20, 30, true))).toBeNull();
    });
});

class FakeQueue implements PlayheadTarget {
    readPosition: number | null;
    readonly calls: string[] = [];

    constructor(position: number | null) {
        this.readPosition = position;
    }

    seekTo(createdAt: number): void {
        this.calls.push(`seek:${createdAt}`);
        this.readPosition = createdAt;
    }

    setReadableThrough(createdAt: number | null): void {
        this.calls.push(`bound:${createdAt === null ? 'none' : createdAt}`);
    }
}

describe('reporting the viewport to the queue (DROVE-114)', () => {
    it('seeks before it widens the bound, so no syllable of the old position escapes', () => {
        const queue = new FakeQueue(5);
        applyVisibleRange(queue, { oldestCreatedAt: 20, newestCreatedAt: 30, atLiveEdge: false });
        expect(queue.calls).toEqual(['seek:20', 'bound:30']);
    });

    it('takes the bound off at the live edge', () => {
        const queue = new FakeQueue(30);
        applyVisibleRange(queue, { oldestCreatedAt: 20, newestCreatedAt: 30, atLiveEdge: true });
        expect(queue.calls).toEqual(['bound:none']);
    });

    it('leaves reading alone when it is already on screen', () => {
        const queue = new FakeQueue(25);
        applyVisibleRange(queue, { oldestCreatedAt: 20, newestCreatedAt: 30, atLiveEdge: false });
        expect(queue.calls).toEqual(['bound:30']);
    });

    it('a list with nothing on it takes the bound off and seeks nowhere', () => {
        const queue = new FakeQueue(25);
        applyVisibleRange(queue, null);
        expect(queue.calls).toEqual(['bound:none']);
    });

    it('repeating the same report does nothing the second time', () => {
        const queue = new FakeQueue(5);
        const range = { oldestCreatedAt: 20, newestCreatedAt: 30, atLiveEdge: false };
        applyVisibleRange(queue, range);
        queue.calls.length = 0;
        applyVisibleRange(queue, range);
        expect(queue.calls).toEqual(['bound:30']);
    });
});
