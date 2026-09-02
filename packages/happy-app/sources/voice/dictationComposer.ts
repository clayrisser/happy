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
    /**
     * The headphones came out, so read-aloud was cut to stop a private reply
     * playing to the room (DROVE-119). That is about who can HEAR, and says
     * nothing about what he dictated, so his words stay.
     */
    'headphones-unplugged': false,
    /**
     * A voice preview in settings took the speaker (DROVE-162). It cannot
     * happen while he is dictating into a session at all, and it says nothing
     * about what he said, so his words stay.
     */
    preview: false,
    /**
     * The app went to the background (DROVE-179). The capture is over because
     * the recogniser is, but he was mid-sentence when the push arrived and
     * those words are his. They are waiting when he comes back.
     */
    backgrounded: false,
    /**
     * The session's transport dropped (DROVE-179). There is nothing to dictate
     * INTO for a moment, which is why the capture ends, but a reconnect says
     * nothing about what he had already said. His words stay.
     */
    disconnected: false,
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
    /**
     * What the composer holds RIGHT NOW, read live (DROVE-360).
     *
     * `base()` is a snapshot and cannot answer "has he touched this since?".
     * This can, and that question is the whole of the ownership rule below.
     */
    current(): string;
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
    /**
     * The span dictation owns: exactly the string it last wrote into the
     * composer, or null before it has written anything this capture
     * (DROVE-360).
     *
     * DICTATION OWNS ONE REPLACEABLE RANGE, and this is it. Every partial and
     * every final REPLACES that range; nothing appends to it. The moment the
     * composer no longer reads back as this string, the user has typed into it
     * or edited a word, the range stopped being dictation's, and a late
     * transcript may not have it back.
     *
     * WHY A LIVE READ AND NOT A REASON CODE. `onCommit` already skipped the
     * write for reason `typed`, which is the interrupt route the keyboard
     * fires. It does not cover the route Clay actually hit: he taps stop, the
     * mic closes, and `stopDictation` settles its final up to two seconds
     * later (it waits for Apple's final result and falls back on a 2s
     * timeout). He is editing a word inside that window, the late commit
     * rewrites the whole field from the stale `base()`, and the caret snaps to
     * the end — "sometimes I'll stop talking and then try to edit a word and
     * it jumps like that and messes up the word I'm trying to edit". No reason
     * code can see that, because the capture has already ended and nothing
     * told it. The composer itself is the only witness, so the composer is
     * asked.
     */
    let written: string | null = null;
    /** Whether the last state we saw was a running capture. */
    let capturing = false;

    /** Is the composer still holding exactly what dictation put there? */
    const owned = (): boolean => written === null || port.current() === written;

    /** Replace the owned span, and remember what we left behind. */
    const replace = (text: string): void => {
        port.setComposerText(text);
        written = text;
    };

    return {
        onPartial: (text) => {
            if (!owned()) return;
            replace(joinDictation(port.base(), text));
        },
        onCommit: (text, shouldSend, reason) => {
            // Typing means the user is already editing over the partial;
            // rewriting it would eat the keystroke. `owned()` catches the
            // slower version of the same thing: an edit made after the mic
            // closed, while the final was still settling (DROVE-360).
            if (reason !== 'typed' && owned()) replace(joinDictation(port.base(), text));
            // The send still goes. Only a LIFT sends, and a finger on the
            // button is not a finger editing a word, so a send that reaches
            // here was asked for however the text got where it is.
            if (shouldSend) port.send();
        },
        onDiscard: (reason) => {
            // The invariant: a capture ending keeps what is on screen. Only
            // the named exception in `dictationRestoresDraft` takes it back.
            if (!dictationRestoresDraft[reason]) return;
            // And it only takes back a span dictation still owns. A cancel
            // that landed after he started typing would otherwise put the
            // pre-mic draft over his keystrokes.
            if (!owned()) return;
            replace(port.base());
        },
        onError: (message) => port.onError(message),
        onChange: (state) => {
            // A capture STARTING is the one thing that hands the range back to
            // dictation. Not a capture ending: the final for the capture that
            // just ended is still in flight, and forgetting what we wrote is
            // exactly how it would get to overwrite an edit.
            if (state.active && !capturing) written = null;
            capturing = state.active;
            port.onChange(state);
        },
    };
}
