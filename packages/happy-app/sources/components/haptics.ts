import * as Haptics from 'expo-haptics';
import { wristBeatGap, type WristBeat, type WristCueSpec } from '@/utils/wristCues';
import type { PhoneTapticId } from '@/utils/phoneTaptics';

export function hapticsError() {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

export function hapticsLight() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** The short tick of a picker moving one notch; the wrap toggle uses it (DROVE-95). */
export function hapticsSelection() {
    Haptics.selectionAsync();
}

/**
 * The confirmation after a pick (DROVE-75). The app has no sound asset, so
 * this is the taptic half of "the confirmation sound"; the demo screen pairs
 * it with a spoken "Got it" where the speech module exists.
 */
export function hapticsConfirm() {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
    }
}

/**
 * Play one wrist pattern on the phone, beat by beat, the same gap apart the
 * watch uses (DROVE-75). Resolves when the last beat has been asked for.
 */
export async function playWristCue(spec: WristCueSpec): Promise<void> {
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
export function playPhoneTaptic(id: PhoneTapticId): void {
    switch (id) {
        case 'light': return hapticsLight();
        case 'selection': return hapticsSelection();
        case 'confirm': return hapticsConfirm();
        case 'error': return hapticsError();
    }
}
