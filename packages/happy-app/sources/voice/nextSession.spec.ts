import { describe, expect, it } from 'vitest';
import { nextSessionMove, startNextSessionPress, type NextSessionDeps } from './nextSession';
import type { RemoteCommand } from './headphonePress';

/** The press stream, driven by hand. */
function harness(over: Partial<NextSessionDeps> = {}) {
    const taken: string[] = [];
    let listener: ((command: RemoteCommand) => void) | null = null;
    let removed = false;
    let cycle: string[] = ['a', 'b', 'c'];
    let current: string | null = 'a';
    let reading = true;
    const deps: NextSessionDeps = {
        cycle: () => cycle,
        current: () => current,
        reading: () => reading,
        take: (id) => {
            taken.push(id);
            current = id;
        },
        subscribe: (fn) => {
            listener = fn;
            return { remove: () => { removed = true; } };
        },
        ...over,
    };
    const stop = startNextSessionPress(deps);
    return {
        taken,
        stop,
        press: (command: RemoteCommand) => listener?.(command),
        setCycle: (next: string[]) => { cycle = next; },
        setCurrent: (next: string | null) => { current = next; },
        setReading: (next: boolean) => { reading = next; },
        wasRemoved: () => removed,
    };
}

describe('which session a double press hands the voice to', () => {
    it('takes the next one along and wraps at the end', () => {
        // Clay's own analogy: "it skips to the next track — in this case the
        // next session." A next-track button that stopped at the last track
        // would not be one.
        expect(nextSessionMove(true, ['a', 'b', 'c'], 'a')).toEqual({ kind: 'move', to: 'b' });
        expect(nextSessionMove(true, ['a', 'b', 'c'], 'b')).toEqual({ kind: 'move', to: 'c' });
        expect(nextSessionMove(true, ['a', 'b', 'c'], 'c')).toEqual({ kind: 'move', to: 'a' });
    });

    it('walks only the sessions the cycle names', () => {
        // The enabled set is DROVE-297's and this file consumes it whole. A
        // session that is not in the list is not reachable by any number of
        // presses, which is what "reading enabled" has to mean to be worth
        // having.
        const cycle = ['b', 'd'];
        let at: string | null = 'b';
        const seen: string[] = [];
        for (let i = 0; i < 6; i++) {
            const move = nextSessionMove(true, cycle, at);
            expect(move.kind).toBe('move');
            if (move.kind !== 'move') return;
            at = move.to;
            seen.push(move.to);
        }
        expect(seen).toEqual(['d', 'b', 'd', 'b', 'd', 'b']);
    });

    it('lands on the first enabled session when the voice is nowhere', () => {
        // Nothing focused. Refusing here would leave a button that never works
        // until he opens the app, which is the failure the ticket is about.
        expect(nextSessionMove(true, ['a', 'b'], null)).toEqual({ kind: 'move', to: 'a' });
    });

    it('lands on the first enabled session when the current one is not in the cycle', () => {
        // He is listening to a session whose reading has since been turned
        // off. The press still has somewhere honest to go.
        expect(nextSessionMove(true, ['a', 'b'], 'z')).toEqual({ kind: 'move', to: 'a' });
    });
});

describe('when there is nowhere to go', () => {
    it('does nothing at all with one enabled session, rather than stopping it', () => {
        // The decision the ticket asked for out loud. Pausing the only session
        // because there is nobody to hand to would make the double press a
        // second pause he cannot lift with the same gesture.
        expect(nextSessionMove(true, ['a'], 'a')).toEqual({ kind: 'stay', why: 'alone' });
    });

    it('never stops the voice on any refusal', () => {
        // The one invariant that covers all three. A refusal reaches `take`
        // never, and `take` is the only thing that can move a playhead.
        const rig = harness();
        rig.setCycle(['a']);
        rig.setCurrent('a');
        rig.press('next');
        rig.setReading(false);
        rig.setCycle(['a', 'b']);
        rig.press('next');
        rig.setReading(true);
        rig.setCycle([]);
        rig.press('next');
        expect(rig.taken).toEqual([]);
    });

    it('does not turn reading on from a pocket', () => {
        // DROVE-189's rule kept verbatim through a third remapping: a squeeze
        // that started the voice on a session he had walked away from would be
        // a surprise, and the button is one tap away.
        expect(nextSessionMove(false, ['a', 'b'], 'a')).toEqual({ kind: 'stay', why: 'not-reading' });
        expect(nextSessionMove(false, ['a', 'b'], null)).toEqual({ kind: 'stay', why: 'not-reading' });
        expect(nextSessionMove(false, [], null)).toEqual({ kind: 'stay', why: 'not-reading' });
    });

    it('says which of the three refusals it was', () => {
        // So a cue, when it is added, does not have to re-derive it.
        expect(nextSessionMove(true, [], 'a')).toEqual({ kind: 'stay', why: 'empty' });
        expect(nextSessionMove(true, ['a'], 'a')).toEqual({ kind: 'stay', why: 'alone' });
        expect(nextSessionMove(false, ['a', 'b'], 'a')).toEqual({ kind: 'stay', why: 'not-reading' });
    });
});

describe('the press, wired to the reader', () => {
    it('moves the voice on a double press and on nothing else', () => {
        const rig = harness();
        rig.press('toggle');
        rig.press('play');
        rig.press('pause');
        rig.press('previous');
        expect(rig.taken).toEqual([]);
        rig.press('next');
        expect(rig.taken).toEqual(['b']);
    });

    it('leaves the triple press to the microphone', () => {
        // The mic moved onto `previous` in this same ticket. If this
        // subscription answered it too, one press would do two things.
        const rig = harness();
        rig.press('previous');
        rig.press('previous');
        expect(rig.taken).toEqual([]);
    });

    it('reads the cycle at PRESS time, not at subscribe time', () => {
        // This is the background half of the requirement. The subscription is
        // made once, at import, and the sessions he has open change all day
        // while the app is in his pocket. A cycle captured at subscribe time
        // would hand the voice to a session that is no longer there.
        const rig = harness();
        rig.setCycle(['x', 'y']);
        rig.setCurrent('x');
        rig.press('next');
        expect(rig.taken).toEqual(['y']);
    });

    it('walks the ring one press at a time', () => {
        const rig = harness();
        rig.press('next');
        rig.press('next');
        rig.press('next');
        expect(rig.taken).toEqual(['b', 'c', 'a']);
    });

    it('survives a reader that throws', () => {
        // A dead skip button is better than a dead reader, which is the rule
        // backgroundAudio.ts already applies to the lock screen's play/pause.
        const rig = harness({ take: () => { throw new Error('reader is gone'); } });
        expect(() => rig.press('next')).not.toThrow();
    });

    it('unsubscribes when it is stopped', () => {
        const rig = harness();
        rig.stop();
        expect(rig.wasRemoved()).toBe(true);
    });
});
