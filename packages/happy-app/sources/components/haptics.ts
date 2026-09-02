/**
 * Every phone haptic goes through here, and every one of them answers to the
 * `phoneHaptics` switch, which ships OFF (DROVE-190).
 *
 * The gate lives in this module rather than at the thirty call sites so that
 * a component added tomorrow cannot forget it. The taxonomy and the reasoning
 * for one switch instead of two are in utils/hapticKinds.ts.
 *
 * The WRIST does not read any of this. The watch buzzes off the synced
 * `droverAnnounceHaptic` channel (DROVE-124), which this file never touches.
 */

import * as Haptics from 'expo-haptics';
import { wristBeatGap, type WristBeat, type WristCueSpec } from '@/utils/wristCues';
import type { PhoneTapticId } from '@/utils/phoneTaptics';
import { hapticAllowed, type HapticKind } from '@/utils/hapticKinds';
import { storage } from '@/sync/storage';

/**
 * Read the switch live rather than subscribing: a haptic is fired from an
 * event handler, so the store is always there to ask, and a stale copy would
 * buzz once after he turned it off. Tolerant of a store not built yet (a
 * headless background launch, a test that mocked nothing): silence is the
 * default, and silence is what an unknown state should be.
 */
function phoneHapticsOn(): boolean {
    try {
        return storage.getState().localSettings.phoneHaptics === true;
    } catch {
        return false;
    }
}

/** The one place the policy is applied. Returns whether the fire happened. */
function fire(kind: HapticKind, preview: boolean, play: () => void): boolean {
    if (!hapticAllowed(kind, phoneHapticsOn(), preview)) return false;
    play();
    return true;
}

export function hapticsError(preview: boolean = false) {
    fire('interaction', preview, () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    });
}

export function hapticsLight(preview: boolean = false) {
    fire('interaction', preview, () => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    });
}

/** The short tick of a picker moving one notch; the wrap toggle uses it (DROVE-95). */
export function hapticsSelection(preview: boolean = false) {
    fire('interaction', preview, () => {
        void Haptics.selectionAsync();
    });
}

/**
 * The confirmation after a pick (DROVE-75). The app has no sound asset, so
 * this is the taptic half of "the confirmation sound"; the demo screen pairs
 * it with a spoken "Got it" where the speech module exists.
 */
export function hapticsConfirm(preview: boolean = false) {
    fire('interaction', preview, () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    });
}

/**
 * The phone's own announce tap: a Cattle Drover gate arrived and wants a
 * human. The NOTIFICATION kind, and the one Clay was actually complaining
 * about, because it fires while the phone is in his pocket and the wrist has
 * already buzzed for the same gate.
 */
export function hapticsAnnounce(): boolean {
    return fire('notification', false, () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    });
}

/**
 * The nearest phone feedback for each WatchKit beat.
 *
 * Not the same engine, and not pretending to be: `retry` and `directionUp`
 * have no UIKit equivalent, so they are mapped by weight (retry is the heavy
 * one, directionUp the crisp one) and `notification` to the warning
 * double-tap, which is the only UIKit feedback with two beats of its own and
 * the closest thing to the watch's. Count and gap come from the table
 * unchanged; texture is the wrist's to prove.
 */
function playBeat(beat: WristBeat): Promise<void> {
    switch (beat) {
        case 'notification': return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        case 'directionUp': return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
        case 'retry': return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        case 'success': return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        case 'failure': return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        // The in-app three (DROVE-384). They reach a phone only through the
        // Playground, because the moments they answer happen on the wrist —
        // so the mapping is by WEIGHT, like the rest: a reading opening is
        // light, closing is medium, and a flip landing is the selection tick,
        // which is the nearest thing UIKit has to `.click`.
        case 'start': return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        case 'stop': return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        case 'click': return Haptics.selectionAsync();
    }
}

/**
 * Play one wrist pattern on the phone, beat by beat, the same gap apart the
 * watch uses (DROVE-75). Resolves when the last beat has been asked for.
 *
 * Only the demo screen calls this, and only because a finger pressed the row
 * asking to feel it, so it passes `preview`.
 */
export async function playWristCue(spec: WristCueSpec, preview: boolean = false): Promise<void> {
    if (!hapticAllowed('interaction', phoneHapticsOn(), preview)) return;
    for (let index = 0; index < spec.beats.length; index++) {
        if (index > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, wristBeatGap * 1000));
        }
        try {
            await playBeat(spec.beats[index]);
        } catch {
            // A simulator or a phone with haptics off throws here; the demo
            // row still reads what the pattern would have been.
        }
    }
}

/**
 * Fire one of the phone's own one-shot taptics by catalogue id (DROVE-75).
 * Exhaustive over `PhoneTapticId`, so a row added to utils/phoneTaptics.ts
 * without a beat here is a compile error, not a silent no-op.
 */
export function playPhoneTaptic(id: PhoneTapticId, preview: boolean = false): void {
    switch (id) {
        case 'light': return hapticsLight(preview);
        case 'selection': return hapticsSelection(preview);
        case 'confirm': return hapticsConfirm(preview);
        case 'error': return hapticsError(preview);
    }
}
