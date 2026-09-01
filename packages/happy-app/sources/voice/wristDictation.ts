import { keptTranscript } from './dictationCapture';

/**
 * The phone's half of the wrist's held-open recorder (DROVE-130).
 *
 * Clay asked why a single press on the watch could not open the recorder and
 * HOLD IT OPEN, so he can talk, pause, think and keep talking. watchOS's own
 * input sheet takes one utterance and closes, and the watch cannot run a
 * recogniser to replace it — `Speech.framework` is absent from the watchOS SDK
 * entirely. So the watch captures and this phone transcribes.
 *
 * WHAT THIS FILE OWNS is the small amount of POLICY in that loop: which
 * capture is open, what gets sent back to the wrist, and what a stop does with
 * the words. The audio never comes near it — PCM goes straight from the watch
 * bridge to the speech module inside the native process, five times a second,
 * because JS has no use for samples. What is here is what benefits from
 * shipping OTA.
 *
 * THE INVARIANT IT CARRIES, which is the whole reason it is a class with tests
 * and not four lines inside a listener. DROVE-263: with
 * `requiresOnDeviceRecognition = true` the recogniser does NOT finalise on a
 * pause. It keeps ONE task alive and opens a new RESULT SEQUENCE, reporting
 * the next utterance FROM EMPTY. Code that assigned the incoming result over
 * the held text destroyed everything said before the pause, and Clay reported
 * that three times.
 *
 * That fix lives in `DroverSpeechModule.absorb()`, and because the phone does
 * the recognising here too, the wrist INHERITS it rather than copying it —
 * there is no second recogniser to drift. What is left for this file is the
 * one place the same shape could come back on the way OUT: an empty partial
 * must never be forwarded to the wrist, and the partials must carry an order
 * the wrist can trust, because `sendMessage` promises none and the wrist
 * cannot tell a stale duplicate from a legitimate revision by reading the
 * words. A revision is frequently SHORTER and correct ("um hello" -> "hello"),
 * so "never shrink" would be the wrong guard; ordering is what the wire
 * actually breaks, so ordering is what is carried.
 */

/** What starts and stops the recogniser. The native speech module, in practice. */
export interface WristDictationEngine {
    /** Begin recognising audio the watch is streaming for `capture`. */
    start(capture: string): Promise<unknown>;
    /** Stop and resolve with the final transcript. */
    stop(): Promise<string>;
    /** Throw the capture away without transcribing. */
    cancel(): Promise<unknown> | void;
}

export interface WristDictationEvents {
    /**
     * Send the transcript so far to the wrist. `seq` is monotonic within a
     * capture; `final` marks the last one.
     */
    heard(capture: string, seq: number, text: string, final: boolean): void;
    /**
     * Something went wrong. Reporting ONLY — the wrist has already been told
     * the capture is over by a final `heard`, because there is exactly one
     * place that closes a capture and it is `heard(..., final: true)`. An
     * error that also closed would be a second closer, and the two would race
     * to be last: the first version of this sent an empty final AFTER the real
     * one and blanked the words it had just delivered.
     */
    error(capture: string, message: string): void;
}

export class WristDictation {
    private readonly engine: WristDictationEngine;
    private readonly events: WristDictationEvents;
    /** The capture being recognised, or null when the recorder is shut. */
    private capture: string | null = null;
    /** The next partial's number, within this capture. */
    private seq = 0;
    /** The last text sent to the wrist, so an unchanged partial costs nothing. */
    private sent = '';

    constructor(engine: WristDictationEngine, events: WristDictationEvents) {
        this.engine = engine;
        this.events = events;
    }

    /** Which capture is open, for tests and for the feed's own guards. */
    get openCapture(): string | null {
        return this.capture;
    }

    /**
     * The wrist opened its recorder. A second start while one is already open
     * is the wrist and the phone disagreeing about state; the newer press
     * wins, because it is the one Clay just made.
     */
    open(capture: string): void {
        if (this.capture === capture) return;
        if (this.capture !== null) void Promise.resolve(this.engine.cancel()).catch(() => {});
        this.capture = capture;
        this.seq = 0;
        this.sent = '';
        void Promise.resolve()
            .then(() => this.engine.start(capture))
            .catch((error) => {
                if (this.capture !== capture) return;
                this.capture = null;
                // The recogniser never started, so no final can come from it.
                // Close the wrist here or it records into nothing.
                this.events.heard(capture, this.seq++, '', true);
                this.events.error(capture, error instanceof Error ? error.message : String(error));
            });
    }

    /**
     * A partial from the recogniser. `text` is EVERYTHING heard since the
     * recorder opened — the native contract — so it is forwarded, never
     * appended to itself.
     */
    partial(text: string): void {
        const capture = this.capture;
        if (capture === null) return;
        // AN EMPTY PARTIAL NEVER TAKES WORDS BACK (DROVE-263). It is how the
        // on-device recogniser opens a new sequence after a pause, and it is
        // not a report that nothing was said. The Swift `absorb()` drops it
        // and so does the wrist's `WristHearing`; all three have to agree or
        // the one that does not is the bug.
        if (text.trim().length === 0) return;
        if (text === this.sent) return;
        this.sent = text;
        this.events.heard(capture, this.seq++, text, false);
    }

    /**
     * The wrist pressed stop. The words are kept and delivered as the final
     * partial; NOTHING IS SENT to the session here. The wrist banks them into
     * its draft and Clay sends deliberately, which is the phone's rule that
     * only a lift sends — and a wrist has no lift.
     */
    close(capture: string): void {
        // A stop for a capture that is not the open one: a straggler from a
        // press already dealt with. Structural, not guessed from content.
        if (this.capture !== capture) return;
        this.capture = null;
        const last = this.sent;
        void Promise.resolve()
            .then(() => this.engine.stop())
            .then((text) => {
                // A final that says LESS than what the wrist is already
                // showing does not mean the words were never said: the module
                // clears its transcript when the recogniser finalises on its
                // own, so a stop landing afterwards resolves with "". Same
                // rule, same function, as the phone's own capture.
                this.events.heard(capture, this.seq++, keptTranscript(last, text), true);
            })
            .catch((error) => {
                // The stop failed, so the wrist keeps whatever it had rather
                // than being blanked, and is told why it is no longer live.
                this.events.heard(capture, this.seq++, last, true);
                this.events.error(capture, error instanceof Error ? error.message : String(error));
            });
    }

    /** The wrist discarded the capture. The audio goes nowhere. */
    discard(capture: string): void {
        if (this.capture !== capture) return;
        this.capture = null;
        this.sent = '';
        void Promise.resolve(this.engine.cancel()).catch(() => {});
    }

    /**
     * The recogniser ended on its own — it gave up, or hit its own limit.
     * `reason` is the native module's word for why.
     *
     * A latched recorder must never sit there looking live over a dead task
     * (DROVE-30), so the wrist is told the capture is over, WITH every word
     * kept. The words are not the casualty of the recogniser stopping.
     */
    ended(text: string, reason?: string): void {
        const capture = this.capture;
        if (capture === null) return;
        this.capture = null;
        const kept = keptTranscript(this.sent, text);
        this.events.heard(capture, this.seq++, kept, true);
        if (reason && reason !== 'final') this.events.error(capture, reason);
    }
}
