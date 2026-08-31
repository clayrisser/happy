/**
 * The talk button's gesture, as a pure reducer (DROVE-74, DROVE-105, DROVE-140).
 *
 * One button, three outcomes. Press-and-hold is push-to-talk: the mic opens
 * on the press and the lift SENDS. A tap, a press released before the hold is
 * recognised, LATCHES the mic instead: it stays open after the lift, and the
 * next tap STOPS it with the words left in the composer, unsent. Sliding the
 * finger off the button before lifting CANCELS: the recording is thrown away
 * and the composer goes back to what it held. Both ergonomics start listening
 * on the press itself, so a tap costs no extra latency and a hold never misses
 * the first word.
 *
 * Why the latch never sends and a hold still does (DROVE-105): a hold is a
 * momentary, deliberate gesture with the finger on the button the whole
 * time, and it now has an escape hatch, so lifting it can mean "send" the
 * way a walkie-talkie does. A latch is the opposite: it survives the lift,
 * it is the one you leave running while you think, and the words have to
 * wait in the composer to be read before they go anywhere.
 *
 * WHY A TAP USED TO BECOME A HOLD (DROVE-140). The split was one subtraction,
 * `Date.now()` in the pressOut handler minus `Date.now()` in the pressIn
 * handler, over a 300 ms window. Neither number is the time the finger moved.
 * They are the times those two callbacks got the JS thread, and the press-in
 * handler is the busiest moment the composer has: it interrupts read-aloud,
 * reads the draft, starts the recogniser, fires a haptic and sets three
 * pieces of state, which mounts the banner and starts the waveform. A couple
 * of hundred milliseconds of that lands INSIDE the measured interval, so a
 * 150 ms tap measured 350 ms, read as a hold, and ended the capture on the
 * lift. From outside that is exactly "a single press does not stay open".
 *
 * Two changes, both here, so neither can be undone by tuning a constant:
 *
 * 1. MEASURE THE FINGER, NOT THE THREAD. Both press events carry the OS's own
 *    event timestamp (`nativeEvent.timestamp`), and when both sides have one
 *    the elapsed time is their difference. That clock is stamped when the
 *    touch happened, so JS-thread lag cannot inflate it. `Date.now()` is kept
 *    as the fallback for platforms and tests that give no touch clock.
 *
 * 2. DECIDE WHILE THE FINGER IS DOWN. A press becomes a hold when a timer
 *    started at press-in fires with the finger still on the button, which
 *    ticks the haptic then and there: the boundary is FELT, before the lift,
 *    rather than computed after it. The elapsed-time test remains as a
 *    second route to the same conclusion, so a jammed thread that swallows
 *    the timer still classifies a two-second hold correctly.
 *
 * Nothing here schedules, records or vibrates. The reducer names EFFECTS and
 * the hook carries them out, which is what makes tap-versus-hold timing a
 * table of cases in a spec rather than a thing to feel for on a phone.
 */

/** What the button draws. Three states, all visibly different. */
export type MicButtonState = 'idle' | 'held' | 'latched';

export interface MicGesture {
    state: MicButtonState;
    /**
     * When the current finger went down, on the wall clock the handler read.
     * Null when no finger is down.
     */
    pressedAt: number | null;
    /**
     * The same instant on the OS's touch clock, when the platform gave one.
     * A different epoch from `pressedAt` on both platforms, so it is only
     * ever used as one half of a difference with another touch timestamp.
     */
    pressedTouchAt: number | null;
    /**
     * The finger is down but has slid off the button. The lift will cancel,
     * and the banner says so before it happens.
     */
    outside: boolean;
    /**
     * This press has already been recognised as a HOLD, with the finger still
     * down. Set by the hold timer, and felt as a haptic when it happens.
     */
    confirmed: boolean;
}

export type MicGestureEvent =
    | { type: 'pressIn'; at: number; touchAt?: number }
    | { type: 'pressOut'; at: number; touchAt?: number }
    /** The hold timer fired and the finger is still down. */
    | { type: 'holdConfirm' }
    /** The finger moved across the button's edge while still down. */
    | { type: 'slide'; inside: boolean }
    /** The capture ended on its own: idle stop, interrupt, recogniser gave up. */
    | { type: 'ended' };

export type MicEffect =
    /** Open the microphone. */
    | 'open'
    /**
     * Start the hold timer for the press that just began. It fires HOLD_MIN_MS
     * later as `holdConfirm`, and any lift or ending cancels it.
     */
    | 'watchHold'
    /** Keep it open after the lift; the idle clock starts here. */
    | 'latch'
    /** Close it and send what was heard. The lift of a hold. */
    | 'send'
    /** Close it and keep the words in the composer, unsent. The tap off a latch. */
    | 'stop'
    /** Throw the recording away and put the composer back. The slide-off. */
    | 'cancel'
    /** A haptic tick: the user's finger should feel the state change. */
    | 'tick';

/**
 * How long the finger must stay down before the press is a HOLD. Anything
 * released before this latches.
 *
 * 500 ms, iOS's own long-press threshold, rather than the 300 ms this used to
 * be. A deliberate tap is well under 200 ms and a push-to-talk hold runs into
 * seconds, so the boundary has headroom on both sides, and the two failures
 * are not symmetrical: a hold misread as a tap leaves the mic open with the
 * words in the composer, while a tap misread as a hold closes the mic under
 * the user's thumb. Half a second buys room against the first and costs
 * nothing but a second tap in the second.
 */
export const HOLD_MIN_MS = 500;

/**
 * How far past the button's edge the finger may stray before the gesture
 * counts as slid off. Wider than the button's own hitSlop, because a wobble
 * during a two-second hold must not throw the sentence away; narrow enough
 * that a deliberate slide onto the text field is unambiguous.
 */
export const CANCEL_SLOP = 16;

export const idleMicGesture: MicGesture = {
    state: 'idle',
    pressedAt: null,
    pressedTouchAt: null,
    outside: false,
    confirmed: false,
};

export interface MicGestureStep {
    next: MicGesture;
    effects: MicEffect[];
}

/**
 * Is the finger still on the button? Touch coordinates are relative to the
 * view the touch started in, so this is a rectangle test with slop and no
 * measuring of the window. Pure, so the slide-off has a spec.
 */
export function isInsideTalkButton(
    location: { x: number; y: number },
    size: { width: number; height: number },
    slop: number = CANCEL_SLOP,
): boolean {
    // A layout that has not landed yet cannot say anything; assume inside
    // rather than cancelling a capture on a zero-sized rectangle.
    if (size.width <= 0 || size.height <= 0) return true;
    return location.x >= -slop
        && location.x <= size.width + slop
        && location.y >= -slop
        && location.y <= size.height + slop;
}

/**
 * How long the finger has been down, in milliseconds (DROVE-140).
 *
 * The OS's touch clock wins whenever BOTH the press and the lift carry one,
 * because it is stamped when the finger actually moved rather than when the
 * JS thread got round to the callback. The two clocks have different epochs,
 * so they are never mixed: it is both touch timestamps or neither.
 *
 * Infinity when no finger is down, so a lift with no press behind it can
 * never be mistaken for a tap.
 */
export function pressElapsed(
    gesture: MicGesture,
    event: { at: number; touchAt?: number },
): number {
    if (gesture.pressedAt === null) return Infinity;
    if (gesture.pressedTouchAt !== null && event.touchAt !== undefined) {
        return event.touchAt - gesture.pressedTouchAt;
    }
    return event.at - gesture.pressedAt;
}

/**
 * The three outcomes the live banner has to show WITHOUT WORDS (DROVE-142).
 *
 * The banner used to carry a `Release to send` label, and Clay struck it out:
 * a red bar with a running clock and a moving waveform is not ambiguous, and
 * an instruction that shows on every use is clutter after the first. But that
 * label was doing a second job, telling him which way a lift would go BEFORE
 * he lifted, and dropping that would make the failure he keeps hitting easier
 * rather than harder. So the state moved to colour and a glyph, and the
 * DECISION moved here, where it is a table a test can walk.
 *
 * Cancel wins over everything: a finger off the button is about to throw the
 * recording away whatever else is true. A latch is ended by a tap, so it shows
 * stop. A hold shows send only once it IS a hold; before that the lift would
 * latch, and promising a send there would be a lie. `undecided` draws nothing,
 * which is the honest picture of a press whose outcome is not settled yet.
 */
export type MicOutcome = 'cancel' | 'send' | 'stop' | 'undecided';

export function micOutcome(input: {
    /** The mic is latched: it survives the lift and a tap ends it. */
    latched: boolean;
    /** The finger is down but off the button. */
    cancelArmed: boolean;
    /** The press has been recognised as a hold, so the lift sends. */
    sendArmed: boolean;
}): MicOutcome {
    if (input.cancelArmed) return 'cancel';
    if (input.latched) return 'stop';
    if (input.sendArmed) return 'send';
    return 'undecided';
}

export function reduceMicGesture(gesture: MicGesture, event: MicGestureEvent): MicGestureStep {
    switch (event.type) {
        case 'pressIn':
            if (gesture.state === 'idle') {
                return {
                    next: {
                        state: 'held',
                        pressedAt: event.at,
                        pressedTouchAt: event.touchAt ?? null,
                        outside: false,
                        confirmed: false,
                    },
                    effects: ['open', 'watchHold', 'tick'],
                };
            }
            if (gesture.state === 'latched') {
                // The finger is down on a latched mic; the lift decides, and
                // how long it stays down makes no difference, so no timer.
                return {
                    next: {
                        ...gesture,
                        pressedAt: event.at,
                        pressedTouchAt: event.touchAt ?? null,
                        outside: false,
                        confirmed: false,
                    },
                    effects: [],
                };
            }
            // Already held: a second pressIn is a duplicate, nothing changes.
            return { next: gesture, effects: [] };

        case 'holdConfirm':
            // Only a press that is still down, on a mic that is not latched,
            // can turn into a hold. A timer that outlives its press is inert.
            if (gesture.state !== 'held' || gesture.pressedAt === null) {
                return { next: gesture, effects: [] };
            }
            if (gesture.confirmed) return { next: gesture, effects: [] };
            // The tick IS the feedback: the finger learns where the boundary
            // between a tap and a hold is, while there is still time to act
            // on it.
            return { next: { ...gesture, confirmed: true }, effects: ['tick'] };

        case 'slide': {
            // Only a finger that is actually down can slide off anything.
            if (gesture.pressedAt === null) return { next: gesture, effects: [] };
            const outside = !event.inside;
            if (outside === gesture.outside) return { next: gesture, effects: [] };
            // A tick on each crossing: he can feel which way the lift will go
            // without looking, which is the point of the gesture.
            return { next: { ...gesture, outside }, effects: ['tick'] };
        }

        case 'pressOut':
            if (gesture.state === 'held') {
                if (gesture.outside) {
                    // Slid off, so the lift throws it away however long it was
                    // held. A tap that slid off is a cancel too: nobody drags
                    // off a button they meant to latch.
                    return { next: idleMicGesture, effects: ['cancel', 'tick'] };
                }
                // Two routes to the same conclusion (DROVE-140): the timer
                // that already fired under the finger, or the elapsed time on
                // the OS's touch clock. Either one alone is enough, so a
                // jammed thread that swallowed the timer still reads a long
                // hold as a hold.
                const held = gesture.confirmed || pressElapsed(gesture, event) >= HOLD_MIN_MS;
                if (!held) {
                    return {
                        next: {
                            state: 'latched',
                            pressedAt: null,
                            pressedTouchAt: null,
                            outside: false,
                            confirmed: false,
                        },
                        effects: ['latch', 'tick'],
                    };
                }
                return { next: idleMicGesture, effects: ['send', 'tick'] };
            }
            if (gesture.state === 'latched' && gesture.pressedAt !== null) {
                // A press on a latched mic ends it on the lift: on the button
                // that keeps the words, slid off it throws them away, which is
                // the same promise the hold makes.
                return {
                    next: idleMicGesture,
                    effects: gesture.outside ? ['cancel', 'tick'] : ['stop', 'tick'],
                };
            }
            // A lift with no press behind it (the mic ended under the finger).
            return { next: gesture, effects: [] };

        case 'ended':
            if (gesture.state === 'idle') return { next: gesture, effects: [] };
            // Whoever ended it already has the words; the button just lets go.
            // A finger still down on it is remembered as nothing: its lift
            // arrives in idle and is ignored, rather than reopening the mic.
            return { next: idleMicGesture, effects: gesture.state === 'latched' ? ['tick'] : [] };
    }
}
