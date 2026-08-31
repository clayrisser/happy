/**
 * What the button at the field's trailing rim IS (DROVE-206).
 *
 * It is a SEND BUTTON. Clay: "we should have a send button, proper button."
 * DROVE-153 put it inside the capsule and DROVE-176 gave it the accent once
 * there was something to send, but it still changed identity with the
 * composer's state: an empty field turned it into the waveform, so the same
 * spot on the screen was send or boss mode depending on what you had typed.
 * The waveform is on the control row now, so nothing is competing for the
 * slot and it can just be send.
 *
 * The three faces left are not other identities, they are send unable to
 * proceed. `stop` is the one real exception and it is worth it: a blank
 * composer while the agent works is the case where the thing you want is to
 * halt it, and there is no other control that does. `blocked` is send refused
 * by the gate, and it says so with the lock rather than by disappearing.
 *
 * ON AN EMPTY COMPOSER THE BUTTON IS DISABLED, NOT ABSENT. Four reasons, the
 * first of which is the whole point of the ticket:
 *
 *   1. The field reserves 46pt at that rim whatever is in it, which is what
 *      makes the text's width a pinnable constant per screen width rather
 *      than something that changes between empty and typed. A button that
 *      came and went would reflow the caret on the first keystroke.
 *   2. `stop` already borrows this slot, and it borrows it precisely when the
 *      composer is empty. A slot that vanishes when empty would flicker in
 *      and out every time the agent starts and finishes a turn.
 *   3. DROVE-176's vocabulary already has the state: "the in-field button
 *      with nothing to send" is neutral. Absence would need a new rule; grey
 *      needs none.
 *   4. A visible, inert send button says the composer is empty. A hole says
 *      the app is broken.
 */
export type AgentInputPrimaryAction = 'send' | 'stop' | 'blocked' | 'idle';

/**
 * Which of the primary button's faces an empty composer wears (DROVE-153,
 * DROVE-210).
 *
 * `mic` and `voice` are NOT the same thing and never were, which is what made
 * DROVE-210 hard to read from the outside. `mic` is dictation: it opens the
 * recogniser, fills the composer with what was said and leaves the words there
 * to be read before they go anywhere. `voice` is boss mode, an ElevenLabs CALL
 * with its own pill and its own stop. Both used to resolve to `voice`, so the
 * button drew a waveform and a tap started a call, while this file's own
 * comment and its test both called it dictation. The comment was the honest
 * one: on a phone that can dictate, the biggest button on an empty composer
 * should be the microphone.
 *
 * So `mic` wins the empty composer wherever dictation is available, and
 * `voice` keeps it everywhere else. Boss mode is therefore reached from the
 * composer only with dictation off (Settings > Voice); its pill and the
 * channel sheet are unchanged. That is a deliberate trade, not an oversight:
 * a call is a rarer, louder thing than a sentence, and it was sitting on the
 * control the thumb reaches for first.
 */
export function resolveAgentInputPrimaryAction({
    hasComposerContent,
    isSendBlocked,
    isSendDisabled,
    showAbortButton,
    canAbort,
}: {
    hasComposerContent: boolean;
    isSendBlocked: boolean;
    isSendDisabled: boolean;
    showAbortButton: boolean;
    canAbort: boolean;
}): AgentInputPrimaryAction {
    // A blank composer while the agent is working is the one case where the
    // primary control is Stop. As soon as the user starts a follow-up, sending
    // takes priority so the next message can be queued without aborting work.
    // A blocked send must not suppress Stop: an agent that refuses steering
    // while it thinks is exactly the one the user has no other way to stop.
    if (showAbortButton && canAbort && !hasComposerContent) {
        return 'stop';
    }
    if (isSendBlocked && hasComposerContent) {
        return 'blocked';
    }
    if (!isSendDisabled && hasComposerContent) {
        return 'send';
    }
    // Nothing to send: a send button that cannot fire, drawn and disabled.
    // This used to fall through to the waveform, which is what made the
    // button two controls in one place (DROVE-206).
    return 'idle';
}
