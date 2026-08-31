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

/**
 * Which sheet is up, given the picker that is open (DROVE-242).
 *
 * Clay, with the permission-mode menu open: "Shouldn't these show in sheets
 * like the effort does". EVERY COMPOSER PICKER IS A SHEET. There is no second
 * kind and no platform where there is one.
 *
 * DROVE-229 left mode and model as iOS native menus, noting they were
 * system-owned. Inside that ticket it was right. It also meant two of the five
 * kinds above sat outside both of the rules this file exists to hold: a native
 * menu is placed by UIKit, so the placement rule did not reach it, and it is
 * dismissed by UIKit, so `open`/`opening` never described it. A second tap on
 * the control could not close it because the control never saw the tap. Two
 * controls a few points apart behaved differently and only one of them could
 * be reasoned about here.
 *
 * So the surface question is answered here rather than at the call site, from
 * the picker and the width alone. No platform is asked.
 *
 *   'list'     the shared list sheet: mode, model or effort, one at a time.
 *   'channels' the channel switches, on the primary button's long press.
 *   'attach'   Add context, on the `+`.
 *   'settings' the wide gear's one sheet, which lists all three at once.
 *
 * `compact` is the phone composer. Wider than that there is no capsule to
 * press, only the gear, and its sheet carries every session field together.
 *
 * ## WHAT THE NATIVE MENU DID THAT THE SHEET DOES NOT
 *
 * Named here rather than found later. Three things, one of them a real cost.
 *
 * THE KEYBOARD. This is the cost. A SwiftUI menu opened OVER the keyboard,
 * instantly, and the keyboard was still there when it closed. A sheet cannot:
 * `composerPickerPress` blurs the field and waits for `keyboardDidHide`, so
 * mode and model now cost a keyboard dismissal and a few hundred milliseconds
 * on the phone, and the keyboard does not come back. That is the same trade
 * effort, channels and Add context already made, and it is why the deferral
 * exists at all, but it is a trade rather than a free win.
 *
 * THE ANCHOR. The menu grew out of the control it belonged to, so which
 * control you had pressed was drawn into the animation. A sheet arrives from
 * the bottom edge and says nothing about where it came from. What replaces it
 * is the control itself: the pressed segment stays washed for as long as its
 * sheet is up, from the moment it is ASKED for, which is a thing the menu
 * could not do because UIKit owned the presentation and the control never
 * heard about it.
 *
 * VOICEOVER'S SELECTED ROW came free with a `Menu` and is a plain `View` in a
 * sheet, so it is done by hand: every picker row carries `role="radio"` and a
 * `checked` state (AgentInput). The menu's focus trap and its two-finger-scrub
 * dismiss are the react-native `Modal`'s job now, which is what every other
 * sheet in the app already relies on.
 *
 * HAPTICS are NOT lost, which is worth saying because it is the first guess.
 * `handlePickerPress` taps on open and every row taps on commit, so both ends
 * of the gesture are still felt.
 */
export type ComposerPickerSheet = 'list' | 'channels' | 'attach' | 'settings' | null;

export function composerPickerSheetOpen(input: {
    open: ComposerPickerKind | null;
    /** The phone composer. False on a tablet, a Mac and the web. */
    compact: boolean;
    /**
     * Whether the effort list has levels to draw.
     *
     * A SHEET WITH NOTHING IN IT DOES NOT OPEN (DROVE-229). Mode always has
     * rows and model draws its own "configure in the CLI" line when the list
     * is empty, so effort is the only one that can come up blank.
     */
    hasEffortLevels: boolean;
}): ComposerPickerSheet {
    if (!input.open) return null;
    if (input.open === 'channels') return input.compact ? 'channels' : null;
    if (input.open === 'attach') return input.compact ? 'attach' : null;
    if (!input.compact) return 'settings';
    if (input.open === 'effort' && !input.hasEffortLevels) return null;
    return 'list';
}
