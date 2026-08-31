import { describe, expect, it } from 'vitest';
import {
    composerPickerClosed,
    composerPickerDismiss,
    composerPickerKeyboardGone,
    composerPickerPress,
    type ComposerPickerKind,
    type ComposerPickerState,
} from './composerPicker';

/**
 * "And if I click a second time it will go away" (DROVE-229).
 *
 * The toggle was in AgentInput already, so the first question was why it did
 * not happen in Clay's hand. Two answers, and this file is about the second.
 *
 * ONE: the effort segment never reached it. On the phone that segment is a raw
 * JS responder driving the slider, not a Pressable with an `onPress`, so a tap
 * latched the slider's own readout open and `handlePickerPress` was dead code
 * for it. That is fixed in effortSlider.ts and wired in AgentInput; the readout
 * has no latch left to be stuck in.
 *
 * TWO: the keyboard deferral, which is the state Clay is in every time —
 * he types, then taps. With the keyboard up the open is POSTPONED behind a
 * `keyboardDidHide` listener and a fallback timer, so for a few hundred
 * milliseconds the picker has been asked for and nothing is on screen. The
 * toggle has to work inside that window too, or the second tap queues a second
 * open instead of cancelling. That is what the `opening` half of the state is
 * for, and it is what these assertions pin.
 */

const start = composerPickerClosed;

/** Press the control, keyboard down. */
function tap(state: ComposerPickerState, picker: ComposerPickerKind) {
    return composerPickerPress(state, picker, { keyboardVisible: false });
}

/** Press the control with the keyboard up, which defers. */
function tapTyping(state: ComposerPickerState, picker: ComposerPickerKind) {
    return composerPickerPress(state, picker, { keyboardVisible: true });
}

describe('a press opens the picker it belongs to', () => {
    it('opens straight away with the keyboard down', () => {
        const step = tap(start, 'permission');
        expect(step.state).toEqual({ open: 'permission', opening: null });
        expect(step.defer).toBe(false);
        expect(step.dismissKeyboard).toBe(false);
    });

    it('waits for the keyboard to leave before it opens', () => {
        const step = tapTyping(start, 'effort');
        // Nothing is drawn yet, but the picker is owed.
        expect(step.state).toEqual({ open: null, opening: 'effort' });
        expect(step.defer).toBe(true);
        expect(step.dismissKeyboard).toBe(true);
    });

    it('opens what was owed once the keyboard has gone', () => {
        const deferred = tapTyping(start, 'model').state;
        expect(composerPickerKeyboardGone(deferred).state).toEqual({ open: 'model', opening: null });
    });

    it('opens once whichever of the listener and the timer gets there first', () => {
        // Both are armed; both call the same thing. The second finds nothing
        // owed, because the first cleared it.
        const deferred = tapTyping(start, 'attach').state;
        const opened = composerPickerKeyboardGone(deferred).state;
        expect(composerPickerKeyboardGone(opened).state).toEqual(opened);
    });

    it('opens nothing on a stray keyboard hide with nothing owed', () => {
        expect(composerPickerKeyboardGone(start).state).toBe(start);
        const open = tap(start, 'channels').state;
        expect(composerPickerKeyboardGone(open).state).toBe(open);
    });
});

describe('the second press on the same control closes it', () => {
    const pickers: ComposerPickerKind[] = ['channels', 'attach', 'permission', 'model', 'effort'];

    it('closes an open picker, keyboard down, on every one of the five', () => {
        for (const picker of pickers) {
            const open = tap(start, picker).state;
            expect(tap(open, picker).state).toEqual(composerPickerClosed);
        }
    });

    it('closes an open picker with the keyboard back up', () => {
        // The keyboard can return under an open picker — a sheet that rides it,
        // a field refocused behind it. A press on the control still closes:
        // the toggle is checked before the deferral is ever considered.
        for (const picker of pickers) {
            const open = tap(start, picker).state;
            const step = tapTyping(open, picker);
            expect(step.state).toEqual(composerPickerClosed);
            expect(step.defer).toBe(false);
            expect(step.dismissKeyboard).toBe(false);
        }
    });

    it('CANCELS a picker that is still waiting on the keyboard', () => {
        // The window Clay is in: type, tap, tap again before the keyboard has
        // finished leaving. Nothing is on screen yet, and the second tap has to
        // put the request down rather than queue another one.
        for (const picker of pickers) {
            const deferred = tapTyping(start, picker).state;
            const step = tapTyping(deferred, picker);
            expect(step.state).toEqual(composerPickerClosed);
            // Nothing is owed and nothing is armed, so the sheet does not
            // appear 420ms later on its own.
            expect(step.defer).toBe(false);
        }
    });

    it('leaves nothing owed after a cancelled deferral, whatever arrives next', () => {
        const deferred = tapTyping(start, 'effort').state;
        const cancelled = tapTyping(deferred, 'effort').state;
        // The keyboard hides anyway, or the fallback fires anyway.
        expect(composerPickerKeyboardGone(cancelled).state).toEqual(composerPickerClosed);
    });

    it('closes it after the deferral has resolved, on the next press', () => {
        const opened = composerPickerKeyboardGone(tapTyping(start, 'effort').state).state;
        expect(opened.open).toBe('effort');
        expect(tap(opened, 'effort').state).toEqual(composerPickerClosed);
    });
});

describe('a press on a DIFFERENT control swaps, and never stacks', () => {
    it('replaces an open picker rather than opening two', () => {
        const open = tap(start, 'permission').state;
        const step = tap(open, 'model');
        expect(step.state).toEqual({ open: 'model', opening: null });
    });

    it('replaces a picker that is still waiting on the keyboard', () => {
        const deferred = tapTyping(start, 'permission').state;
        const step = tapTyping(deferred, 'model');
        expect(step.state).toEqual({ open: null, opening: 'model' });
        // It defers again, and the caller drops the old listener and timer
        // before arming these, so the picker that arrives is the one last
        // asked for and the first one never appears behind it.
        expect(step.defer).toBe(true);
        expect(composerPickerKeyboardGone(step.state).state.open).toBe('model');
    });

    it('never has two pickers at once, by any route', () => {
        const states = [
            tap(start, 'attach').state,
            tapTyping(start, 'attach').state,
            composerPickerKeyboardGone(tapTyping(start, 'attach').state).state,
            tap(tap(start, 'attach').state, 'effort').state,
            tapTyping(tapTyping(start, 'permission').state, 'channels').state,
        ];
        for (const state of states) {
            expect(state.open === null || state.opening === null).toBe(true);
        }
    });
});

describe('every other dismissal route lands in the same place', () => {
    it('closes from a tap outside, the back gesture, or a row that picked', () => {
        // ComposerSheet's backdrop Pressable and its Modal `onRequestClose`
        // both call the same thing a row calls after it commits.
        expect(composerPickerDismiss().state).toEqual(composerPickerClosed);
        expect(composerPickerDismiss().defer).toBe(false);
    });

    it('drops a deferral nobody is waiting for any more', () => {
        // Dismissing during the window has to drop the listener and the timer
        // too, or the sheet arrives after the thing that dismissed it. The
        // caller cancels on every step and re-arms only on a defer, so a
        // dismiss leaves nothing to fire.
        const dismissed = composerPickerDismiss();
        expect(dismissed.defer).toBe(false);
        expect(composerPickerKeyboardGone(dismissed.state).state).toEqual(composerPickerClosed);
    });

    it('leaves no state where a picker is up with nothing to close it', () => {
        // Exhaustive over the reachable states: from each one, a press on
        // whatever is up puts it down, and so does a dismiss.
        const reachable: ComposerPickerState[] = [];
        const pickers: ComposerPickerKind[] = ['channels', 'attach', 'permission', 'model', 'effort'];
        for (const picker of pickers) {
            reachable.push(tap(start, picker).state);
            reachable.push(tapTyping(start, picker).state);
            reachable.push(composerPickerKeyboardGone(tapTyping(start, picker).state).state);
        }
        for (const state of reachable) {
            const up = state.open ?? state.opening;
            expect(up).not.toBeNull();
            expect(tap(state, up!).state).toEqual(composerPickerClosed);
            expect(tapTyping(state, up!).state).toEqual(composerPickerClosed);
            expect(composerPickerDismiss().state).toEqual(composerPickerClosed);
        }
    });
});
