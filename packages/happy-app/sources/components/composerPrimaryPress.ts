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
 * AND NEITHER IS DICTATION, SINCE DROVE-264. DROVE-236 gave this button a
 * `mic` face on the empty composer and while a capture was open, and Clay asked
 * for the two apart: "I might wanna type some stuff and then hit the microphone
 * and then say some stuff." The mic is its own button beside this one now, with
 * its own press, so this table has no `mic` row and the ordering that protected
 * it is gone with it. `agentInputPrimaryAction.ts` has the argument.
 *
 * THE LONG PRESS DOES NOT MOVE WITH THE FACE. It is the channel sheet whatever
 * the button currently is, so the second gesture stays one thing and only the
 * tap has a table.
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
    // The live text, first and with nothing above it (DROVE-264). DROVE-236 had
    // to check a `mic` face before this line, because a capture open on this
    // same button filled the composer with partials and the press had to close
    // the mic rather than send them. There is no mic face here any more, so a
    // press with content in the field sends it, whether the words were typed or
    // dictated. That is the whole point of the split.
    if (input.liveHasContent) return 'send';
    if (input.action === 'stop') return 'abort';
    // Locked and idle both go through the send path, which shakes the
    // button and explains why nothing went. `idle` never actually arrives
    // here, because an idle button is disabled and `canPress` has already
    // returned 'none'; it stays reachable in the type so a future state that
    // enables the button lands on send rather than on a hole.
    return 'send';
}
