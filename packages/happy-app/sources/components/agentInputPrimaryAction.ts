export type AgentInputPrimaryAction = 'send' | 'stop' | 'blocked' | 'mic' | 'voice' | 'idle';

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
    canDictate = false,
    micLive = false,
    canVoice = false,
}: {
    hasComposerContent: boolean;
    isSendBlocked: boolean;
    isSendDisabled: boolean;
    showAbortButton: boolean;
    canAbort: boolean;
    /** This surface has the dictation mic: a tap latches it (DROVE-210). */
    canDictate?: boolean;
    /** The mic is open right now, latched or held (DROVE-210). */
    micLive?: boolean;
    /** This surface can start a boss-mode call. */
    canVoice?: boolean;
}): AgentInputPrimaryAction {
    // An OPEN mic outranks everything (DROVE-210). Dictation writes its
    // partials straight into the composer, so a live capture makes
    // `hasComposerContent` true within a word or two and the button would
    // turn into Send under the user's thumb: the next tap would fire the
    // half-spoken sentence at the agent with the mic still running. The
    // promise is that a tap stops it and the words WAIT, so while the mic is
    // open the primary button is the mic and nothing else.
    if (micLive && canDictate) {
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
    // An empty composer with dictation available is the microphone. It is
    // ahead of boss mode on purpose, and it is ahead of `idle` for a second
    // reason: dictation survives a transport blip, while `canVoice` is false
    // for every second the session reads disconnected. That used to leave the
    // primary `idle`, which draws a disabled button that swallows the tap with
    // no shake, no haptic and no message. From the phone that is "I pressed
    // the mic and nothing happened" (DROVE-210).
    if (!isSendDisabled && canDictate) {
        return 'mic';
    }
    if (!isSendDisabled && canVoice) {
        return 'voice';
    }
    return 'idle';
}
