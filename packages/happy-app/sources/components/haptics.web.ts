import type { WristCueSpec } from '@/utils/wristCues';
import type { PhoneTapticId } from '@/utils/phoneTaptics';

// The web has no taptic engine, so DROVE-190's switch has nothing to gate
// here. Signatures match the native module so a `preview` argument compiles
// on both.

export function hapticsError(_preview: boolean = false) {
    // No implementation
}

export function hapticsLight(_preview: boolean = false) {
    // No implementation
}

export function hapticsSelection(_preview: boolean = false) {
    // No implementation
}

export function hapticsConfirm(_preview: boolean = false) {
    // No implementation
}

export function hapticsAnnounce(): boolean {
    return false;
}

export async function playWristCue(_spec: WristCueSpec, _preview: boolean = false): Promise<void> {
    // No taptic engine on the web. The demo row still says what it would be.
}

export function playPhoneTaptic(_id: PhoneTapticId, _preview: boolean = false): void {
    // No implementation
}
