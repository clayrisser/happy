/**
 * Which composer picker is up, and what a press on its control does
 * (DROVE-229).
 *
 * Clay: "And if I click a second time it will go away." The toggle was already
 * written — same picker pressed again means close — but it lived inside
 * AgentInput as a closure over a `useState` and two refs, where no spec could
 * reach it and where one control skipped it entirely. So it is here, pure, and
 * the component is a renderer for it.
 *
 * A PICKER IS UP FROM THE MOMENT IT IS ASKED FOR, NOT THE MOMENT IT IS DRAWN.
 * That is the whole subtlety. With the keyboard visible the open is DEFERRED:
 * the field is blurred, the keyboard dismissed, and the sheet waits behind a
 * `keyboardDidHide` listener with a fallback timer, because a sheet that opens
 * under a keyboard on its way out lands in the wrong place. For those few
 * hundred milliseconds nothing is on screen yet. A second press in that window
 * has to CANCEL, not queue a second open, and that is exactly the window Clay
 * is in after typing.
 *
 * So `open` is what is drawn and `opening` is what is owed, and a press
 * matching EITHER puts the picker down. There is no state where the control
 * has been pressed and pressing it again does nothing.
 *
 * WHAT DISMISSES A PICKER, ALL THREE ROUTES:
 *   - the control again, which is this file;
 *   - a tap outside, which is ComposerSheet's backdrop Pressable;
 *   - the back gesture, which is that same sheet's `Modal onRequestClose`.
 * Every composer picker is a ComposerSheet, so all three come as a set. The
 * effort readout is the one surface that is not a sheet, and it is not a
 * picker any more either: it lives as long as the finger and takes no touches
 * (effortSlider.ts).
 */

export type ComposerPickerKind = 'channels' | 'attach' | 'permission' | 'model' | 'effort';

export interface ComposerPickerState {
    /** Drawn, on screen. */
    open: ComposerPickerKind | null;
    /** Asked for, waiting on the keyboard to leave. */
    opening: ComposerPickerKind | null;
}

export const composerPickerClosed: ComposerPickerState = { open: null, opening: null };

export interface ComposerPickerStep {
    state: ComposerPickerState;
    /**
     * Arm the `keyboardDidHide` listener and the fallback timer.
     *
     * The caller drops whatever was armed on EVERY step first, this one
     * included: a press during the window either cancels the request or
     * replaces it, and both leave the old listener with nothing to open.
     */
    defer: boolean;
    /** Blur the field and put the keyboard away, then wait for `defer`. */
    dismissKeyboard: boolean;
}

function step(
    state: ComposerPickerState,
    options: { defer?: boolean; dismissKeyboard?: boolean } = {},
): ComposerPickerStep {
    return {
        state,
        defer: options.defer === true,
        dismissKeyboard: options.dismissKeyboard === true,
    };
}

/**
 * A press on a picker's own control.
 *
 * `keyboardVisible` is false on web, where the deferral does not apply: there
 * is no keyboard animating a sheet out of place.
 */
export function composerPickerPress(
    state: ComposerPickerState,
    picker: ComposerPickerKind,
    input: { keyboardVisible: boolean },
): ComposerPickerStep {
    // The second tap. Either half counts: a picker that is drawn, and one that
    // is owed but has not been drawn yet.
    if (state.open === picker || state.opening === picker) {
        return step(composerPickerClosed);
    }
    if (!input.keyboardVisible) {
        return step({ open: picker, opening: null });
    }
    return step(
        { open: null, opening: picker },
        { defer: true, dismissKeyboard: true },
    );
}

/**
 * The keyboard has gone, or the fallback timer ran out. Whichever arrives
 * first drops the other, and a second call then finds nothing owed and draws
 * nothing.
 */
export function composerPickerKeyboardGone(state: ComposerPickerState): ComposerPickerStep {
    if (!state.opening) return step(state);
    return step({ open: state.opening, opening: null });
}

/** A tap outside, the back gesture, a row that picked something, unmount. */
export function composerPickerDismiss(): ComposerPickerStep {
    return step(composerPickerClosed);
}
