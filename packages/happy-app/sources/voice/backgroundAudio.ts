import { AppState } from 'react-native';
import { isForeground } from './foreground';
import {
    addRemoteCommandListener,
    addSpeechInterruptionListener,
    holdAudioSession,
    speechInterruptionsHandled,
} from 'drover-speech';
import { isTransportCommand } from './headphonePress';

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
 */

/** What this needs of the reader, and nothing more. */
export interface BackgroundReader {
    readonly isEnabled: boolean;
    setBackgrounded(backgrounded: boolean): void;
    interrupt(reason: 'toggled-off'): void;
    /** An interruption ended, so an utterance the session refused may go now. */
    audioSessionRecovered(): void;
    /** Told when the reader stops, which is how the hold learns it is over. */
    addInterruptListener(listener: (reason: string) => void): () => void;
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
    const apply = () => {
        try {
            reader.setBackgrounded(backgrounded);
            // Only hold while there is something to stay alive FOR. Holding
            // with read-aloud off would keep music ducked for no one.
            const next = backgrounded && reader.isEnabled;
            if (next === held) return;
            held = next;
            void holdAudioSession(next);
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

    // Read-aloud going off in the background has to let the session go too,
    // or music stays ducked for nobody. `apply` re-reads `isEnabled`, so one
    // line covers the toggle, the route guard and a boss-mode call alike.
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
     * Lock-screen and AirPod play/pause (DROVE-189).
     *
     * Pause means stop talking and keep the place; the reader's own toggle is
     * the honest way to say that, because it is the same thing turning
     * read-aloud off does and there is then exactly one way to be silent.
     * Play is left to the app's own control rather than re-enabling here: a
     * squeeze that turned the voice back on for a session he had walked away
     * from would be a surprise, and the button is one tap away.
     */
    const remote = addRemoteCommandListener((command) => {
        // Only the TRANSPORT presses reach the reader (DROVE-225). Until this
        // guard, every command that was not `play` fell through to the toggle
        // below, so the double press that now opens the microphone would have
        // turned read-aloud off on its way there. The mic's own subscription
        // is in useVoiceComposer; the two read the same table and cannot
        // disagree about which press is whose.
        if (!isTransportCommand(command)) return;
        if (command === 'play') return;
        try {
            reader.interrupt('toggled-off');
        } catch {
            // A dead lock-screen button is better than a dead reader.
        }
    });

    return () => {
        started = false;
        held = null;
        appState.remove();
        enabledChanged();
        interruption.remove();
        remote.remove();
        void holdAudioSession(false);
    };
}
