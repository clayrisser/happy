import { describe, expect, it } from 'vitest';
import { nextSessionMove, startNextSessionPress, type NextSessionDeps } from './nextSession';
import type { RemoteCommand } from './headphonePress';
import { cueSpec } from './audioCues';

/** The press stream, driven by hand. */
function harness(over: Partial<NextSessionDeps> = {}) {
    const taken: string[] = [];
    const cued: string[] = [];
    const named: string[] = [];
    /** Every side effect of one press, in the order it happened. */
    const order: string[] = [];
    let listener: ((command: RemoteCommand) => void) | null = null;
    let removed = false;
    let cycle: string[] = ['a', 'b', 'c'];
    let current: string | null = 'a';
    const deps: NextSessionDeps = {
        cycle: () => cycle,
        current: () => current,
        take: (id) => {
            taken.push(id);
            order.push(`take:${id}`);
            current = id;
        },
        ack: (id) => {
            cued.push(id);
            order.push(`cue:${id}`);
        },
        announce: (id) => {
            named.push(id);
            order.push(`named:${id}`);
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
        cued,
        named,
        order,
        stop,
        press: (command: RemoteCommand) => listener?.(command),
        setCycle: (next: string[]) => { cycle = next; },
        setCurrent: (next: string | null) => { current = next; },
        wasRemoved: () => removed,
    };
}

describe('which session a double press hands the voice to', () => {
    it('takes the next one along and wraps at the end', () => {
        // Clay's own analogy: "it skips to the next track — in this case the
        // next session." A next-track button that stopped at the last track
        // would not be one.
        expect(nextSessionMove(['a', 'b', 'c'], 'a')).toEqual({ kind: 'move', to: 'b' });
        expect(nextSessionMove(['a', 'b', 'c'], 'b')).toEqual({ kind: 'move', to: 'c' });
        expect(nextSessionMove(['a', 'b', 'c'], 'c')).toEqual({ kind: 'move', to: 'a' });
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
            const move = nextSessionMove(cycle, at);
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
        expect(nextSessionMove(['a', 'b'], null)).toEqual({ kind: 'move', to: 'a' });
    });

    it('lands on the first enabled session when the current one is not in the cycle', () => {
        // He is listening to a session whose reading has since been turned
        // off. The press still has somewhere honest to go.
        expect(nextSessionMove(['a', 'b'], 'z')).toEqual({ kind: 'move', to: 'a' });
    });
});

describe('when there is nowhere to go', () => {
    it('does nothing at all with one enabled session, rather than stopping it', () => {
        // The decision the ticket asked for out loud. Pausing the only session
        // because there is nobody to hand to would make the double press a
        // second pause he cannot lift with the same gesture.
        expect(nextSessionMove(['a'], 'a')).toEqual({ kind: 'stay', why: 'alone' });
    });

    it('never stops the voice on any refusal', () => {
        // The one invariant that covers both. A refusal reaches `take` never,
        // and `take` is the only thing that can move a playhead.
        const rig = harness();
        rig.setCycle(['a']);
        rig.setCurrent('a');
        rig.press('next');
        rig.setCycle([]);
        rig.press('next');
        expect(rig.taken).toEqual([]);
    });

    it('does not turn reading on from a pocket', () => {
        // DROVE-189's rule, kept through a third remapping and now structural
        // rather than a flag: with reading switched off everywhere the cycle
        // is empty, so no number of squeezes can start the voice on a session
        // he walked away from. DROVE-297 owns which sessions are armed; this
        // only has to refuse when none is.
        expect(nextSessionMove([], 'a')).toEqual({ kind: 'stay', why: 'empty' });
        expect(nextSessionMove([], null)).toEqual({ kind: 'stay', why: 'empty' });
    });

    it('says which of the two refusals it was', () => {
        // So a cue, when it is added, does not have to re-derive it.
        expect(nextSessionMove([], 'a')).toEqual({ kind: 'stay', why: 'empty' });
        expect(nextSessionMove(['a'], 'a')).toEqual({ kind: 'stay', why: 'alone' });
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

describe('the press is never silent', () => {
    it('cues the skip, names the session, then takes it, in that order', () => {
        // The cue leads so it plays into the gap the take opens rather than
        // over the incoming session's first sentence, and the name leads the
        // take so a real sentence can overwrite it the moment there is one.
        const rig = harness();
        rig.press('next');
        expect(rig.order).toEqual(['cue:sessionSkipped', 'named:b', 'take:b']);
    });

    it('cues a refusal instead of doing nothing quietly', () => {
        // headphonePress.ts's doctrine, applied to the one gesture that was
        // still exempt from it: a press with no sound is indistinguishable
        // from a press that did nothing.
        const rig = harness();
        rig.setCycle(['a']);
        rig.setCurrent('a');
        rig.press('next');
        expect(rig.cued).toEqual(['skipRefused']);
        expect(rig.taken).toEqual([]);
        expect(rig.named).toEqual([]);
    });

    it('cues the same refusal with reading off everywhere', () => {
        // Two refusals, one sound. From his ear `empty` and `alone` are the
        // same fact — the press landed and there was nowhere to go — and the
        // `why` exists so a caller can say them differently later, not
        // because they must be said differently now.
        const rig = harness();
        rig.setCycle([]);
        rig.press('next');
        expect(rig.cued).toEqual(['skipRefused']);
    });

    it('says nothing at all on a press that is not its own', () => {
        // A cue on the single or triple press would be this subscription
        // answering a gesture the table gave to somebody else.
        const rig = harness();
        rig.press('toggle');
        rig.press('play');
        rig.press('pause');
        rig.press('previous');
        expect(rig.cued).toEqual([]);
        expect(rig.named).toEqual([]);
    });

    it('never names a session it did not move to', () => {
        // The card is a claim about where the voice IS. A name written on a
        // refusal would put the wrong conversation on the lock screen and
        // leave it there.
        const rig = harness();
        rig.press('next');
        rig.setCycle([]);
        rig.press('next');
        expect(rig.named).toEqual(['b']);
    });

    it('survives a cue player that throws', () => {
        // Same rule as the reader: a dead beeper is not worth a dead skip.
        const rig = harness({ ack: () => { throw new Error('no audio'); } });
        expect(() => rig.press('next')).not.toThrow();
    });

    it('tells the skip and its refusal apart by shape', () => {
        // Rhythm, not pitch: three notes climbing against the same low note
        // three times. A pocket flattens pitch and the contour survives.
        const skipped = cueSpec('sessionSkipped');
        const refused = cueSpec('skipRefused');
        expect(skipped.beats.map((beat) => beat.hz)).toEqual(
            [...skipped.beats].map((beat) => beat.hz).sort((a, b) => a - b),
        );
        expect(new Set(refused.beats.map((beat) => beat.hz)).size).toBe(1);
    });
});
