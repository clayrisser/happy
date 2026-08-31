import { describe, expect, it } from 'vitest';
import {
    CANCEL_SLOP,
    HOLD_MIN_MS,
    idleMicGesture,
    isInsideTalkButton,
    micOutcome,
    pressElapsed,
    reduceMicGesture,
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

/**
 * The effects that decide what happens to the words, without the haptics or
 * the hold timer, which are feedback and plumbing rather than outcomes.
 */
function outcome(effects: MicEffect[]): MicEffect[] {
    return effects.filter((effect) => effect !== 'tick' && effect !== 'watchHold');
}

const press = (at: number): MicGestureEvent => ({ type: 'pressIn', at });
const lift = (at: number): MicGestureEvent => ({ type: 'pressOut', at });
const slideOff: MicGestureEvent = { type: 'slide', inside: false };
const slideBack: MicGestureEvent = { type: 'slide', inside: true };
const holdConfirm: MicGestureEvent = { type: 'holdConfirm' };

/** A gesture object, spelled once so a new field does not touch every case. */
const gestureAt = (over: Partial<MicGesture>): MicGesture => ({ ...idleMicGesture, ...over });

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
                events: [press(0), lift(HOLD_MIN_MS)],
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
        it('opens on the press and sends on a lift after the hold threshold', () => {
            const run = drive([press(1000), lift(1000 + HOLD_MIN_MS)]);
            expect(run.states).toEqual(['held', 'idle']);
            expect(run.effects).toEqual(['open', 'watchHold', 'tick', 'send', 'tick']);
        });

        it('stays held however long the finger stays down', () => {
            const run = drive([press(0), lift(90_000)]);
            expect(run.states).toEqual(['held', 'idle']);
            expect(run.effects).toContain('send');
            expect(run.effects).not.toContain('latch');
        });

        it('ignores a duplicate pressIn while held', () => {
            const run = drive([press(0), press(50)]);
            expect(run.gesture).toEqual(gestureAt({ state: 'held', pressedAt: 0 }));
            expect(run.effects).toEqual(['open', 'watchHold', 'tick']);
        });
    });

    describe('tap to latch', () => {
        it('a press released before the hold threshold latches instead of sending', () => {
            const run = drive([press(1000), lift(1000 + HOLD_MIN_MS - 1)]);
            expect(run.states).toEqual(['held', 'latched']);
            expect(run.effects).toEqual(['open', 'watchHold', 'tick', 'latch', 'tick']);
            expect(run.gesture.pressedAt).toBeNull();
        });

        it('one millisecond short of the threshold is a tap, and the threshold itself is a hold', () => {
            const tap = drive([press(0), lift(HOLD_MIN_MS - 1)]);
            const hold = drive([press(0), lift(HOLD_MIN_MS)]);
            expect(tap.gesture.state).toBe('latched');
            expect(hold.gesture.state).toBe('idle');
        });

        /**
         * The regression DROVE-140 was filed for. The old window was 300 ms
         * measured on `Date.now()` inside the two handlers, and press-in is
         * the busiest moment the composer has: it opens the recogniser, fires
         * a haptic and mounts the banner. That work landed inside the measured
         * interval, so an ordinary tap measured well past the window, read as
         * a hold, and closed the mic on the lift.
         */
        it('a short tap whose handler was delayed by a slow press-in still latches', () => {
            // The finger was down for 140 ms. The lift handler ran 260 ms
            // after that, because the mic was still opening.
            const run = drive([
                { type: 'pressIn', at: 1000, touchAt: 5000 },
                { type: 'pressOut', at: 1400, touchAt: 5140 },
            ]);
            expect(run.gesture.state).toBe('latched');
            expect(outcome(run.effects)).toEqual(['open', 'latch']);
        });

        it('a genuine hold still sends when the touch clock is available', () => {
            const run = drive([
                { type: 'pressIn', at: 1000, touchAt: 5000 },
                { type: 'pressOut', at: 3200, touchAt: 7100 },
            ]);
            expect(outcome(run.effects)).toEqual(['open', 'send']);
        });

        it('a second tap stops a latched mic and never sends (DROVE-105)', () => {
            const run = drive([press(0), lift(100), press(5000), lift(5080)]);
            expect(run.states).toEqual(['held', 'latched', 'latched', 'idle']);
            expect(run.effects).toEqual(['open', 'watchHold', 'tick', 'latch', 'tick', 'stop', 'tick']);
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
            const latched = gestureAt({ state: 'latched' });
            const step = reduceMicGesture(latched, press(10));
            expect(step.next.state).toBe('latched');
            expect(step.effects).toEqual([]);
        });
    });

    /**
     * DROVE-210. DROVE-140's fix was correct and shipped, and it still did not
     * reach the phone, because the composer called the handlers through an
     * arrow that took no arguments and so never forwarded `touchAt`. Nothing
     * in the reducer can notice that: it simply sees a press with no touch
     * clock and falls back to the wall clock, which is the JS-thread interval
     * DROVE-140 exists to stop measuring.
     *
     * These two cases are the same finger. They differ only in whether the
     * timestamp survived the trip, and they end in opposite places, which is
     * the whole argument for talkButtonWiring.ts passing the handlers by
     * reference rather than wrapping them.
     */
    describe('the touch clock has to reach the reducer', () => {
        // 150 ms of finger. 620 ms of JS thread, because press-in interrupts
        // read-aloud, starts the recogniser and mounts the banner.
        const fingerDownAt = 5000;
        const fingerUpAt = 5150;
        const handlerRanAt = 1000;
        const liftHandlerRanAt = 1620;

        it('latches when the timestamps are forwarded', () => {
            const run = drive([
                { type: 'pressIn', at: handlerRanAt, touchAt: fingerDownAt },
                { type: 'pressOut', at: liftHandlerRanAt, touchAt: fingerUpAt },
            ]);
            expect(run.gesture.state).toBe('latched');
            expect(outcome(run.effects)).toEqual(['open', 'latch']);
        });

        it('sends and closes the mic when they are dropped on the way', () => {
            // The same tap, with the arrow that forgot the argument. This is
            // what Clay was holding: one press, mic shut on the lift, words
            // gone to the agent.
            const run = drive([
                { type: 'pressIn', at: handlerRanAt },
                { type: 'pressOut', at: liftHandlerRanAt },
            ]);
            expect(run.gesture.state).toBe('idle');
            expect(outcome(run.effects)).toEqual(['open', 'send']);
        });

        it('the hold timer is the second route, not the only one', () => {
            // A jammed thread can swallow the timer as easily as the lift
            // handler, so the touch clock still has to be right. With it, a
            // tap that never got a holdConfirm latches.
            const run = drive([
                { type: 'pressIn', at: handlerRanAt, touchAt: fingerDownAt },
                { type: 'pressOut', at: liftHandlerRanAt, touchAt: fingerUpAt },
            ]);
            expect(run.effects).not.toContain('send');
        });
    });

    /**
     * The composer's PRIMARY button (DROVE-210). It is a plain `onPress`: one
     * callback, on the lift, with no press-in, no duration and no
     * coordinates. So a tap on it is fed here as a press and a lift at the
     * same instant, and the reducer needs no new event type to handle it.
     *
     * That is also why the two controls are not identical and cannot be: zero
     * elapsed can only ever latch, so push-to-talk and slide-to-cancel stay on
     * the capsule's TalkButton, which owns the whole touch stream.
     */
    describe('one tap on a control with no touch stream', () => {
        it('latches the mic open', () => {
            const run = drive([press(9000), lift(9000)]);
            expect(run.gesture.state).toBe('latched');
            expect(outcome(run.effects)).toEqual(['open', 'latch']);
        });

        it('a second one stops it with the words unsent', () => {
            const run = drive([press(9000), lift(9000), press(9600), lift(9600)]);
            expect(run.gesture.state).toBe('idle');
            expect(outcome(run.effects)).toEqual(['open', 'latch', 'stop']);
            expect(run.effects).not.toContain('send');
        });

        it('can never send, however long the finger was actually down', () => {
            // The button reports nothing about duration, so there is no
            // elapsed time for a hold to be read out of.
            const run = drive([press(9000), lift(9000)]);
            expect(run.effects).not.toContain('send');
            expect(run.gesture.confirmed).toBe(false);
        });

        it('stops a latch the capsule opened, because it is one capture', () => {
            const run = drive([press(0), lift(120), press(9000), lift(9000)]);
            expect(run.states).toEqual(['held', 'latched', 'latched', 'idle']);
            expect(outcome(run.effects)).toEqual(['open', 'latch', 'stop']);
        });
    });

    describe('slide off to cancel', () => {
        it('arms the cancel while the finger is off, and ticks on each crossing', () => {
            const off = drive([press(0), slideOff]);
            expect(off.gesture.outside).toBe(true);
            expect(off.effects).toEqual(['open', 'watchHold', 'tick', 'tick']);
            const back = drive([press(0), slideOff, slideBack]);
            expect(back.gesture.outside).toBe(false);
            expect(back.effects).toEqual(['open', 'watchHold', 'tick', 'tick', 'tick']);
        });

        it('a repeated slide in the same direction changes nothing', () => {
            const run = drive([press(0), slideOff, slideOff, slideOff]);
            expect(run.effects).toEqual(['open', 'watchHold', 'tick', 'tick']);
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
            expect(run.gesture).toEqual(gestureAt({ state: 'held', pressedAt: 1000 }));
        });
    });

    describe('the capture ending on its own', () => {
        it('drops a latched mic to idle with a tick, so the user knows it stopped', () => {
            const latched = gestureAt({ state: 'latched' });
            const step = reduceMicGesture(latched, { type: 'ended' });
            expect(step.next).toEqual(idleMicGesture);
            expect(step.effects).toEqual(['tick']);
        });

        it('drops a held mic to idle and swallows the lift that follows', () => {
            const run = drive([press(0), { type: 'ended' }, lift(50)]);
            expect(run.states).toEqual(['held', 'idle', 'idle']);
            // The lift after an end must not latch: no 'latch', no send, no cancel.
            expect(run.effects).toEqual(['open', 'watchHold', 'tick']);
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

    /**
     * The second half of DROVE-140's fix: the split is decided under the
     * finger, not computed after it. A timer started at press-in fires while
     * the button is still down, ticks the haptic there, and from then on the
     * lift sends however the clocks read.
     */
    describe('the hold is confirmed while the finger is still down', () => {
        it('a press asks for the hold timer, and a press on a latch does not', () => {
            expect(drive([press(0)]).effects).toContain('watchHold');
            const onLatch = reduceMicGesture(gestureAt({ state: 'latched' }), press(10));
            expect(onLatch.effects).not.toContain('watchHold');
        });

        it('confirming ticks once and arms the send', () => {
            const run = drive([press(0), holdConfirm]);
            expect(run.gesture.confirmed).toBe(true);
            expect(run.effects).toEqual(['open', 'watchHold', 'tick', 'tick']);
        });

        it('a second confirm changes nothing', () => {
            const run = drive([press(0), holdConfirm, holdConfirm]);
            expect(run.effects).toEqual(['open', 'watchHold', 'tick', 'tick']);
        });

        it('a confirmed press sends even when the clocks say it was brief', () => {
            const run = drive([press(1000), holdConfirm, lift(1001)]);
            expect(outcome(run.effects)).toEqual(['open', 'send']);
        });

        it('a confirmed press slid off the button still cancels', () => {
            const run = drive([press(0), holdConfirm, slideOff, lift(2000)]);
            expect(outcome(run.effects)).toEqual(['open', 'cancel']);
        });

        it('a timer that outlives its press is inert', () => {
            expect(reduceMicGesture(idleMicGesture, holdConfirm).effects).toEqual([]);
            const latched = gestureAt({ state: 'latched' });
            expect(reduceMicGesture(latched, holdConfirm).next).toBe(latched);
        });

        it('the latch clears the confirmation, so the next press starts fresh', () => {
            const run = drive([press(0), lift(100), press(5000), lift(5010)]);
            expect(run.gesture.confirmed).toBe(false);
        });
    });

    /**
     * `Date.now()` in a handler is the time the JS thread reached it. The OS's
     * touch clock is the time the finger moved, which is the only one that
     * measures a gesture.
     */
    describe('pressElapsed', () => {
        it('prefers the touch clock when both events carry one', () => {
            const gesture = gestureAt({ state: 'held', pressedAt: 1000, pressedTouchAt: 5000 });
            expect(pressElapsed(gesture, { at: 1400, touchAt: 5140 })).toBe(140);
        });

        it('falls back to the wall clock when the platform gives no touch clock', () => {
            const gesture = gestureAt({ state: 'held', pressedAt: 1000, pressedTouchAt: null });
            expect(pressElapsed(gesture, { at: 1400 })).toBe(400);
        });

        it('never mixes the two clocks, whichever side is missing one', () => {
            const withTouch = gestureAt({ state: 'held', pressedAt: 1000, pressedTouchAt: 5000 });
            expect(pressElapsed(withTouch, { at: 1400 })).toBe(400);
            const withoutTouch = gestureAt({ state: 'held', pressedAt: 1000, pressedTouchAt: null });
            expect(pressElapsed(withoutTouch, { at: 1400, touchAt: 5140 })).toBe(400);
        });

        it('is infinite with no finger down, so a stray lift is never a tap', () => {
            expect(pressElapsed(idleMicGesture, { at: 10, touchAt: 10 })).toBe(Infinity);
        });
    });

    it('a lift with no press behind it does nothing', () => {
        const step = reduceMicGesture(idleMicGesture, lift(5));
        expect(step.next).toBe(idleMicGesture);
        expect(step.effects).toEqual([]);
    });
});

/**
 * The banner lost both its text labels (DROVE-142), and one of them was the
 * only thing saying which way a lift would go. This is where that signal
 * lives now, so the glyph is a decision with a table rather than a thing to
 * squint at on a phone.
 */
describe('micOutcome', () => {
    const at = (over: Partial<Parameters<typeof micOutcome>[0]>) => micOutcome({
        latched: false,
        cancelArmed: false,
        sendArmed: false,
        ...over,
    });

    it('shows nothing while a press could still go either way', () => {
        expect(at({})).toBe('undecided');
    });

    it('shows send once the press is a hold', () => {
        expect(at({ sendArmed: true })).toBe('send');
    });

    it('shows stop on a latch, because a tap ends it', () => {
        expect(at({ latched: true })).toBe('stop');
    });

    it('cancel wins over everything, so a finger off the button is never ambiguous', () => {
        expect(at({ cancelArmed: true })).toBe('cancel');
        expect(at({ cancelArmed: true, sendArmed: true })).toBe('cancel');
        expect(at({ cancelArmed: true, latched: true })).toBe('cancel');
        expect(at({ cancelArmed: true, latched: true, sendArmed: true })).toBe('cancel');
    });

    it('never shows send on a latch, whose lift keeps the words instead', () => {
        expect(at({ latched: true, sendArmed: true })).toBe('stop');
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
