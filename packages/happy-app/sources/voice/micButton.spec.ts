import { describe, expect, it } from 'vitest';
import {
    CANCEL_SLOP,
    idleMicGesture,
    isInsideTalkButton,
    reduceMicGesture,
    TAP_MAX_MS,
    type MicEffect,
    type MicGesture,
    type MicGestureEvent,
} from './micButton';

/** Run a sequence of events and return every state and effect it produced. */
function drive(events: MicGestureEvent[], from: MicGesture = idleMicGesture) {
    const states: string[] = [];
    const effects: MicEffect[] = [];
    let gesture = from;
    for (const event of events) {
        const step = reduceMicGesture(gesture, event);
        gesture = step.next;
        states.push(gesture.state);
        effects.push(...step.effects);
    }
    return { gesture, states, effects };
}

/** The effects that decide what happens to the words, without the haptics. */
function outcome(effects: MicEffect[]): MicEffect[] {
    return effects.filter((effect) => effect !== 'tick');
}

const press = (at: number): MicGestureEvent => ({ type: 'pressIn', at });
const lift = (at: number): MicGestureEvent => ({ type: 'pressOut', at });
const slideOff: MicGestureEvent = { type: 'slide', inside: false };
const slideBack: MicGestureEvent = { type: 'slide', inside: true };

describe('reduceMicGesture', () => {
    /**
     * The whole gesture table on one screen (DROVE-105). Every row is a
     * sequence of events from idle and the outcome it must produce. If a row
     * here disagrees with the phone, one of the two is wrong and this says
     * which.
     */
    describe('the gesture table', () => {
        const table: { name: string; events: MicGestureEvent[]; outcome: MicEffect[]; ends: string }[] = [
            {
                name: 'a tap starts a latched capture',
                events: [press(0), lift(100)],
                outcome: ['open', 'latch'],
                ends: 'latched',
            },
            {
                name: 'a second tap stops it, and sends nothing',
                events: [press(0), lift(100), press(5000), lift(5080)],
                outcome: ['open', 'latch', 'stop'],
                ends: 'idle',
            },
            {
                name: 'a hold lifted on the button sends',
                events: [press(0), lift(TAP_MAX_MS + 1)],
                outcome: ['open', 'send'],
                ends: 'idle',
            },
            {
                name: 'a hold slid off the button and lifted there cancels',
                events: [press(0), slideOff, lift(2000)],
                outcome: ['open', 'cancel'],
                ends: 'idle',
            },
            {
                name: 'sliding off and back on again still sends',
                events: [press(0), slideOff, slideBack, lift(2000)],
                outcome: ['open', 'send'],
                ends: 'idle',
            },
            {
                name: 'a press on a latch slid off cancels rather than stopping',
                events: [press(0), lift(100), press(5000), slideOff, lift(5600)],
                outcome: ['open', 'latch', 'cancel'],
                ends: 'idle',
            },
            {
                name: 'the capture ending on its own is neither a send nor a cancel',
                events: [press(0), lift(100), { type: 'ended' }],
                outcome: ['open', 'latch'],
                ends: 'idle',
            },
        ];

        for (const row of table) {
            it(row.name, () => {
                const run = drive(row.events);
                expect(outcome(run.effects)).toEqual(row.outcome);
                expect(run.gesture.state).toBe(row.ends);
            });
        }

        it('sends on exactly one gesture, and only that one', () => {
            for (const row of table) {
                const sends = outcome(drive(row.events).effects).filter((e) => e === 'send');
                expect(sends.length).toBe(row.outcome.includes('send') ? 1 : 0);
            }
        });
    });

    describe('push-to-talk', () => {
        it('opens on the press and sends on a lift after the tap window', () => {
            const run = drive([press(1000), lift(1000 + TAP_MAX_MS + 1)]);
            expect(run.states).toEqual(['held', 'idle']);
            expect(run.effects).toEqual(['open', 'tick', 'send', 'tick']);
        });

        it('stays held however long the finger stays down', () => {
            const run = drive([press(0), lift(90_000)]);
            expect(run.states).toEqual(['held', 'idle']);
            expect(run.effects).toContain('send');
            expect(run.effects).not.toContain('latch');
        });

        it('ignores a duplicate pressIn while held', () => {
            const run = drive([press(0), press(50)]);
            expect(run.gesture).toEqual({ state: 'held', pressedAt: 0, outside: false });
            expect(run.effects).toEqual(['open', 'tick']);
        });
    });

    describe('tap to latch', () => {
        it('a press released inside the window latches instead of sending', () => {
            const run = drive([press(1000), lift(1000 + TAP_MAX_MS)]);
            expect(run.states).toEqual(['held', 'latched']);
            expect(run.effects).toEqual(['open', 'tick', 'latch', 'tick']);
            expect(run.gesture.pressedAt).toBeNull();
        });

        it('one millisecond past the window is a hold, not a tap', () => {
            const tap = drive([press(0), lift(TAP_MAX_MS)]);
            const hold = drive([press(0), lift(TAP_MAX_MS + 1)]);
            expect(tap.gesture.state).toBe('latched');
            expect(hold.gesture.state).toBe('idle');
        });

        it('a second tap stops a latched mic and never sends (DROVE-105)', () => {
            const run = drive([press(0), lift(100), press(5000), lift(5080)]);
            expect(run.states).toEqual(['held', 'latched', 'latched', 'idle']);
            expect(run.effects).toEqual(['open', 'tick', 'latch', 'tick', 'stop', 'tick']);
            expect(run.effects).not.toContain('send');
        });

        it('a long press on a latched mic also stops it on the lift', () => {
            const run = drive([press(0), lift(100), press(5000), lift(7000)]);
            expect(run.gesture.state).toBe('idle');
            expect(run.effects.filter((e) => e === 'stop')).toHaveLength(1);
            // It never reopened: one open for the whole run.
            expect(run.effects.filter((e) => e === 'open')).toHaveLength(1);
        });

        it('the press down on a latched mic changes nothing until the lift', () => {
            const latched: MicGesture = { state: 'latched', pressedAt: null, outside: false };
            const step = reduceMicGesture(latched, press(10));
            expect(step.next.state).toBe('latched');
            expect(step.effects).toEqual([]);
        });
    });

    describe('slide off to cancel', () => {
        it('arms the cancel while the finger is off, and ticks on each crossing', () => {
            const off = drive([press(0), slideOff]);
            expect(off.gesture.outside).toBe(true);
            expect(off.effects).toEqual(['open', 'tick', 'tick']);
            const back = drive([press(0), slideOff, slideBack]);
            expect(back.gesture.outside).toBe(false);
            expect(back.effects).toEqual(['open', 'tick', 'tick', 'tick']);
        });

        it('a repeated slide in the same direction changes nothing', () => {
            const run = drive([press(0), slideOff, slideOff, slideOff]);
            expect(run.effects).toEqual(['open', 'tick', 'tick']);
        });

        it('cancels however briefly the button was held', () => {
            const run = drive([press(0), slideOff, lift(50)]);
            expect(outcome(run.effects)).toEqual(['open', 'cancel']);
            // A tap that slid off is a cancel, never a latch.
            expect(run.effects).not.toContain('latch');
        });

        it('a slide with no finger down is ignored', () => {
            const step = reduceMicGesture(idleMicGesture, slideOff);
            expect(step.next).toBe(idleMicGesture);
            expect(step.effects).toEqual([]);
        });

        it('a fresh press clears an armed cancel', () => {
            const run = drive([press(0), slideOff, lift(50), press(1000)]);
            expect(run.gesture).toEqual({ state: 'held', pressedAt: 1000, outside: false });
        });
    });

    describe('the capture ending on its own', () => {
        it('drops a latched mic to idle with a tick, so the user knows it stopped', () => {
            const latched: MicGesture = { state: 'latched', pressedAt: null, outside: false };
            const step = reduceMicGesture(latched, { type: 'ended' });
            expect(step.next).toEqual(idleMicGesture);
            expect(step.effects).toEqual(['tick']);
        });

        it('drops a held mic to idle and swallows the lift that follows', () => {
            const run = drive([press(0), { type: 'ended' }, lift(50)]);
            expect(run.states).toEqual(['held', 'idle', 'idle']);
            // The lift after an end must not latch: no 'latch', no send, no cancel.
            expect(run.effects).toEqual(['open', 'tick']);
        });

        it('takes an armed cancel down with it', () => {
            const run = drive([press(0), slideOff, { type: 'ended' }, lift(50)]);
            expect(run.gesture).toEqual(idleMicGesture);
            expect(run.effects).not.toContain('cancel');
        });

        it('is a no-op while idle', () => {
            const step = reduceMicGesture(idleMicGesture, { type: 'ended' });
            expect(step.next).toBe(idleMicGesture);
            expect(step.effects).toEqual([]);
        });
    });

    it('a lift with no press behind it does nothing', () => {
        const step = reduceMicGesture(idleMicGesture, lift(5));
        expect(step.next).toBe(idleMicGesture);
        expect(step.effects).toEqual([]);
    });
});

describe('isInsideTalkButton', () => {
    const size = { width: 32, height: 32 };

    it('is inside anywhere on the button', () => {
        expect(isInsideTalkButton({ x: 16, y: 16 }, size)).toBe(true);
        expect(isInsideTalkButton({ x: 0, y: 0 }, size)).toBe(true);
        expect(isInsideTalkButton({ x: 32, y: 32 }, size)).toBe(true);
    });

    it('forgives a wobble up to the slop, and no further', () => {
        expect(isInsideTalkButton({ x: 32 + CANCEL_SLOP, y: 16 }, size)).toBe(true);
        expect(isInsideTalkButton({ x: 32 + CANCEL_SLOP + 1, y: 16 }, size)).toBe(false);
        expect(isInsideTalkButton({ x: -CANCEL_SLOP, y: 16 }, size)).toBe(true);
        expect(isInsideTalkButton({ x: -CANCEL_SLOP - 1, y: 16 }, size)).toBe(false);
        expect(isInsideTalkButton({ x: 16, y: 32 + CANCEL_SLOP + 1 }, size)).toBe(false);
        expect(isInsideTalkButton({ x: 16, y: -CANCEL_SLOP - 1 }, size)).toBe(false);
    });

    it('says inside when the layout has not landed, rather than cancelling on nothing', () => {
        expect(isInsideTalkButton({ x: 900, y: 900 }, { width: 0, height: 0 })).toBe(true);
    });
});
