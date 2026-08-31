import type { DictationCaptureEvents, DictationCaptureState, DictationEndReason } from './dictationCapture';
import { joinDictation } from './dictationDraft';

/**
 * What a capture ending does to the composer (DROVE-120).
 *
 * THE INVARIANT: text that has already appeared in the composer is never
 * removed by a dictation path. The only things that clear the composer are a
 * send, or the user editing it himself. A capture ending for any reason KEEPS
 * what was transcribed; reasons differ only in whether they also SEND.
 *
 * This used to be `if (reason !== 'sent') restore the pre-mic draft`, which
 * made throwing the words away the DEFAULT and keeping them the exception. So
 * every route that was not a send wiped the partials already on screen: an
 * idle stop, a recogniser that gave up, and, worst of all, any read-aloud
 * interrupt arriving mid-hold (`mic`, `call-started`, `switched-session`,
 * `toggled-off`, `sent`), because useVoiceComposer subscribes
 * `capture.interrupt` straight to `readAloud.addInterruptListener`. DROVE-105
 * fixed one route of many. This table inverts the default so the rest cannot
 * come back.
 *
 * Written as a table rather than a condition on purpose: `satisfies` means a
 * new DictationEndReason does not COMPILE until someone decides here, in one
 * place, which side of the invariant it falls on. That is what keeps a future
 * reason from silently reintroducing the bug.
 */
export const dictationRestoresDraft = {
    /**
     * THE ONE EXCEPTION, and it is the user asking. `cancel` is the slide-off
     * gesture (DROVE-105): finger held on the mic, slid off the button, lifted
     * there. That is the voice-note cancel every messaging app has, and its
     * entire meaning is "throw this away". The banner says `Release to cancel`
     * in graphite while the finger is off, so it is never a surprise. A user
     * asking for the words to go is not the composer losing them.
     */
    cancel: true,
    /** The lift on the button. The words go to the composer and then send. */
    send: false,
    /** The tap that ends a latch. Words kept, nothing sent. */
    stop: false,
    /** The latch hit its idle deadline. A timeout never costs words. */
    idle: false,
    /** Apple finalised or gave up on its own. It still heard what it heard. */
    recogniser: false,
    /** He started typing over the partial. His keystrokes AND the words stay. */
    typed: false,
    /** A message was sent, so the composer was cleared by the send itself. */
    sent: false,
    /** Read-aloud was cut because the mic opened. Nothing to take back. */
    mic: false,
    /** The screen went away. The draft is waiting when he comes back. */
    'left-session': false,
    /** He moved to another session mid-hold. Same draft, still his. */
    'switched-session': false,
    /** Read-aloud was switched off mid-hold. Unrelated to his sentence. */
    'toggled-off': false,
    /** A boss-mode call took the audio session. It does not get the words. */
    'call-started': false,
} satisfies Record<DictationEndReason, boolean>;

/**
 * Every reason there is, at runtime. Derived from the table, so a test can
 * walk the whole union and the union cannot grow behind the test's back.
 */
export const dictationEndReasons = Object.keys(dictationRestoresDraft) as DictationEndReason[];

/** Everything the composer side of a capture needs from its screen. */
export interface DictationComposerPort {
    /** What the composer held when the mic opened. Partials re-join onto it. */
    base(): string;
    /** Replace the composer's text. */
    setComposerText(text: string): void;
    /** Send what the composer now holds. */
    send(): void;
    onError(message: string): void;
    onChange(state: DictationCaptureState): void;
}

/**
 * The capture's events wired to a composer, as one pure factory.
 *
 * It lives outside useVoiceComposer so the invariant above is exercised by
 * tests against the SAME code the app runs, rather than by a re-implementation
 * that can drift from the hook.
 */
export function dictationComposerEvents(port: DictationComposerPort): DictationCaptureEvents {
    return {
        onPartial: (text) => {
            port.setComposerText(joinDictation(port.base(), text));
        },
        onCommit: (text, shouldSend, reason) => {
            // Typing means the user is already editing over the partial;
            // rewriting it would eat the keystroke.
            if (reason !== 'typed') port.setComposerText(joinDictation(port.base(), text));
            if (shouldSend) port.send();
        },
        onDiscard: (reason) => {
            // The invariant: a capture ending keeps what is on screen. Only
            // the named exception in `dictationRestoresDraft` takes it back.
            if (!dictationRestoresDraft[reason]) return;
            port.setComposerText(port.base());
        },
        onError: (message) => port.onError(message),
        onChange: (state) => port.onChange(state),
    };
}
