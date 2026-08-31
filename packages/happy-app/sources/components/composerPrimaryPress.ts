import type { AgentInputPrimaryAction } from './agentInputPrimaryAction';

/**
 * What a gesture on the composer's send button does (DROVE-98).
 *
 * It is a send button with two gestures: a tap sends, a long-press opens the
 * channel sheet (DROVE-72). React Native fires exactly one of onPress and
 * onLongPress per touch, so the split is here as data rather than in two
 * handlers that could drift apart. The face is decided from the live text,
 * not the transitioned `hasText`, so a fast type-then-tap sends what was
 * typed instead of aborting the agent.
 *
 * BOSS MODE IS NO LONGER ONE OF THE ANSWERS (DROVE-206). The waveform was the
 * face this button wore on an empty composer, so a tap in that one spot did
 * two unrelated things depending on what was in the field. Clay: "the boss
 * should not be in the message box." It is a control of its own on the row
 * now and it calls the mic handler directly, so this table is down to the
 * three things a send button can do: send, halt, or nothing.
 */
export type ComposerPrimaryGesture = 'press' | 'longPress';

export type ComposerPrimaryDispatch = 'send' | 'abort' | 'channels' | 'none';

export interface ComposerPrimaryPressInput {
    gesture: ComposerPrimaryGesture;
    action: AgentInputPrimaryAction;
    /** The composer holds text or an image right now. */
    liveHasContent: boolean;
    /** The Pressable is enabled; a disabled one fires nothing for either gesture. */
    canPress: boolean;
}

export function resolveComposerPrimaryPress(input: ComposerPrimaryPressInput): ComposerPrimaryDispatch {
    if (!input.canPress) return 'none';
    if (input.gesture === 'longPress') return 'channels';
    if (input.liveHasContent) return 'send';
    if (input.action === 'stop') return 'abort';
    // Locked and idle both go through the send path, which shakes the
    // button and explains why nothing went. `idle` never actually arrives
    // here, because an idle button is disabled and `canPress` has already
    // returned 'none'; it stays reachable in the type so a future state that
    // enables the button lands on send rather than on a hole.
    return 'send';
}
