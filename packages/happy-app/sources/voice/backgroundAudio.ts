import { AppState } from 'react-native';
import { isForeground } from './foreground';
import {
    addRemoteCommandListener,
    addSpeechInterruptionListener,
    holdAudioSession,
    setReadingState,
    speechInterruptionsHandled,
} from 'drover-speech';
import { readAloudTransport, remoteTransportGesture, transportEffect } from './readAloudTransport';

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

/**
 * Whether the lock screen can pause and resume, on this binary.
 *
 * Exposed so a settings row can say so rather than showing a control that
 * does nothing on build 12.
 */
export function lockScreenControlsAvailable(): boolean {
    return speechInterruptionsHandled();
}

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
    const apply = () => {
        try {
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
            const state = readAloudTransport(reader.isEnabled, reader.isPaused);
            if (state !== published) {
                published = state;
                void setReadingState(state === 'off' ? 'off' : state === 'paused' ? 'paused' : 'reading');
            }
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
    const remote = addRemoteCommandListener((command) => {
        const gesture = remoteTransportGesture(command);
        if (gesture === null) return;
        try {
            const effect = transportEffect(gesture, readAloudTransport(reader.isEnabled, reader.isPaused));
            if (effect === 'pause') reader.setPaused(true);
            else if (effect === 'resume') reader.setPaused(false);
            // 'turn-on', 'turn-off' and 'nothing' are unreachable from a remote
            // press by the table above, and doing nothing is the right answer
            // to all three from a pocket.
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
        appState.remove();
        enabledChanged();
        transportChanged();
        interruption.remove();
        remote.remove();
        void holdAudioSession(false);
        void setReadingState('off');
    };
}
