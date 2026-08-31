import type { AgentInputPrimaryAction } from './agentInputPrimaryAction';

/**
 * What a gesture on the composer's primary button does (DROVE-98, DROVE-210).
 *
 * The button is one control with five faces (send, stop, mic, boss mode,
 * locked) and two gestures: a tap runs the face, a long-press opens the
 * channel sheet (DROVE-72). React Native fires exactly one of onPress and
 * onLongPress per touch, so the split is here as data rather than in two
 * handlers that could drift apart. The face is decided from the live text,
 * not the transitioned `hasText`, so a fast type-then-tap sends what was
 * typed instead of aborting the agent or starting a call.
 *
 * WHY THE MIC FACE ONLY LATCHES (DROVE-210). A tap here opens the mic and
 * leaves it open; the next tap stops it with the words in the composer,
 * unsent. It cannot also do push-to-talk, and that is a fact about the
 * gesture rather than a decision: `onPress` fires once, on the lift, with no
 * press-in, no duration and no coordinates, so there is nothing to hold and
 * nothing to slide off. Push-to-talk and slide-to-cancel stay on the
 * control-row capsule's TalkButton, which owns the whole touch stream. Both
 * controls drive the SAME capture, so a latch opened on either is stopped by
 * either.
 */
export type ComposerPrimaryGesture = 'press' | 'longPress';

export type ComposerPrimaryDispatch = 'send' | 'abort' | 'mic' | 'boss' | 'channels' | 'none';

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
    if (input.action === 'mic') return 'mic';
    if (input.action === 'voice') return 'boss';
    // Locked and idle both go through the send path, which shakes the
    // button and explains why nothing went.
    return 'send';
}
