/**
 * The talk button's gesture, as a pure reducer (DROVE-74).
 *
 * One button, two ergonomics. Press-and-hold is push-to-talk: the mic opens
 * on the press and closes on the lift. A tap, a press shorter than
 * TAP_MAX_MS, LATCHES the mic instead: it stays open after the lift until
 * the next tap. Both start listening on the press itself, so a tap costs no
 * extra latency and a hold never misses the first word.
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
}

export type MicGestureEvent =
    | { type: 'pressIn'; at: number }
    | { type: 'pressOut'; at: number }
    /** The capture ended on its own: idle stop, interrupt, recogniser gave up. */
    | { type: 'ended' };

export type MicEffect =
    /** Open the microphone. */
    | 'open'
    /** Keep it open after the lift; the idle clock starts here. */
    | 'latch'
    /** Close it and send what was heard. */
    | 'close'
    /** A haptic tick: the user's finger should feel the state change. */
    | 'tick';

/**
 * A press released within this window is a tap. Longer is a hold. 300 ms
 * sits between a deliberate tap (well under 200) and the shortest utterance
 * anyone push-to-talks (a "yes" held for half a second).
 */
export const TAP_MAX_MS = 300;

export const idleMicGesture: MicGesture = { state: 'idle', pressedAt: null };

export interface MicGestureStep {
    next: MicGesture;
    effects: MicEffect[];
}

export function reduceMicGesture(gesture: MicGesture, event: MicGestureEvent): MicGestureStep {
    switch (event.type) {
        case 'pressIn':
            if (gesture.state === 'idle') {
                return { next: { state: 'held', pressedAt: event.at }, effects: ['open', 'tick'] };
            }
            if (gesture.state === 'latched') {
                // The finger is down on a latched mic; the lift decides.
                return { next: { state: 'latched', pressedAt: event.at }, effects: [] };
            }
            // Already held: a second pressIn is a duplicate, nothing changes.
            return { next: gesture, effects: [] };

        case 'pressOut':
            if (gesture.state === 'held') {
                const heldFor = gesture.pressedAt === null ? Infinity : event.at - gesture.pressedAt;
                if (heldFor <= TAP_MAX_MS) {
                    return { next: { state: 'latched', pressedAt: null }, effects: ['latch', 'tick'] };
                }
                return { next: idleMicGesture, effects: ['close', 'tick'] };
            }
            if (gesture.state === 'latched' && gesture.pressedAt !== null) {
                // Tap or hold, a press on a latched mic ends it on the lift.
                return { next: idleMicGesture, effects: ['close', 'tick'] };
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
