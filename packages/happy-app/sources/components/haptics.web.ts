import type { WristCueSpec } from '@/utils/wristCues';
import type { PhoneTapticId } from '@/utils/phoneTaptics';

export function hapticsError() {
    // No implementation
}

export function hapticsLight() {
    // No implementation
}

export function hapticsSelection() {
    // No implementation
}

export function hapticsConfirm() {
    // No implementation
}

export async function playWristCue(_spec: WristCueSpec): Promise<void> {
    // No taptic engine on the web. The demo row still says what it would be.
}

export function playPhoneTaptic(_id: PhoneTapticId): void {
    // No implementation
}
