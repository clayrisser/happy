import { AppState } from 'react-native';
import { isForeground } from './foreground';
import {
    addRemoteCommandListener,
    addSpeechInterruptionListener,
    holdAudioSession,
    setReadingState,
} from 'drover-speech';
import {
    isDuplicateRemotePress,
    readAloudTransport,
    remoteTransportEffect,
    remoteTransportGesture,
    type RemotePress,
} from './readAloudTransport';

/**
 * Read-aloud keeps talking with the phone in a pocket (DROVE-189).
 *
 * Clay: "shouldn't it keep reading even when the app isn't in the foreground".
 *
 * WHAT WAS ACTUALLY WRONG, because it is not what the ticket guessed.
 * `ios.infoPlist.UIBackgroundModes: ["audio"]` has been in app.config.js since
 * DROVE-30 shipped, so the entitlement is already on his phone and this needed
 * no new build to start working. The bug was one line further down: the reader
 * releases the audio session whenever the queue drains, so ducked music comes
 * back up. That is right in the foreground and fatal behind the lock screen —
 * an app with the audio background mode stays alive only while its session is
 * ACTIVE, so a drained queue let iOS suspend the process, and the next reply
 * arrived at an app that was not running. Nothing announced it; the phone just
 * went quiet and stayed quiet until he opened the app.
 *
 * So the whole JS fix is: while read-aloud is on and the app is in the
 * background, do not hand the session back. `reader.setBackgrounded` does it,
 * and it ships over the air.
 *
 * `holdAudioSession` is the belt under that, and it is the half that needs a
 * build. On a binary that has it, `stop` keeps the session too, so a stop from
 * anywhere — a route change, a focus move — cannot drop it while he is
 * listening in his pocket. On build 12 and earlier the call is a no-op and the
 * JS half stands alone, which is enough for the common case.
 *
 * DOES IT READ FOREVER? No, and it does not need to. It reads while there is
 * material and rests when the queue drains, holding the session so the app
 * stays alive to hear the next reply. Coming back to the foreground releases
 * it at the first idle moment, and turning read-aloud off releases it at once.
 * Battery is real, and an app holding a `.playback` session with nothing
 * playing costs very little next to one being woken to re-sync every reply.
 *
 * INTERRUPTIONS are handled in DroverSpeechModule — they were not handled at
 * all before this ticket, which is why a phone call left the reader dead. What
 * arrives here is the news of it, and the reader is TOLD: an interruption
 * ending is the exact moment a refused utterance will be taken, so it does not
 * have to wait out its own retry timer.
 *
 * THE SECOND PASS (DROVE-189 again, because Clay reported it a third time).
 * Everything above keeps the app ALIVE, and a live app was still going quiet,
 * because staying alive was necessary and not sufficient. The half that was
 * missing is in readAloud.ts: `speak` REJECTS when the audio session refuses
 * it, which is what an unfinished interruption looks like from JS, and the
 * reader used to swallow that and pump the next sentence, so a refusing
 * session consumed the whole reply in a tight loop and marked every sentence
 * spoken. He came back to an app that was running, connected and silent, with
 * nothing left to read. `isStalled` and `audioSessionRecovered` are that fix's
 * two ends, and this file is one of the things that calls the second one.
 *
 * ## The card is not the session (DROVE-233)
 *
 * Two things were welded to `holdSession` and only one of them belongs to it.
 *
 *   THE SESSION keeps the app alive. It is held whenever read-aloud is on, the
 *   foreground included (DROVE-233 nowplaying-card): the native keepalive is
 *   the app's only audio producer, and without it running in the foreground
 *   iOS draws no lock-screen card there. It no longer costs ducked music —
 *   read-aloud is PRIMARY audio now, not a ducking session — so there is
 *   nothing to save by dropping it in the foreground. Pauses hold too: a pause
 *   that released it would let iOS suspend the app, and a suspended app cannot
 *   be resumed from the lock screen.
 *
 *   THE NOW-PLAYING CARD is what carries the lock screen's play/pause. It
 *   activates nothing and ducks nothing, so tying its life to the session's
 *   was a cost saved that was never being paid. It meant read-aloud on with
 *   nothing being said produced no card at all, which is the empty lock screen
 *   Clay photographed on build 14: no title, no transport, nothing. It now
 *   lives for as long as read-aloud is on, and `setReadingState` says so.
 *
 * That split needs a build (15). On build 14 `setReadingState` is a no-op and
 * the card still comes and goes with the hold, so the pause below works from
 * the app and from the headphones and the lock screen keeps the gap.
 */

/** What this needs of the reader, and nothing more. */
export interface BackgroundReader {
    readonly isEnabled: boolean;
    /** He paused it and it is holding its place (DROVE-233). */
    readonly isPaused: boolean;
    setBackgrounded(backgrounded: boolean): void;
    /** Pause or resume. The one state all three surfaces drive (DROVE-233). */
    setPaused(paused: boolean): void;
    /** An interruption ended, so an utterance the session refused may go now. */
    audioSessionRecovered(): void;
    /** Told when the reader stops, which is how the hold learns it is over. */
    addInterruptListener(listener: (reason: string) => void): () => void;
    /** Told when on/paused/off changes, which is how the card learns. */
    addTransportListener(listener: () => void): () => void;
}

/*
 * `lockScreenControlsAvailable()` used to sit here (DROVE-301 removed it).
 *
 * It answered "can the lock screen pause and resume on this binary", so that a
 * settings row could say so instead of drawing a control that did nothing on
 * build 12. The row was never written and nothing ever imported it, so what it
 * actually provided was false comfort: a capability probe nobody reads cannot
 * make anything safe. Build 12 is also long behind the floor — DROVE-233's
 * `.duckOthers` drop needs 19 — so there is no longer a build for it to warn
 * about. `speechInterruptionsHandled` is still exported from drover-speech if a
 * row ever wants it.
 */

let started = false;

export { isForeground } from './foreground';

export function startBackgroundAudio(reader: BackgroundReader): () => void {
    if (started) return () => { };
    started = true;

    let backgrounded = !isForeground(AppState.currentState);
    // What was last asked of the native side. `apply` runs on every interrupt
    // as well as every app-state change, and an interrupt is as common as a
    // keystroke, so the call across the bridge is made only when the answer
    // actually changes.
    let held: boolean | null = null;
    // The last state the lock screen was told, for the same reason `held` is
    // kept: this runs on every interrupt and every pause, and a bridge call
    // per keystroke is worth avoiding.
    let published: string | null = null;
    /**
     * WHEN the reader became paused, by whichever surface paused it
     * (DROVE-370).
     *
     * A headset with one word for its one button sends `pause` to resume,
     * because it has nothing else to send, and this is what tells that press
     * apart from the same unit re-asserting `pause` a few milliseconds after
     * our DROVE-362 republish. It is set from `apply`, which the reader's
     * transport listener already drives, so a pause taken on the ON-SCREEN
     * speaker starts the same clock as one taken in his pocket — pressing the
     * headphone a second later then resumes, whichever surface did the pause.
     *
     * Only the transition sets it. `apply` also runs on every interrupt and
     * every app-state change, and re-stamping it there would make the second
     * press unreachable on a phone that so much as changed audio route.
     */
    let pausedSince: number | null = null;
    const notePaused = () => {
        if (readAloudTransport(reader.isEnabled, reader.isPaused) !== 'paused') {
            pausedSince = null;
            return;
        }
        if (pausedSince === null) pausedSince = Date.now();
    };
    /**
     * Say what the reader is doing, and MEAN it (DROVE-362).
     *
     * `force` is the whole of this ticket. Publishing only on a change makes
     * the JS state the source of truth for WHEN we speak as well as for WHAT
     * we say, and those are different questions. The moment an outside surface
     * — the lock screen, an AirPod, a car's head unit — has drifted out of
     * step with us, a change-only publish can never put it back, because by
     * construction we only ever speak when WE change.
     *
     * That is exactly how a pause got stuck. The DROVE-259 keepalive is still
     * looping through a pause on purpose, so an AVRCP unit sees an app
     * producing audio, keeps its PAUSE glyph up and sends `pause` again. The
     * table answers `nothing`, correctly — and the dedupe then swallowed the
     * re-assert too, so the unit stayed wrong for good and every later press
     * was another dead `pause`. From the driver's seat: "it pauses again
     * instead of unpausing".
     *
     * So a press that resolves to `nothing` is not a press to ignore. It is
     * PROOF that a surface disagrees with the reader, and the answer to a
     * disagreement is to say the state again. Native's `setReadingState` is
     * idempotent and republishes both the now-playing dictionary and
     * `playbackState` on every call, so one forced call is the whole
     * correction — no Swift, no build.
     */
    const publishTransport = (force: boolean) => {
        const state = readAloudTransport(reader.isEnabled, reader.isPaused);
        if (!force && state === published) return;
        published = state;
        void setReadingState(state === 'off' ? 'off' : state === 'paused' ? 'paused' : 'reading');
    };
    const apply = () => {
        try {
            notePaused();
            reader.setBackgrounded(backgrounded);
            // Hold whenever read-aloud is ON, foreground included (DROVE-233
            // nowplaying-card). It used to be `backgrounded && isEnabled`,
            // because the hold cost ducked music and only the background needed
            // to keep the app alive. Two things changed that. The session is no
            // longer a ducking session — read-aloud is PRIMARY audio now (the
            // Swift `.duckOthers` drop), so holding no longer dips anyone's
            // music. And the DROVE-259 keepalive is gated `guard sessionHeld`
            // in native, so with read-aloud on in the FOREGROUND and no sentence
            // in flight there was NO producer at all and iOS drew no card. That
            // is the H2a half of the missing lock-screen card. Holding while
            // enabled keeps a producer alive so the card exists in the
            // foreground too, and the app can be woken from the lock screen.
            //
            // A PAUSE STILL HOLDS (DROVE-233): `isEnabled` is true while paused,
            // on purpose. The session is what keeps the app from being
            // suspended, and an app iOS has suspended cannot be resumed from the
            // lock screen. Releasing it on a pause would make the pause one-way,
            // which is the whole feature gone.
            const next = reader.isEnabled;
            if (next !== held) {
                held = next;
                void holdAudioSession(next);
            }
            // The CARD, which is a different question from the session
            // (DROVE-233). It exists for as long as read-aloud is on, in the
            // foreground too, so there is always a play/pause to press. On
            // build 14 and earlier this is a no-op and the hold above is still
            // the only thing that puts a card up.
            publishTransport(false);
        } catch {
            // Nothing about staying alive is worth taking the reader down for.
        }
    };
    apply();

    const appState = AppState.addEventListener('change', (state) => {
        const next = !isForeground(state);
        if (next === backgrounded) return;
        backgrounded = next;
        apply();
    });

    // Read-aloud going off has to let the session go, or a producer stays alive
    // for nobody. `apply` re-reads `isEnabled`, so one line covers the toggle,
    // the route guard and a boss-mode call alike.
    const enabledChanged = reader.addInterruptListener(() => { apply(); });

    // The native side has already paused and resumed the utterance. What the
    // reader needs from this is the END: an interruption ending is the moment
    // a refused utterance will be accepted, so it is offered again at once
    // rather than after the retry timer.
    const interruption = addSpeechInterruptionListener((state) => {
        if (state !== 'ended') return;
        try {
            reader.audioSessionRecovered();
        } catch {
            // The retry timer is the belt under this.
        }
    });

    /**
     * Lock-screen and AirPod play/pause (DROVE-189, rewritten by DROVE-233).
     *
     * WHAT THIS USED TO DO, because it is the bug rather than a simplification
     * of it: `pause` called `interrupt('toggled-off')`. That is not a pause, it
     * is the off switch — `interrupt` moves the cursor to the end of the
     * timeline, drops the tails, the gate lines and the detour. A squeeze in
     * his pocket therefore ended the reading, and pressing again started at
     * the newest content because DROVE-226 says a start does. There was
     * nowhere for a held place to live, so the honest thing was to say pause
     * and off were the same. They are not, and now they are not.
     *
     * `play` still never turns read-aloud ON, which is DROVE-189's rule kept
     * verbatim: "a squeeze that turned the voice back on for a session he had
     * walked away from would be a surprise, and the button is one tap away".
     * All that changed is that there is now a pause for it to come back from.
     * `transportEffect` is where that lives, beside the button's own gestures,
     * so the three surfaces cannot come to disagree.
     *
     * Only the TRANSPORT presses reach the reader's play/pause (DROVE-225,
     * DROVE-300). A triple press is the microphone and has its own
     * subscription in useVoiceComposer; a double press is the next
     * reading-enabled session and has its own in readAloudService, beside the
     * call that starts this one. `remoteTransportGesture` returning null is
     * what keeps this file about the transport and nothing else.
     */
    let lastRemote: RemotePress | null = null;
    const remote = addRemoteCommandListener((command) => {
        const gesture = remoteTransportGesture(command);
        if (gesture === null) return;
        const at = Date.now();
        // One press of one button on a head unit can arrive as two identical
        // commands (DROVE-362). Taken at face value that is pause-then-resume
        // in a single press, which reads as the transport ignoring him.
        if (isDuplicateRemotePress(command, lastRemote, at)) {
            lastRemote = { command, at };
            return;
        }
        lastRemote = { command, at };
        try {
            const before = readAloudTransport(reader.isEnabled, reader.isPaused);
            // `remoteTransportEffect` is `transportEffect` with the one extra
            // cell a remote press needs (DROVE-370): a `pause` that lands on a
            // reader that has BEEN paused for more than a second is him
            // pressing the one button his headset has, not that headset
            // echoing our own republish, and it resumes. Every other cell is
            // the DROVE-327 table verbatim.
            const effect = remoteTransportEffect(gesture, before, pausedSince, at);
            if (effect === 'pause') reader.setPaused(true);
            else if (effect === 'resume') reader.setPaused(false);
            // 'turn-on', 'turn-off' and 'nothing' are unreachable from a remote
            // press by the table above, and doing nothing is the right answer
            // to all three from a pocket.
            //
            // DOING NOTHING TO THE READER IS NOT DOING NOTHING (DROVE-362). A
            // remote `pause` that lands on an already-paused reader, or a
            // remote `play` on one already reading, is a surface telling us it
            // disagrees with us — an AVRCP unit that still believes we are
            // playing can only ever send `pause`, so without this the pause
            // was one-way and he could never press his way out of it. Every
            // remote press therefore re-asserts the state, whether or not the
            // reader moved, so the glyph on the lock screen and in the car
            // matches the reader after each step and the NEXT press is the
            // right command.
            //
            // Only when the reader did NOT move, because a press that moved it
            // has already published through `addTransportListener` below and a
            // second identical call across the bridge buys nothing.
            if (readAloudTransport(reader.isEnabled, reader.isPaused) === before) publishTransport(true);
        } catch {
            // A dead lock-screen button is better than a dead reader.
        }
    });

    // The card and the hold both read the reader's state, and a pause changes
    // it without interrupting anything, so it needs its own subscription
    // (DROVE-233). This is also what makes turning read-aloud ON publish a
    // card: `addInterruptListener` fires when it goes off and never when it
    // comes on, which is why a freshly-enabled reader put nothing on the lock
    // screen until something happened to be said.
    const transportChanged = reader.addTransportListener(() => { apply(); });

    return () => {
        started = false;
        held = null;
        published = null;
        pausedSince = null;
        lastRemote = null;
        appState.remove();
        enabledChanged();
        transportChanged();
        interruption.remove();
        remote.remove();
        void holdAudioSession(false);
        void setReadingState('off');
    };
}
