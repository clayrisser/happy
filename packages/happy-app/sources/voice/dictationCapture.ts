import type { ReadAloudInterruption } from './readAloud';
import { DICTATION_LATCH_IDLE_MS, type MicMode } from './micMode';

/**
 * The composer's mic, as a state machine with no React and no device in it
 * (DROVE-30, DROVE-74).
 *
 * Both ergonomics run through here, hold-to-talk and the latch, so the rules
 * that keep a latched mic from being a hot mic (the idle stop, the
 * interrupts, what a timeout is allowed to do with the words it heard) are
 * decided in one place and tested in one place. The gesture that picks
 * between them is micButton.ts; useVoiceComposer wires the two together and
 * the native events to this.
 *
 * One rule above all: ONLY A LIFT SENDS (DROVE-105). Lifting a held button
 * with the finger still on it is the one gesture that sends. Tapping a latch
 * off STOPS and leaves the words in the composer to be read. Sliding off the
 * button before the lift CANCELS and puts the composer back. Everything that
 * is not a gesture at all, the idle stop, a speech cut, the recogniser
 * ending on its own, leaves the transcript in the composer, unsent.
 */
export interface DictationEngine {
    /** Resolves once the microphone is running. */
    start(): Promise<unknown>;
    /** Resolves with the final transcript. */
    stop(): Promise<string>;
    /** Throw the audio away without transcribing. */
    cancel(): Promise<unknown> | void;
}

export interface DictationCaptureState {
    active: boolean;
    mode: MicMode | null;
    /** When capture started, for the elapsed-time readout. */
    since: number | null;
    /** The live partial transcript, for the indicator and the composer. */
    transcript: string;
    /** When a latch will stop itself; null under hold and once ended. */
    idleAt: number | null;
    /**
     * The mic is off but the final transcript has not landed yet. The native
     * recogniser refuses a start while it is still settling the last stop,
     * so a begin() in this window is dropped rather than shown as a failure.
     */
    settling: boolean;
}

/** Why a capture ended. Carried to the commit so the composer knows what to do. */
export type DictationEndReason =
    /** The lift of a held button, finger still on it. The only reason that sends. */
    | 'send'
    /** The tap that ends a latch. Words kept, nothing sent. */
    | 'stop'
    /** The finger slid off the button before lifting. Words thrown away. */
    | 'cancel'
    | 'idle'
    | 'recogniser'
    | ReadAloudInterruption;

export interface DictationCaptureEvents {
    /**
     * The words are final. `send` is true only when a gesture asked for them
     * to go; false means "put them in the composer and stop".
     */
    onCommit(text: string, send: boolean, reason: DictationEndReason): void;
    /** A partial transcript landed or was revised. */
    onPartial(text: string): void;
    /** The capture ended with its words thrown away. */
    onDiscard(reason: DictationEndReason): void;
    onError(message: string): void;
    onChange(state: DictationCaptureState): void;
}

const idle: DictationCaptureState = {
    active: false,
    mode: null,
    since: null,
    transcript: '',
    idleAt: null,
    settling: false,
};

const settling: DictationCaptureState = { ...idle, settling: true };

export class DictationCapture {
    private readonly engine: DictationEngine;
    private readonly events: DictationCaptureEvents;
    private readonly now: () => number;
    private state: DictationCaptureState = idle;
    /**
     * Bumped whenever a capture ends. A stop that resolves under an old
     * generation belongs to a capture that was since cancelled, and must not
     * commit words into whatever the user has moved on to.
     */
    private generation = 0;

    constructor(engine: DictationEngine, events: DictationCaptureEvents, now: () => number = () => Date.now()) {
        this.engine = engine;
        this.events = events;
        this.now = now;
    }

    get current(): DictationCaptureState {
        return this.state;
    }

    /** Start listening. Under `latch` the idle clock starts with it. */
    begin(mode: MicMode): void {
        if (this.state.active || this.state.settling) return;
        const started = this.now();
        const generation = this.generation;
        this.set({
            active: true,
            mode,
            since: started,
            transcript: '',
            idleAt: mode === 'latch' ? started + DICTATION_LATCH_IDLE_MS : null,
            settling: false,
        });
        void Promise.resolve()
            .then(() => this.engine.start())
            .catch((error) => {
                if (generation !== this.generation) return;
                this.generation += 1;
                this.set(idle);
                this.events.onError(error instanceof Error ? error.message : String(error));
            });
    }

    /**
     * The finger lifted inside the tap window: what began as a hold stays
     * open as a latch, and the idle clock starts now (DROVE-74).
     */
    latch(): void {
        if (!this.state.active || this.state.mode === 'latch') return;
        this.set({ ...this.state, mode: 'latch', idleAt: this.now() + DICTATION_LATCH_IDLE_MS });
    }

    /** The finger lifted on the button after a hold. Transcribe and send. */
    send(): void {
        if (!this.state.active) return;
        this.finish('send', true);
    }

    /**
     * The tap that ends a latch. Transcribe and put the words in the
     * composer, send nothing: he reads them and presses send himself
     * (DROVE-105).
     */
    stop(): void {
        if (!this.state.active) return;
        this.finish('stop', false);
    }

    /** The finger slid off the button and lifted there. Throw it away. */
    cancel(): void {
        this.discard('cancel');
    }

    /** A partial transcript landed. Under a latch a CHANGE is what "not idle" means. */
    partial(text: string): void {
        if (!this.state.active) return;
        const changed = text !== this.state.transcript;
        this.set({
            ...this.state,
            transcript: text,
            idleAt: changed && this.state.mode === 'latch'
                ? this.now() + DICTATION_LATCH_IDLE_MS
                : this.state.idleAt,
        });
        if (changed) this.events.onPartial(text);
    }

    /**
     * The clock. Called by whoever owns a timer; nothing here schedules one.
     * A latch past its idle deadline stops and keeps its words, unsent.
     */
    tick(now: number = this.now()): void {
        if (!this.state.active || this.state.idleAt === null) return;
        if (now < this.state.idleAt) return;
        this.finish('idle', false);
    }

    /**
     * Speech was cut, so capture is cut too (DROVE-30 AC: anything that stops
     * speech also stops capture). Typing keeps what was heard, because the
     * user is now editing and losing three dictated sentences to a tap on
     * the text field is the wrong trade; every other reason drops it.
     */
    interrupt(reason: ReadAloudInterruption): void {
        if (!this.state.active) return;
        if (reason === 'typed') {
            this.finish(reason, false);
            return;
        }
        this.discard(reason);
    }

    /**
     * The recogniser ended on its own: Apple finalises after a long silence,
     * or gives up with "no speech detected", while the mic still looked
     * live. Honest is to end now, in either ergonomic, with the words kept
     * and unsent. Under hold the lift that follows finds nothing to do.
     */
    recogniserEnded(text: string): void {
        if (!this.state.active) return;
        const heard = this.state.transcript.trim();
        this.generation += 1;
        void this.engine.cancel();
        this.set(idle);
        // Same reasoning as finish(): the recogniser giving up with nothing
        // must not erase the partials it already reported (DROVE-105).
        const trimmed = text.trim() || heard;
        if (trimmed.length > 0) {
            this.events.onCommit(trimmed, false, 'recogniser');
        } else {
            this.events.onDiscard('recogniser');
        }
    }

    /** The screen went away with the mic on. Nothing is left recording. */
    discard(reason: DictationEndReason = 'left-session'): void {
        if (!this.state.active && !this.state.settling) return;
        const wasActive = this.state.active;
        this.generation += 1;
        this.set(idle);
        void this.engine.cancel();
        if (wasActive) this.events.onDiscard(reason);
    }

    private finish(reason: DictationEndReason, send: boolean): void {
        // Read before settling: settling clears the live transcript.
        const heard = this.state.transcript.trim();
        const generation = this.generation;
        this.generation += 1;
        this.set(settling);
        void Promise.resolve()
            .then(() => this.engine.stop())
            .then((text) => {
                // A stop that settles after a cancel ran is a straggler; its
                // words go nowhere.
                if (generation + 1 !== this.generation) return;
                this.set(idle);
                // An empty final transcript does NOT mean nothing was said
                // (DROVE-105). Apple finalises on its own after a pause and a
                // stop that lands afterwards resolves with nothing, while the
                // partials are already on screen. Discarding there wipes them
                // and reads as "a pause cancelled everything I said", so the
                // last partial stands in for a final that came back empty.
                const trimmed = text.trim() || heard;
                if (trimmed.length === 0) {
                    this.events.onDiscard(reason);
                    return;
                }
                this.events.onCommit(trimmed, send, reason);
            })
            .catch((error) => {
                if (generation + 1 !== this.generation) return;
                this.set(idle);
                this.events.onError(error instanceof Error ? error.message : String(error));
            });
    }

    private set(next: DictationCaptureState): void {
        this.state = next;
        this.events.onChange(next);
    }
}
