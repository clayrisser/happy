import type { ReadAloudInterruption } from './readAloud';
import { joinDictation } from './dictationDraft';
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
 *
 * And one rule beside that: A LATCH ACCUMULATES ACROSS RECOGNISER TASKS
 * (DROVE-140). Apple's recogniser finalises on its own after a pause, and the
 * native module then starts a FRESH task on the same microphone. A fresh task
 * reports from empty, so its first partial is not a revision of the sentence
 * before the pause, it is the sentence after it. Which of the two a partial is
 * cannot be told by comparing the strings: "yes" after "no" is a revision when
 * the recogniser changed its mind and a continuation when he said them a
 * breath apart. So it is keyed on the TASK the partial belongs to, which
 * native reports alongside the text: the same task REVISES what it said
 * before, a new task APPENDS to it.
 *
 * And one rule under those: A CAPTURE ENDING NEVER COSTS WORDS (DROVE-120).
 * Text that has already appeared in the composer is not removed by any path
 * in here. Endings differ only in whether they also SEND. The
 * single exception is the `cancel` gesture, which is the user asking; it is
 * named and argued in dictationComposer.ts, which owns what the composer does
 * with each reason.
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
    /**
     * The capture ended with nothing to commit: the audio was dropped, or the
     * recogniser had nothing to add to what is already on screen. This does
     * NOT mean the composer should be emptied; see dictationComposer.ts.
     */
    onDiscard(reason: DictationEndReason): void;
    onError(message: string): void;
    onChange(state: DictationCaptureState): void;
}

/**
 * The words to keep when the recogniser's FINAL string and the partials
 * already on screen disagree (DROVE-105, DROVE-120).
 *
 * The invariant is that a capture ending never takes back text the composer
 * has already shown, so the final only wins when it actually says more.
 *
 * - An empty final does NOT mean nothing was said. Apple finalises on its own
 *   after a pause or at the recogniser's own time limit, and the native module
 *   clears `latestTranscript` when it does, so a stop landing afterwards
 *   resolves with "" while the words are still on screen. The last partial
 *   stands in.
 * - A final that is a PREFIX of what was shown is the recogniser having been
 *   cut off mid-sentence. Keep the longer one.
 * - Anything else is a genuine revision ("um hello" -> "hello", "twenty two"
 *   -> "22"), and the recogniser is the better authority on its own words.
 *
 * This compares a final against what is SHOWN, which is the whole capture
 * including tasks that ended inside it. The native contract is that the final
 * transcript covers the whole capture too, not merely the last task, so the
 * two are comparable (DROVE-140).
 */
export function keptTranscript(heard: string, final: string): string {
    const shown = heard.trim();
    const settled = final.trim();
    if (settled.length === 0) return shown;
    if (settled.length < shown.length && shown.startsWith(settled)) return shown;
    return settled;
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
    /**
     * Words from recognition tasks that already ENDED inside this capture
     * (DROVE-140). Everything the current task reports is appended to this,
     * never written over it.
     */
    private banked = '';
    /** The current task's latest text, revised in place while it runs. */
    private heard = '';
    /** Which recognition task `heard` belongs to; null until native names one. */
    private task: number | null = null;

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
        this.banked = '';
        this.heard = '';
        this.task = null;
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

    /**
     * A partial transcript landed. Under a latch a CHANGE is what "not idle"
     * means.
     *
     * `task` names the recognition task the text belongs to (DROVE-140). The
     * same task REVISES: its text replaces what it said before, because the
     * recogniser is improving its own guess. A DIFFERENT task CONTINUES: the
     * words heard so far are banked and the new task's text is appended to
     * them, because a fresh task always reports from empty and would
     * otherwise wipe everything said before the pause.
     *
     * A build whose native side does not report a task leaves this undefined,
     * and every partial then replaces, which is exactly what those builds did
     * before. They never restart a task either, so nothing is silently lost:
     * the capture simply ends when Apple finalises, with the words in the
     * composer.
     */
    partial(text: string, task?: number): void {
        if (!this.state.active) return;
        this.bankEndedTask(task);
        this.heard = text;
        const full = joinDictation(this.banked, this.heard);
        const changed = full !== this.state.transcript;
        this.set({
            ...this.state,
            transcript: full,
            idleAt: changed && this.state.mode === 'latch'
                ? this.now() + DICTATION_LATCH_IDLE_MS
                : this.state.idleAt,
        });
        if (changed) this.events.onPartial(full);
    }

    /**
     * Move the outgoing task's words into the bank when a NEW task's text
     * arrives. No-op while the build reports no task at all, and no-op for
     * the first task of a capture, which has nothing before it.
     */
    private bankEndedTask(task: number | undefined): void {
        if (task === undefined) return;
        if (this.task !== null && task !== this.task) {
            this.banked = joinDictation(this.banked, this.heard);
            this.heard = '';
        }
        this.task = task;
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
     * speech also stops capture). Typing goes through finish(), so the words
     * are transcribed properly before the user's keystrokes land on them;
     * every other reason drops the AUDIO immediately, because a call or
     * another mic wants the audio session now and cannot wait 2s for a stop
     * to settle. Dropping the audio is not dropping the words: the partials
     * already in the composer stay there (DROVE-120), which is why this line
     * used to be the widest route by which a sentence vanished mid-hold.
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
     * The recogniser ended on its own and is NOT coming back: it gave up, or
     * the build is one that cannot restart a task after Apple finalises. The
     * mic still looked live, so honest is to end now, in either ergonomic,
     * with the words kept and unsent. Under hold the lift that follows finds
     * nothing to do.
     *
     * On a build that DOES continue across a pause this arrives only at the
     * real end of the capture, so the words banked from earlier tasks are
     * part of `text` as well as of what is shown (DROVE-140).
     */
    recogniserEnded(text: string, task?: number): void {
        if (!this.state.active) return;
        this.bankEndedTask(task);
        // Banking only moves words between the two halves of what is already
        // shown, so this is the whole capture either way.
        const heard = joinDictation(this.banked, this.heard).trim();
        this.generation += 1;
        void this.engine.cancel();
        this.set(idle);
        // The recogniser giving up, or being cut off at its own time limit,
        // must not erase the partials it already reported (DROVE-105,
        // DROVE-120).
        const trimmed = keptTranscript(heard, text);
        if (trimmed.length > 0) {
            this.events.onCommit(trimmed, false, 'recogniser');
        } else {
            this.events.onDiscard('recogniser');
        }
    }

    /**
     * The screen went away with the mic on, or something took the audio.
     * Nothing is left recording. The words already shown are NOT taken back;
     * dictationComposer.ts decides that per reason (DROVE-120).
     */
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
                // A final that says less than what is already on screen does
                // NOT mean the words were never said (DROVE-105, DROVE-120);
                // see keptTranscript.
                const trimmed = keptTranscript(heard, text);
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
