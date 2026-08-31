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
 * And one rule beside that: A CAPTURE SURVIVES ITS RECOGNISER (DROVE-140).
 * Apple ends an utterance on silence. That is the recogniser's business, not
 * the user's, and it must not end HIS capture: a hold with a pause in it is
 * one sentence he is still in the middle of saying. So a capture is a
 * sequence of SEGMENTS, and it owns the boundary between them:
 *
 *   - `banked` is what segments this capture has already closed heard. It is
 *     APPEND-ONLY for the life of the capture. Nothing removes a banked word.
 *   - `heard` is the live segment, exactly as the recogniser last reported it.
 *     Only this may be revised, which is what makes "to fifty too" -> "22"
 *     still work.
 *   - What the composer shows is the two joined, so the transcript can only
 *     ever grow across a pause of any length, however many pauses there are.
 *
 * A segment closes on a signal from the recogniser, never on a comparison of
 * strings. Strings cannot decide it: "yes" after "no" is a revision when the
 * recogniser changed its mind and a new sentence when he said them a breath
 * apart. There are two such signals and both are structural:
 *
 *   1. The native module ends the capture with reason `final`, which is Apple
 *      finalising an utterance on silence. `recogniserEnded` banks that
 *      segment and OPENS THE MICROPHONE AGAIN rather than ending under him.
 *      This is the one that reaches the phone: it is JS, so it ships OTA.
 *   2. On a native build that restarts the task itself, the module keeps the
 *      microphone open and folds the earlier tasks into the text it reports,
 *      so JS sees one growing transcript and does nothing. The task id it
 *      stamps on each partial is informational there, NOT a second
 *      accumulator: banking on it as well is how the shipped attempt at this
 *      ticket came to duplicate every sentence before a pause.
 *
 * WHAT WENT WRONG THE FIRST TIME, because it is the reason this is written as
 * one contract in one place. The Swift and the JS of DROVE-140 landed in one
 * commit and disagreed about what a partial CONTAINS. Native sent
 * `bankedTranscript + taskTranscript`, the whole capture; `partial()` read it
 * as the current task alone and prepended everything it had already heard, so
 * one pause turned "so the thing I wanted to say" into that sentence twice.
 * The unit tests wrote down the JS side of the disagreement and so passed. The
 * contract now has one owner, the native module, and it is stated once here
 * and once in modules/drover-speech/index.ts: A PARTIAL IS EVERYTHING THE
 * RECOGNISER HAS HEARD SINCE THE MICROPHONE OPENED. `banked` covers only the
 * segments THIS FILE closed, so the two accumulators cannot overlap.
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
 * The native module's own word for "Apple finalised this utterance", as
 * DroverSpeechModule.swift writes it on `onDictationEnded`. Every other reason
 * is an error string: the recogniser saying it cannot go on.
 */
export const RECOGNISER_FINAL = 'final';

/**
 * How many segments may end in a row having heard nothing before the capture
 * gives up (DROVE-140).
 *
 * Reopening the microphone after each of Apple's finalisations is what turns a
 * pause into a pause rather than the end of the capture, but a recogniser that
 * finalises instantly over silence would otherwise be reopened forever. Any
 * segment that hears a word resets the count, so this bounds the SILENCE at
 * the end of a capture, not its length: he can pause as often and as long as
 * he likes as long as he carries on talking.
 */
export const MAX_SILENT_SEGMENTS = 3;

/**
 * The words to keep for ONE SEGMENT when the recogniser's final string and the
 * partials already on screen disagree (DROVE-105, DROVE-120).
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
 * SEGMENT, not capture (DROVE-140). Both sides of this comparison describe the
 * same stretch of recognition: the partials of the live segment against the
 * final of that same segment. Words banked from earlier segments are never
 * passed in and so can never lose to a final that does not mention them, which
 * is what a whole-capture comparison would do the moment the microphone is
 * reopened mid-hold.
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
     * What the segments this capture has already CLOSED heard (DROVE-140).
     * Append-only for the life of the capture: no path in here removes a word
     * from it, which is the whole of the promise that a pause cannot cost him
     * a sentence.
     */
    private banked = '';
    /**
     * The live segment, exactly as the recogniser last reported it, which is
     * everything heard since the microphone last opened. Revisable, because
     * revising its own guess is what a recogniser does; `banked` is what
     * protects the sentences before it.
     */
    private heard = '';
    /**
     * Segments closed in a row having heard nothing. Any segment that hears a
     * word resets it. See MAX_SILENT_SEGMENTS.
     */
    private silentSegments = 0;

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
        this.silentSegments = 0;
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
     * `text` is EVERYTHING THE RECOGNISER HAS HEARD SINCE THE MICROPHONE
     * OPENED, which is the native module's contract and not a guess: the Swift
     * sends `bankedTranscript + taskTranscript` on every partial, so a task it
     * restarts internally is already folded in. It therefore REPLACES the live
     * segment and is never appended to itself. Appending it to itself is
     * exactly what the first attempt at this ticket did, and one pause turned
     * a sentence into that sentence twice.
     *
     * The sentences from BEFORE this microphone opened are in `banked`, which
     * this does not touch. That is why a revision here can never reach them.
     */
    partial(text: string): void {
        if (!this.state.active) return;
        this.heard = text;
        this.showTranscript(true);
    }

    /**
     * Put `banked` + `heard` on screen. `speech` says whether what caused this
     * was the user talking, which is the only thing that pushes a latch's idle
     * deadline out; a segment closing is the recogniser's doing, not his.
     */
    private showTranscript(speech: boolean): void {
        const full = joinDictation(this.banked, this.heard);
        const changed = full !== this.state.transcript;
        this.set({
            ...this.state,
            transcript: full,
            idleAt: changed && speech && this.state.mode === 'latch'
                ? this.now() + DICTATION_LATCH_IDLE_MS
                : this.state.idleAt,
        });
        if (changed) this.events.onPartial(full);
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
     * The recogniser's task ended and nobody asked it to (DROVE-30,
     * DROVE-140). `reason` is the native module's own word for why:
     * `final` is Apple finalising an utterance, anything else is an error.
     *
     * A `final` IS A PAUSE, NOT AN ENDING. It is the recogniser deciding he
     * has stopped talking, which is a judgement about a second and a half of
     * silence and says nothing about whether he is finished. Ending his
     * capture there is the fault he has reported three times: the microphone
     * died under his thumb mid-hold, everything he said next went nowhere, and
     * the sentence he had already said sat there looking like all he got. So a
     * `final` BANKS the segment and opens the microphone again, and the button
     * never even flickers.
     *
     * Anything else is the recogniser saying it cannot go on, and reopening
     * into that is how a restart loop starts. It ends the capture with every
     * word kept and nothing sent, in either ergonomic, so a latched mic never
     * sits there looking live over a dead task.
     */
    recogniserEnded(text: string, reason?: string): void {
        if (!this.state.active) return;
        // The final describes the LIVE segment only, so it is compared with
        // the live segment only. Banked sentences are not in it and must not
        // be judged by it (DROVE-140).
        const segment = keptTranscript(this.heard, text);
        if (reason === RECOGNISER_FINAL && this.reopen(segment)) return;
        this.generation += 1;
        void this.engine.cancel();
        this.set(idle);
        // The recogniser giving up, or being cut off at its own time limit,
        // must not erase the partials it already reported (DROVE-105,
        // DROVE-120).
        const trimmed = joinDictation(this.banked, segment).trim();
        if (trimmed.length > 0) {
            this.events.onCommit(trimmed, false, 'recogniser');
        } else {
            this.events.onDiscard('recogniser');
        }
    }

    /**
     * Bank the segment that just closed and open the microphone again, so the
     * capture outlives the utterance (DROVE-140). False when it should not be
     * reopened, and the caller then ends the capture for real.
     *
     * The audio between the recogniser letting go and the next one running is
     * not recorded. That is a real cost and it is the smaller one: it is the
     * moment he is not talking, which is why the utterance finalised, and the
     * alternative is the whole rest of what he says.
     */
    private reopen(segment: string): boolean {
        this.silentSegments = segment.trim().length === 0 ? this.silentSegments + 1 : 0;
        if (this.silentSegments > MAX_SILENT_SEGMENTS) return false;
        this.banked = joinDictation(this.banked, segment);
        this.heard = '';
        // A final can revise the segment it closes, so the composer follows
        // it. It cannot shrink what is banked: `banked` only ever grew.
        this.showTranscript(false);
        const generation = this.generation;
        void Promise.resolve()
            .then(() => this.engine.cancel())
            .then(() => {
                // The gesture ended the capture while the microphone was
                // between recognisers. Starting one now would leave it live
                // over a capture nobody is watching.
                if (generation !== this.generation) return undefined;
                return this.engine.start();
            })
            .then(() => {
                // And the same race the other way round: the lift landed
                // while the start was in flight, so the stop it fired had
                // nothing to stop. Close what we opened.
                if (generation !== this.generation) void this.engine.cancel();
            })
            .catch((error) => {
                if (generation !== this.generation) return;
                // The microphone would not reopen. Say so, and keep every
                // word: a failure to continue is not a reason to lose what
                // was already heard (DROVE-120).
                this.generation += 1;
                this.set(idle);
                const kept = this.banked.trim();
                if (kept.length > 0) {
                    this.events.onCommit(kept, false, 'recogniser');
                } else {
                    this.events.onDiscard('recogniser');
                }
                this.events.onError(error instanceof Error ? error.message : String(error));
            });
        return true;
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
        // Read before settling: settling clears the live transcript. The two
        // halves are kept apart on purpose (DROVE-140): the recogniser's final
        // covers the segment it is finishing, so only that is put to it, and
        // the sentences banked from earlier segments are joined back on
        // afterwards where nothing can judge them away.
        const banked = this.banked;
        const live = this.heard;
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
                const trimmed = joinDictation(banked, keptTranscript(live, text)).trim();
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
