import { describe, expect, it } from 'vitest';
import {
    idleMicGesture,
    reduceMicGesture,
    TAP_MAX_MS,
    type MicGesture,
    type MicGestureEvent,
} from './micButton';

/** Run a sequence of events and return every state and effect it produced. */
function drive(events: MicGestureEvent[], from: MicGesture = idleMicGesture) {
    const states: string[] = [];
    const effects: string[] = [];
    let gesture = from;
    for (const event of events) {
        const step = reduceMicGesture(gesture, event);
        gesture = step.next;
        states.push(gesture.state);
        effects.push(...step.effects);
    }
    return { gesture, states, effects };
}

describe('reduceMicGesture', () => {
    describe('push-to-talk', () => {
        it('opens on the press and closes on a lift after the tap window', () => {
            const run = drive([
                { type: 'pressIn', at: 1000 },
                { type: 'pressOut', at: 1000 + TAP_MAX_MS + 1 },
            ]);
            expect(run.states).toEqual(['held', 'idle']);
            expect(run.effects).toEqual(['open', 'tick', 'close', 'tick']);
        });

        it('stays held however long the finger stays down', () => {
            const run = drive([
                { type: 'pressIn', at: 0 },
                { type: 'pressOut', at: 90_000 },
            ]);
            expect(run.states).toEqual(['held', 'idle']);
            expect(run.effects).toContain('close');
            expect(run.effects).not.toContain('latch');
        });

        it('ignores a duplicate pressIn while held', () => {
            const run = drive([
                { type: 'pressIn', at: 0 },
                { type: 'pressIn', at: 50 },
            ]);
            expect(run.gesture).toEqual({ state: 'held', pressedAt: 0 });
            expect(run.effects).toEqual(['open', 'tick']);
        });
    });

    describe('tap to latch', () => {
        it('a press released inside the window latches instead of closing', () => {
            const run = drive([
                { type: 'pressIn', at: 1000 },
                { type: 'pressOut', at: 1000 + TAP_MAX_MS },
            ]);
            expect(run.states).toEqual(['held', 'latched']);
            expect(run.effects).toEqual(['open', 'tick', 'latch', 'tick']);
            expect(run.gesture.pressedAt).toBeNull();
        });

        it('one millisecond past the window is a hold, not a tap', () => {
            const tap = drive([{ type: 'pressIn', at: 0 }, { type: 'pressOut', at: TAP_MAX_MS }]);
            const hold = drive([{ type: 'pressIn', at: 0 }, { type: 'pressOut', at: TAP_MAX_MS + 1 }]);
            expect(tap.gesture.state).toBe('latched');
            expect(hold.gesture.state).toBe('idle');
        });

        it('a second tap closes a latched mic and sends', () => {
            const run = drive([
                { type: 'pressIn', at: 0 },
                { type: 'pressOut', at: 100 },
                { type: 'pressIn', at: 5000 },
                { type: 'pressOut', at: 5080 },
            ]);
            expect(run.states).toEqual(['held', 'latched', 'latched', 'idle']);
            expect(run.effects).toEqual(['open', 'tick', 'latch', 'tick', 'close', 'tick']);
        });

        it('a long press on a latched mic also closes it on the lift', () => {
            const run = drive([
                { type: 'pressIn', at: 0 },
                { type: 'pressOut', at: 100 },
                { type: 'pressIn', at: 5000 },
                { type: 'pressOut', at: 7000 },
            ]);
            expect(run.gesture.state).toBe('idle');
            expect(run.effects.filter((e) => e === 'close')).toHaveLength(1);
            // It never reopened: one open for the whole run.
            expect(run.effects.filter((e) => e === 'open')).toHaveLength(1);
        });

        it('the press down on a latched mic changes nothing until the lift', () => {
            const latched: MicGesture = { state: 'latched', pressedAt: null };
            const step = reduceMicGesture(latched, { type: 'pressIn', at: 10 });
            expect(step.next.state).toBe('latched');
            expect(step.effects).toEqual([]);
        });
    });

    describe('the capture ending on its own', () => {
        it('drops a latched mic to idle with a tick, so the user knows it stopped', () => {
            const latched: MicGesture = { state: 'latched', pressedAt: null };
            const step = reduceMicGesture(latched, { type: 'ended' });
            expect(step.next).toEqual(idleMicGesture);
            expect(step.effects).toEqual(['tick']);
        });

        it('drops a held mic to idle and swallows the lift that follows', () => {
            const run = drive([
                { type: 'pressIn', at: 0 },
                { type: 'ended' },
                { type: 'pressOut', at: 50 },
            ]);
            expect(run.states).toEqual(['held', 'idle', 'idle']);
            // The lift after an end must not latch: no 'latch', no second 'close'.
            expect(run.effects).toEqual(['open', 'tick']);
        });

        it('is a no-op while idle', () => {
            const step = reduceMicGesture(idleMicGesture, { type: 'ended' });
            expect(step.next).toBe(idleMicGesture);
            expect(step.effects).toEqual([]);
        });
    });

    it('a lift with no press behind it does nothing', () => {
        const step = reduceMicGesture(idleMicGesture, { type: 'pressOut', at: 5 });
        expect(step.next).toBe(idleMicGesture);
        expect(step.effects).toEqual([]);
    });
});
