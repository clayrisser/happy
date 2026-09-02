import type { AudioCueId } from './audioCues';
import { headphoneAction, type RemoteCommand } from './headphonePress';
import type { DictationSurface } from './dictationSurface';
import type { HeadlessDictationPort } from './headlessDictation';
import { HeadphoneMic } from './headphoneMic';

/**
 * The triple press, owned at MODULE SCOPE so it does not depend on a screen
 * (DROVE-302).
 *
 * headphonePress.ts decides that a triple press MEANS the microphone;
 * headphoneMic.ts decides what a press does to a mic that is open, closed or
 * refused. This decides WHO the mic dictates into, and it is the file that
 * makes the gesture work with the app in his pocket.
 *
 * ## The gap this closes
 *
 * DROVE-300 remapped the presses and lifted the double press out to module
 * scope, beside the single press, so both resolve identically foreground and
 * background. It deliberately left the mic where it was — inside
 * `useVoiceComposer`, which only `SessionView` mounts — and filed this ticket
 * rather than smuggling a second surface into a remap.
 *
 * The consequence was invisible from the inside. React native does not unmount
 * on background, so the microphone DOES work in his pocket while a session
 * screen happens to be mounted, which is what every hand test does. Background
 * the app from the session LIST, and a triple press reached no subscription at
 * all: nothing happened, and nothing said so. That is the exact failure
 * headphonePress.ts's own doctrine names — "a press with no sound is
 * indistinguishable from a press that did nothing" — arrived at structurally
 * instead of by a missing cue.
 *
 * ## The rule, and why the refusal did not move
 *
 * `micTarget` is the whole decision and it is a function of two values, so the
 * answer with the phone locked is the answer with it in his hand. There is no
 * react in it, no navigation, no AppState, nothing that could tell the
 * difference. That is the same trick nextSession.ts plays and for the same
 * reason: parity is cheapest when nothing in the path can ask.
 *
 * THE MIC FOLLOWS THE VOICE. The session being READ is the session he is
 * listening to, so it is the session a sentence dictated by ear belongs to.
 * With no screen mounted that is the only answer available, and it is also the
 * right one.
 *
 * DROVE-300'S REFUSAL IS KEPT BIT FOR BIT, and it is worth being clear that it
 * was not weakened on the way out of the hook. A double press moves the voice
 * to another session while the old screen stays mounted; the next triple press
 * then refuses AUDIBLY (`micRefused`) rather than putting words in a composer
 * he is not listening to and cannot see. That was a comment and a closure
 * inside `useVoiceComposer` with no test on it. It is now a line in a table
 * with five cases around it.
 *
 * It is stated as "a mounted screen that disagrees with the voice", not as
 * "the voice moved", because that is the situation the rule is actually about:
 * two answers to "which session is this press for" that do not match. When
 * nothing is mounted there is no disagreement to have, so the press lands on
 * the voice and dictates into its draft.
 */

/** Where the words go. */
export type MicSurfaceKind =
    /** A composer is on screen for that session and already owns a capture. */
    | 'composer'
    /**
     * Nothing is mounted, so the words go to the session's DRAFT, which the
     * composer hydrates from the moment he opens it. headlessDictation.ts.
     */
    | 'draft';

export type MicRefusal =
    /**
     * A session screen is up and it is NOT the session holding the voice
     * (DROVE-300). Refusing is the answer; dictating into either of them would
     * be a guess, and the wrong guess puts a sentence somewhere he will not
     * look.
     */
    | 'other-session'
    /**
     * Nothing holds the voice and nothing is mounted, so there is no session
     * to dictate into at all. Inventing one — the most recent, the first in
     * the list — is how words end up in a session he has not thought about in
     * a week.
     */
    | 'nowhere';

export type MicTarget =
    | { kind: 'dictate'; session: string; surface: MicSurfaceKind }
    | { kind: 'refuse'; why: MicRefusal };

/**
 * The whole decision, in one function.
 *
 * `holder` is `readAloud.readingSessionId` — the session the VOICE is on, not
 * the focused one (DROVE-297): a session he switched reading off on keeps its
 * focus for a moment and has already given the voice up, and the mic follows
 * the voice.
 *
 * `mounted` is the session of the composer that has announced itself through
 * dictationSurface.ts, or null when no session screen is up.
 */
export function micTarget(holder: string | null, mounted: string | null): MicTarget {
    // Two answers that disagree. DROVE-300's rule, unchanged.
    if (mounted !== null && holder !== null && mounted !== holder) {
        return { kind: 'refuse', why: 'other-session' };
    }
    if (holder !== null) {
        return { kind: 'dictate', session: holder, surface: mounted === holder ? 'composer' : 'draft' };
    }
    // Reading is off everywhere, but he is looking at a session: the on-screen
    // mic works, so the press must too. This is the ordinary foreground case
    // and it goes through the composer exactly as it always did.
    if (mounted !== null) return { kind: 'dictate', session: mounted, surface: 'composer' };
    return { kind: 'refuse', why: 'nowhere' };
}

/** What the press needs of the app, and nothing more. */
export interface MicPressDeps {
    /**
     * Whether the TRIPLE press reaches this binary at all.
     * `remoteTriplePressAvailable`, DROVE-300's `handlesTriplePress` stamp.
     * Build 15 and earlier disable `previousTrackCommand` outright, so the
     * event never arrives however long we listen and a live subscription would
     * only suggest otherwise.
     */
    available(): boolean;
    /** The session the voice is on. `readAloud.readingSessionId`. */
    holder(): string | null;
    /** The composer on screen, if any. dictationSurface.ts. */
    mounted(): DictationSurface | null;
    /** Tell me when that changes, so a screen can take a capture over. */
    onSurfaceChange(listener: () => void): () => void;
    /** Dictation with no screen behind it. headlessDictation.ts. */
    headless: HeadlessDictationPort;
    /**
     * The mic cannot open on this build at all: no speech module, or one too
     * old to report progress. `dictationCapability.dictationBlock`.
     */
    blocked(): boolean;
    /** Play one cue now, past the mixer. `audioCues.ack`. */
    ack(id: AudioCueId): void;
    /** How long that cue takes, so the mic opens after it rather than under it. */
    duration(id: AudioCueId): number;
    /** `setTimeout`, injected so the ordering has a spec and needs no clock. */
    delay(run: () => void, ms: number): () => void;
    /** The native press stream. `addRemoteCommandListener`. */
    subscribe(listener: (command: RemoteCommand) => void): { remove(): void };
}

/**
 * Wire the triple press to the microphone, wherever the microphone has to be.
 *
 * Its own subscription rather than a branch in nextSession.ts or
 * backgroundAudio.ts, for the reason headphonePress.ts exists: each press has
 * one owner and the table says which. The owner is `transport` and nothing
 * else yet — DROVE-73 has not shipped an audio menu — and when it does, this
 * subscription goes quiet on its own, because the table then says `menu-previous`
 * and not `mic`.
 */
export function startMicPress(deps: MicPressDeps): () => void {
    // Nothing to listen for on a binary that cannot send the press.
    if (!deps.available()) return () => { };

    const resolve = (): MicTarget => micTarget(deps.holder(), deps.mounted()?.session ?? null);

    const mic = new HeadphoneMic({
        // A capture is running wherever it is running. Either control stops
        // what either started, which is the promise that makes the gesture
        // learnable (DROVE-210).
        capturing: () => deps.headless.capturing() || (deps.mounted()?.capturing() ?? false),
        blocked: () => {
            // The recogniser is still settling the last stop: a press now would
            // open nothing and leave the cue claiming otherwise.
            if (deps.headless.settling()) return true;
            if (deps.blocked()) return true;
            return resolve().kind !== 'dictate';
        },
        ack: (id) => deps.ack(id),
        duration: (id) => deps.duration(id),
        delay: (run, ms) => deps.delay(run, ms),
        tap: () => {
            // A PRESS CLOSES WHAT A PRESS OPENED, whatever the target rule
            // would say now. The voice can move between the two presses — a
            // double press is one gesture away — and a close that re-asked the
            // rule would refuse and leave a hot microphone in his pocket that
            // no gesture can shut.
            //
            // AND THE CLOSING PRESS SENDS (DROVE-370). Clay: "triple tap
            // starts the mic, but triple tap should also end it, and when it
            // ends it should auto-submit." So the close is `commit`, not
            // `close`/`tap` — the same `onCommit(text, true, 'send')` a lift
            // on the composer's button makes. Both targets get the same verb,
            // because the gesture is the same gesture whether or not a screen
            // happens to be mounted, which is the parity this whole file
            // exists for. DROVE-105's on-screen rule is untouched: a second
            // TAP on the composer's own mic still stops and keeps the words,
            // and `surface.tap()` is still what that tap calls.
            if (deps.headless.capturing()) {
                deps.headless.commit();
                return;
            }
            const surface = deps.mounted();
            if (surface !== null && surface.capturing()) {
                surface.commit();
                return;
            }
            const target = resolve();
            if (target.kind !== 'dictate') return;
            if (target.surface === 'composer' && surface !== null) {
                // The same `onTalkTap` DROVE-210 gave the composer's primary
                // button, so this is not a second capture: a latch opened by
                // ear is stopped by the capsule's button and the other way
                // round.
                surface.tap();
                return;
            }
            deps.headless.open(target.session);
        },
    });

    const remote = deps.subscribe((command) => {
        if (headphoneAction(command, 'transport') !== 'mic') return;
        try {
            mic.press();
        } catch {
            // A dead microphone button is better than a dead reader. Same rule
            // backgroundAudio.ts applies to the lock screen's play/pause.
        }
    });

    // A SCREEN ARRIVING TAKES THE DICTATION OVER. Two captures on one
    // recogniser is a rejected `startDictation` and a microphone that looks
    // live over nothing, and the composer is about to offer its own. Closing
    // is not abandoning: the words commit to the draft the composer hydrates
    // from, so the sentence survives the handover.
    const unwatch = deps.onSurfaceChange(() => {
        if (deps.headless.capturing()) deps.headless.close();
    });

    return () => {
        remote.remove();
        unwatch();
        mic.dispose();
    };
}
