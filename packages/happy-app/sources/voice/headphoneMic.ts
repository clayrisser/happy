import type { AudioCueId } from './audioCues';

/**
 * The triple press, turned into the ONE capture (DROVE-225, moved off the
 * double press by DROVE-300).
 *
 * `headphonePress.ts` decides that a triple press means the microphone. This
 * decides what happens next, and it is short on purpose: everything about
 * what a capture IS lives in dictationCapture.ts, everything about what a
 * gesture is lives in micButton.ts, and this file adds a third door onto the
 * same room rather than building a second room.
 *
 * ## It is the same capture, not a second one
 *
 * DROVE-210 already had this problem and already solved it. The composer's
 * primary button is a plain `onPress` with no touch stream: it fires once, on
 * the lift, with no duration and no coordinates. So it feeds the SAME reducer
 * a press and a lift at the same instant, which is by definition a tap, which
 * latches the mic open, and a second one stops it. `useVoiceComposer.onTalkTap`
 * is that call.
 *
 * A headphone press is exactly that shape: one discrete event, no touch
 * stream, no duration. So it makes the same call. One capture, one banner,
 * one transcript, and either control stops what either started: the capsule's
 * TalkButton, the primary button and now the headphone, all three.
 *
 * ## Why the mic LATCHES rather than following the finger
 *
 * Because there is no finger. Push-to-talk in the walkie-talkie sense needs a
 * press-and-hold, and headphones do not deliver one: see the measurement at
 * the top of headphonePress.ts. Press to open, press again to close is the
 * only shape the hardware can carry, and it is the shape the on-screen latch
 * already has, so nothing new has to be learnt.
 *
 * The consequence is worth saying out loud: A HEADPHONE PRESS NEVER SENDS.
 * Only a lift sends (DROVE-105) and there is no lift, so the words land in
 * the composer and stay there. That is deliberate rather than unfinished. The
 * words are the one thing he cannot check with the phone in his pocket, and a
 * mis-press that sent half a sentence to an agent is not recoverable by
 * pressing anything. Sending by ear needs its own gesture and its own
 * confirmation, and it is not this ticket.
 *
 * ## Every press makes a sound, and the open one makes it FIRST
 *
 * Eyes-free means a press with no sound is indistinguishable from a press
 * that did nothing, so all three outcomes are audible: opened, closed,
 * refused (DROVE-174's vocabulary, three new rows in the cue table).
 *
 * The open cue plays BEFORE the microphone opens, and the mic waits for it.
 * Two reasons, and the second is the one that matters:
 *
 *   - A tone played into a live recogniser is a tone in the recording.
 *     `claimSessionForDictation` puts the session in `.playAndRecord` with
 *     `.defaultToSpeaker`, so a cue during a capture goes out of the same
 *     route the microphone is listening to.
 *   - The cue IS the go signal. He presses, hears it, then talks. Waiting a
 *     quarter of a second for the sound that tells him to start costs nothing,
 *     because he was not talking yet. That is the whole difference between a
 *     latch and a hold.
 *
 * The close and the refusal fire immediately and nothing waits on them. A
 * stop takes up to a couple of seconds to settle the recogniser, and an
 * acknowledgement that arrives two seconds after the press is not an
 * acknowledgement. A 200ms sine at the tail of a recording is not speech and
 * transcribes to nothing.
 */

/**
 * The gap between the open cue finishing and the microphone opening.
 *
 * Small: it is there so the last sample of the tone is out of the speaker
 * before the session flips category, not to leave a pause. The whole wait is
 * this plus the cue's own length, about a quarter of a second.
 */
export const MIC_ACK_LEAD_MS = 60;

export interface HeadphoneMicDeps {
    /** A capture is running right now. The same state the banner draws from. */
    capturing(): boolean;
    /**
     * The mic cannot open: no speech module, a build too old to report, or
     * the recogniser still settling the last stop. The same question the
     * on-screen button asks before it goes red.
     */
    blocked(): boolean;
    /** Play one cue now, past the mixer. `audioCues.ack`. */
    ack(id: AudioCueId): void;
    /** How long that cue takes, so the mic opens after it rather than under it. */
    duration(id: AudioCueId): number;
    /** The one capture. `useVoiceComposer.onTalkTap`. */
    tap(): void;
    /** `setTimeout`, injected so the ordering has a spec and needs no clock. */
    delay(run: () => void, ms: number): () => void;
}

export class HeadphoneMic {
    private readonly deps: HeadphoneMicDeps;
    /** Cancels the pending open, or null when none is pending. */
    private opening: (() => void) | null = null;

    constructor(deps: HeadphoneMicDeps) {
        this.deps = deps;
    }

    /** For the tests and for the banner: is an open waiting on its cue? */
    get isOpening(): boolean {
        return this.opening !== null;
    }

    /** A press that means the microphone arrived. A triple, since DROVE-300. */
    press(): void {
        // A press while the open is still waiting on its cue. `capturing()` is
        // not true yet, so without this the press would ack and schedule a
        // SECOND open. Cancelling instead keeps the promise that made the
        // gesture learnable: a press stops whatever a press started, with no
        // quarter-second window where that is not so.
        if (this.opening !== null) {
            this.cancelOpen();
            this.deps.ack('micClosed');
            return;
        }
        if (this.deps.capturing()) {
            // The cue and the stop go together. The stop is the slow half,
            // because the recogniser takes its time settling, and an
            // acknowledgement that waits for it is one he has stopped
            // believing in.
            this.deps.ack('micClosed');
            this.deps.tap();
            return;
        }
        if (this.deps.blocked()) {
            // The one sound that exists so "it did nothing" is not silent.
            this.deps.ack('micRefused');
            return;
        }
        this.deps.ack('micOpen');
        this.opening = this.deps.delay(() => {
            this.opening = null;
            this.deps.tap();
        }, this.deps.duration('micOpen') + MIC_ACK_LEAD_MS);
    }

    /**
     * The screen went away, or dictation stopped being offered, with an open
     * still pending. Nothing is left to fire into a hook that has unmounted.
     */
    dispose(): void {
        this.cancelOpen();
    }

    private cancelOpen(): void {
        const cancel = this.opening;
        this.opening = null;
        if (cancel !== null) cancel();
    }
}
