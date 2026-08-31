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
 * should not be in the message box." It is on the control row now, folded into
 * the audio-out button (DROVE-236), and it is not reachable from here.
 *
 * DICTATION IS (DROVE-236), and it is not the same trade. A call is a session
 * thing that has nothing to do with the message; dictation puts words in THIS
 * composer for THIS send. `mic` is the empty composer's answer and, while a
 * capture is open, every composer's answer. See `agentInputPrimaryAction.ts`
 * for the full table and for why the capture is checked before the text.
 *
 * THE LONG PRESS DOES NOT MOVE WITH THE FACE. It is the channel sheet whatever
 * the button currently is, so the second gesture stays one thing and only the
 * tap has a table.
 */
export type ComposerPrimaryGesture = 'press' | 'longPress';

export type ComposerPrimaryDispatch = 'send' | 'abort' | 'channels' | 'mic' | 'none';

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
    // BEFORE the live text (DROVE-236). `mic` means either the composer is
    // empty and offering dictation, or a capture is open and filling it with
    // partials; in the second case there IS live content and it must not send.
    // The one press this button has always had is "do what you are drawn as",
    // and it is drawn as a microphone.
    if (input.action === 'mic') return 'mic';
    if (input.liveHasContent) return 'send';
    if (input.action === 'stop') return 'abort';
    // Locked and idle both go through the send path, which shakes the
    // button and explains why nothing went. `idle` never actually arrives
    // here, because an idle button is disabled and `canPress` has already
    // returned 'none'; it stays reachable in the type so a future state that
    // enables the button lands on send rather than on a hole.
    return 'send';
}
