/**
 * The talk button's gesture, as a pure reducer (DROVE-74, DROVE-105).
 *
 * One button, three outcomes. Press-and-hold is push-to-talk: the mic opens
 * on the press and the lift SENDS. A tap, a press shorter than TAP_MAX_MS,
 * LATCHES the mic instead: it stays open after the lift, and the next tap
 * STOPS it with the words left in the composer, unsent. Sliding the finger
 * off the button before lifting CANCELS: the recording is thrown away and
 * the composer goes back to what it held. Both ergonomics start listening on
 * the press itself, so a tap costs no extra latency and a hold never misses
 * the first word.
 *
 * Why the latch never sends and a hold still does (DROVE-105): a hold is a
 * momentary, deliberate gesture with the finger on the button the whole
 * time, and it now has an escape hatch, so lifting it can mean "send" the
 * way a walkie-talkie does. A latch is the opposite: it survives the lift,
 * it is the one you leave running while you think, and the words have to
 * wait in the composer to be read before they go anywhere.
 *
 * Nothing here schedules, records or vibrates. The reducer names EFFECTS and
 * the hook carries them out, which is what makes tap-versus-hold timing a
 * table of cases in a spec rather than a thing to feel for on a phone.
 */

/** What the button draws. Three states, all visibly different. */
export type MicButtonState = 'idle' | 'held' | 'latched';

export interface MicGesture {
    state: MicButtonState;
    /** When the current finger went down; null when none is down. */
    pressedAt: number | null;
    /**
     * The finger is down but has slid off the button. The lift will cancel,
     * and the banner says so before it happens.
     */
    outside: boolean;
}

export type MicGestureEvent =
    | { type: 'pressIn'; at: number }
    | { type: 'pressOut'; at: number }
    /** The finger moved across the button's edge while still down. */
    | { type: 'slide'; inside: boolean }
    /** The capture ended on its own: idle stop, interrupt, recogniser gave up. */
    | { type: 'ended' };

export type MicEffect =
    /** Open the microphone. */
    | 'open'
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
 * A press released within this window is a tap. Longer is a hold. 300 ms
 * sits between a deliberate tap (well under 200) and the shortest utterance
 * anyone push-to-talks (a "yes" held for half a second).
 */
export const TAP_MAX_MS = 300;

/**
 * How far past the button's edge the finger may stray before the gesture
 * counts as slid off. Wider than the button's own hitSlop, because a wobble
 * during a two-second hold must not throw the sentence away; narrow enough
 * that a deliberate slide onto the text field is unambiguous.
 */
export const CANCEL_SLOP = 16;

export const idleMicGesture: MicGesture = { state: 'idle', pressedAt: null, outside: false };

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

export function reduceMicGesture(gesture: MicGesture, event: MicGestureEvent): MicGestureStep {
    switch (event.type) {
        case 'pressIn':
            if (gesture.state === 'idle') {
                return {
                    next: { state: 'held', pressedAt: event.at, outside: false },
                    effects: ['open', 'tick'],
                };
            }
            if (gesture.state === 'latched') {
                // The finger is down on a latched mic; the lift decides.
                return { next: { ...gesture, pressedAt: event.at, outside: false }, effects: [] };
            }
            // Already held: a second pressIn is a duplicate, nothing changes.
            return { next: gesture, effects: [] };

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
                const heldFor = gesture.pressedAt === null ? Infinity : event.at - gesture.pressedAt;
                if (heldFor <= TAP_MAX_MS) {
                    return {
                        next: { state: 'latched', pressedAt: null, outside: false },
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
