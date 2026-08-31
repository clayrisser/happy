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
 * SEND AND THE MIC ARE ONE BUTTON (DROVE-236).
 *
 * Clay: "collapse the send and audio button in a clever way into the same
 * button." The clever part is not which face wins the empty composer, which is
 * what every chat app does. It is that THE COMPOSER'S CONTENTS DO NOT DECIDE
 * ANYTHING WHILE A CAPTURE IS OPEN.
 *
 * ## The trap, named, because the naive rule walks straight into it
 *
 * "Empty means mic, text means send" reads fine and is wrong on this app,
 * because dictation partials land in the composer within a word
 * (`DictationCapture.partial`). Under that rule the button flips to Send under
 * his thumb one syllable into the sentence, and the press that was going to
 * stop the mic sends a half-transcribed line instead. So the capture is checked
 * FIRST and it wins outright: while the mic is open the button is the mic, at
 * every length of text, and only when the capture closes does the composer get
 * a say.
 *
 * ## What a press does, at every state
 *
 *   capture open, any text        MIC     stops the capture, words stay
 *   empty, agent working          STOP    aborts
 *   text, gate refuses            BLOCKED shakes and says why
 *   text, sendable                SEND    sends
 *   empty, dictation available    MIC     opens the capture
 *   empty, no dictation           IDLE    drawn, disabled, nothing
 *
 * ## Why this is not DROVE-206 coming back
 *
 * DROVE-206 took BOSS MODE off this button and Clay backed it: "we should have
 * a send button, proper button." The bug was that one spot on the screen did
 * two UNRELATED things, and a live ElevenLabs call has nothing to do with the
 * message being composed. Dictation is the opposite: it fills this composer,
 * with this message, and the words it produces are what the next press sends.
 * One control for "put words in and send them" is one job.
 *
 * The guarantee DROVE-206 actually bought is the one that has to survive, and
 * it is about the GLYPH: a paper plane means a press sends, and it is drawn
 * when and only when `send` is the action. `mic` draws a microphone. There is
 * no state in the table above where the button looks like send and does
 * something else, which is the whole of "the send button must never be
 * ambiguous about whether a press sends".
 *
 * ## One capture, three entry points (DROVE-210)
 *
 * The mic face does NOT open a capture of its own. It calls `onTalkTap`, the
 * same handler the control row's TalkButton and the headphone press reach, so a
 * latch opened on any of the three is stopped by any of the three. `onTalkTap`
 * has been on this component since DROVE-210 and had no render site; this is
 * it.
 */
export type AgentInputPrimaryAction = 'send' | 'stop' | 'blocked' | 'idle' | 'mic';

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
    captureOpen = false,
    canDictate = false,
}: {
    hasComposerContent: boolean;
    isSendBlocked: boolean;
    isSendDisabled: boolean;
    showAbortButton: boolean;
    canAbort: boolean;
    /**
     * A dictation capture is held or latched RIGHT NOW (DROVE-236). First,
     * ahead of everything, because partials land in the composer within a word
     * and every rule below reads the composer.
     */
    captureOpen?: boolean;
    /** This surface can dictate at all: a recogniser, and a wire to it. */
    canDictate?: boolean;
}): AgentInputPrimaryAction {
    // THE MIC OUTRANKS THE TEXT WHILE IT IS OPEN (DROVE-236). Without this
    // line the button reads `hasComposerContent`, the first partial lands, and
    // it becomes Send while he is still talking. It outranks Stop too: a mic he
    // opened is a mic he must be able to close, and Stop has the whole control
    // row and the header to be reached from.
    if (captureOpen) {
        return 'mic';
    }
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
    // NOTHING TO SEND, SO OFFER THE MIC (DROVE-236). It sits below Stop on
    // purpose: an agent mid-turn with a blank composer is the one moment the
    // thing wanted is a halt, and the mic is still on the control row and on
    // the headphones. It sits below `blocked` and `send` because both of those
    // need content and this branch has none, so they cannot collide.
    if (canDictate && !isSendDisabled) {
        return 'mic';
    }
    // A send button that cannot fire, drawn and disabled. This used to fall
    // through to the waveform, which is what made the button two controls in
    // one place (DROVE-206), and it is now what a phone with no recogniser
    // still gets.
    return 'idle';
}
