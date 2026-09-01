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
/**
 * SEND AND THE MIC ARE TWO BUTTONS AGAIN (DROVE-264, reversing DROVE-236).
 *
 * Clay: "I don't think we should combine the send and the microphone button
 * because I might wanna type some stuff and then hit the microphone and then
 * say some stuff."
 *
 * DROVE-236 collapsed them on the argument that "put words in and send them"
 * is one job. It is one job and it is not one MOMENT, which is where the
 * collapse failed: one slot can only offer send or the mic, so reaching the mic
 * means the send affordance has to go, and a composition that types a bit,
 * dictates the rest and then sends cannot be drawn. Two controls can.
 *
 * ## What that deletes from this file, and it is the hardest thing in it
 *
 * `captureOpen` is GONE, along with the ordering it forced. DROVE-236 had to
 * check the capture FIRST, ahead of the composer's contents, because dictation
 * partials land in the field within a word (`DictationCapture.partial`): under
 * the naive rule the button flipped to Send one syllable into the sentence and
 * the press meant to close the mic sent a half-transcribed line. The mic is its
 * own control now, so there is nothing to flip INTO. The trap had a subject
 * only while one slot held two identities.
 *
 * `canDictate` goes with it. The mic's availability decides whether the MIC is
 * drawn, which is the mic button's business; it has no bearing on what send is.
 *
 * ## What a press does, at every state
 *
 *   empty, agent working          STOP    aborts
 *   text, gate refuses            BLOCKED shakes and says why
 *   text, sendable                SEND    sends
 *   empty                         IDLE    drawn, disabled, nothing
 *
 * A capture being open changes none of those rows, on purpose: while he is
 * dictating, send is live if there are words and inert if there are not, which
 * is what it says at every other moment too. Sending mid-capture is now
 * reachable and that is the feature, not a leak.
 *
 * ## The guarantee DROVE-206 bought is now structural
 *
 * "The send button must never be ambiguous about whether a press sends." That
 * used to be defended by an ordering in this function and by drawing a
 * microphone on the shared slot. It is now a property of the tree: the send
 * button is only ever send, Stop or a refusal, and none of those is a mic.
 *
 * ## On an empty composer the button is DRAWN AND DISABLED
 *
 * Not absent, and DROVE-206's four reasons are untouched by the split:
 *
 *   1. The row reserves the same width whatever is in the field, so nothing
 *      reflows on the first keystroke.
 *   2. `stop` borrows this slot precisely when the composer is empty, so a slot
 *      that vanished when empty would flicker every time the agent starts and
 *      finishes a turn.
 *   3. DROVE-176's vocabulary already has the state: an in-field button with
 *      nothing to send is neutral. Absence would need a new rule.
 *   4. A visible, inert send button says the composer is empty. A hole says the
 *      app is broken.
 *
 * It also stops being the interesting case. Before DROVE-236 an empty composer
 * had to decide between send and the waveform, and DROVE-236 decided between
 * send and the mic. Neither question exists now: an empty composer draws a
 * disabled send AND a live mic, which is what it always wanted to say.
 */
export type AgentInputPrimaryAction = 'send' | 'stop' | 'blocked' | 'idle';

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
    // A send button that cannot fire, drawn and disabled. It used to fall
    // through to the waveform, which is what made the button two controls in
    // one place (DROVE-206), and then to the mic, which is what DROVE-236 made
    // it. The mic is beside it now, so this branch is what it always claimed to
    // be: send with nothing to send.
    return 'idle';
}
