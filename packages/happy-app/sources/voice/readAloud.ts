import type { Message } from '@/sync/typesMessage';
import { chunkStreamed } from './sentenceStream';
import { stripToSpeakableProse } from './speakable';

/**
 * The read-aloud queue (DROVE-30, mode B).
 *
 * Fed from the same seam the meta voice agent already reads, applyMessages in
 * sync/sync.ts, and speaks one sentence at a time so that stopping lands
 * mid-sentence rather than at the end of a paragraph. The engine is injected
 * so this whole thing is testable without a device.
 *
 * DROVE-97 added two things. The synthesiser only ever gets whole sentences:
 * a message's unfinished tail is held until the message grows, a later
 * message arrives, or a short hold expires. And it added the skip-ahead cut.
 *
 * DROVE-108 rewrote that cut, because the first measure of it was wrong.
 * It compared how long ago a sentence arrived with how long ago it was
 * spoken, and speech is ALWAYS slower than generation, so past about forty
 * words every reply looked stale and the middle of a normal answer was
 * thrown away. The rule now is:
 *
 *   - A finished turn is read to the end. There is nothing newer to be
 *     current with, so the backlog IS the answer.
 *   - While a turn is still being written, the backlog may be cut, but only
 *     when it is more than the threshold of UNSPOKEN AUDIO (estimated from
 *     word count and the speaking rate, not from a sentence's age) and new
 *     text is still arriving.
 *   - A new turn abandons the previous turn's unspoken tail and says the
 *     marker once. That is the case that was actually asked for.
 *
 * And rather than cut at the first opportunity, a voice that is behind reads
 * a little faster; a cut loses information, a faster read does not.
 */

/** Why speech stopped. Carried for logs and for the tests to assert on. */
export type ReadAloudInterruption =
    | 'typed'
    | 'sent'
    | 'mic'
    | 'left-session'
    | 'switched-session'
    | 'toggled-off'
    | 'call-started';

/** Per-utterance knobs. Today only the catch-up rate (DROVE-108). */
export interface SpeakOptions {
    /**
     * Multiplier on the configured speaking rate, 1 at rest. Bounded by the
     * reader (see `defaultMaxRateScale`) and clamped again by the engine to
     * whatever the platform and the speed slider allow.
     */
    rateScale?: number;
}

export interface SpeechEngine {
    /** Speak one utterance; settles when it is over, finished or cut. */
    speak(text: string, options?: SpeakOptions): Promise<unknown>;
    /** Cut whatever is speaking now, and hand the audio session back. */
    stop(): Promise<unknown> | void;
}

export interface ReadAloudOptions {
    /** Clock, injectable for the tests. */
    now?: () => number;
    /**
     * How many seconds of UNSPOKEN AUDIO may pile up before a still-arriving
     * turn is cut. Read at every pump rather than once, so a slider in
     * settings takes effect on the next sentence instead of the next launch.
     */
    maxBacklogSeconds?: () => number;
    /** What is said when the backlog is dropped. */
    skipMarker?: string;
    /**
     * How long an unfinished tail waits for more text before it is spoken as
     * it stands. Messages usually arrive whole, so this mostly covers a reply
     * whose last sentence has no full stop.
     */
    holdMs?: number;
    /**
     * Speaking rate used to turn a word count into seconds of audio. A rough
     * constant on purpose: it decides when the queue is "too long", and the
     * platform's own mapping from the rate slider to words a minute is not
     * public anyway.
     */
    wordsPerMinute?: number;
    /**
     * How close together two batches of text have to land to count as a
     * stream. Longer than this between the last two and the turn is treated
     * as finished, so what is left is read out in full however long it is.
     */
    arrivalWindowMs?: number;
    /**
     * Is this session still generating? The strongest evidence that there is
     * something newer to be current with, and the only one that does not have
     * to be inferred. Left out, the arrival stamps decide alone.
     */
    turnStillRunning?: (sessionId: string) => boolean;
    /** The most the catch-up may speed the voice up. */
    maxRateScale?: number;
}

/**
 * Seconds of unspoken audio, not seconds of delay: at 150 words a minute
 * this is about 37 words, roughly two or three sentences still to say while
 * the reply keeps growing.
 */
export const defaultMaxBacklogSeconds = 15;
export const defaultSkipMarker = 'Skipping ahead.';
/** Ordinary read-aloud prose lands near this; the estimate needs no better. */
export const defaultWordsPerMinute = 150;
/**
 * Two batches of text more than this far apart are not a stream. It has to
 * be long enough to bridge the gap a short tool call leaves between two
 * blocks of prose, and short enough that one big block landing after a pause
 * is read out rather than cut.
 */
export const defaultArrivalWindowMs = 4000;
/**
 * Bounds on the catch-up: at worst the voice reads 15 percent faster, which
 * is still comfortably inside the speed slider's range and does not sound
 * like a different setting. It ramps in linearly and reaches the top when
 * the backlog is twice the threshold.
 */
export const defaultMaxRateScale = 1.15;
const defaultHoldMs = 1500;

interface QueuedSentence {
    text: string;
    /** Precomputed so the backlog estimate is a sum, not a re-split. */
    words: number;
    /** Which turn this sentence belongs to; an older one is abandoned. */
    turn: number;
}

interface HeldTail {
    text: string;
    turn: number;
}

/** Words in a sentence, for the audio-duration estimate. */
function countWords(text: string): number {
    const parts = text.trim().split(/\s+/);
    return parts.length === 1 && parts[0] === '' ? 0 : parts.length;
}

/**
 * Told every time speech is cut, and why.
 *
 * This is how "anything that stops speech also stops capture" is made true
 * by construction rather than by remembering to (DROVE-30): the composer's
 * mic listens here, so a new reason to cut speech added later cuts capture
 * with it.
 */
export type ReadAloudInterruptListener = (reason: ReadAloudInterruption) => void;

export class ReadAloudReader {
    private readonly engine: SpeechEngine;
    private readonly now: () => number;
    private readonly maxBacklogSeconds: () => number;
    private readonly skipMarker: string;
    private readonly holdMs: number;
    private readonly wordsPerMinute: number;
    private readonly arrivalWindowMs: number;
    private readonly maxRateScale: number;
    private readonly turnStillRunning: ((sessionId: string) => boolean) | null;
    private readonly interruptListeners = new Set<ReadAloudInterruptListener>();
    private enabled = false;
    private focused: string | null = null;
    private queue: QueuedSentence[] = [];
    private speaking = false;
    /**
     * Bumped on every interruption. An utterance that settles under an old
     * generation is a straggler from before the cut and must not pull the next
     * one off a queue that has since been cleared.
     */
    private generation = 0;
    private started = false;
    /**
     * How many complete sentences of a given message have already been queued.
     * Messages arrive whole today (the CLI forwards complete JSONL lines), but
     * applyMessages reports a message as changed whenever anything about it
     * changes, so without this a redelivery would read the whole reply again.
     */
    private queuedChunks = new Map<string, number>();
    /** Each message's unfinished tail, waiting for more text. */
    private pendingTails = new Map<string, HeldTail>();
    private holdTimer: ReturnType<typeof setTimeout> | null = null;
    private latestCreatedAt = 0;
    /** How many times the backlog was dropped; for the tests and for logs. */
    private skips = 0;
    /**
     * Which turn is being read. A message from the user opens the next one,
     * and content from a newer turn abandons whatever is left of the older.
     */
    private turn = 0;
    /** createdAt of the user message that opened the current turn. */
    private turnOpenedAt = 0;
    /** The turn of the sentence being spoken right now. */
    private speakingTurn: number | null = null;
    /** A skip has happened and the marker has not been said yet. */
    private markerDue = false;
    /** The turn the arrival stamps below belong to. */
    private arrivalTurn = -1;
    /**
     * When the batch BEFORE the most recent one landed, or -Infinity while
     * only one has. One number, and it carries all three things the cut has
     * to know: that text has come in more than one batch, that the last two
     * were close together, and that it has not stopped.
     */
    private previousArrivalAt = Number.NEGATIVE_INFINITY;
    private lastArrivalAt = 0;

    constructor(engine: SpeechEngine, options: ReadAloudOptions = {}) {
        this.engine = engine;
        this.now = options.now ?? Date.now;
        this.maxBacklogSeconds = options.maxBacklogSeconds ?? (() => defaultMaxBacklogSeconds);
        this.skipMarker = options.skipMarker ?? defaultSkipMarker;
        this.holdMs = options.holdMs ?? defaultHoldMs;
        this.wordsPerMinute = options.wordsPerMinute ?? defaultWordsPerMinute;
        this.arrivalWindowMs = options.arrivalWindowMs ?? defaultArrivalWindowMs;
        this.maxRateScale = options.maxRateScale ?? defaultMaxRateScale;
        this.turnStillRunning = options.turnStillRunning ?? null;
    }

    get isSpeaking(): boolean {
        return this.speaking;
    }

    get pending(): number {
        return this.queue.length;
    }

    get skipCount(): number {
        return this.skips;
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    get focusedSessionId(): string | null {
        return this.focused;
    }

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        if (!enabled) this.interrupt('toggled-off');
    }

    /**
     * Which session is being READ. Only one, ever: four sessions finishing a
     * turn at once would have the phone narrating four replies over each other.
     */
    focus(sessionId: string | null, reason: ReadAloudInterruption = 'switched-session'): void {
        if (this.focused === sessionId) return;
        this.focused = sessionId;
        this.queuedChunks.clear();
        this.latestCreatedAt = 0;
        this.turnOpenedAt = 0;
        // Another session's arrival stamps say nothing about this one's.
        this.arrivalTurn = -1;
        this.interrupt(reason);
    }

    /**
     * Give focus up, but only if this session still holds it.
     *
     * More than one chat can be mounted (the tablet side panel, an embedded
     * view, the screen being replaced) and they unmount on their own
     * schedule. A bare focus(null) from any of them took the voice away from
     * whichever session the user was actually looking at.
     */
    blur(sessionId: string, reason: ReadAloudInterruption = 'left-session'): void {
        if (this.focused !== sessionId) return;
        this.focus(null, reason);
    }

    onMessages(sessionId: string, messages: Message[]): void {
        if (!this.enabled) return;
        if (this.focused === null || sessionId !== this.focused) return;

        const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
        let added = false;
        for (const message of ordered) {
            // A message from the user opens the next turn (DROVE-108). It is
            // the one boundary that is visible from here: agent text arrives
            // in several blocks per turn, so a new message id says nothing.
            if (message.kind === 'user-text' && message.createdAt > this.turnOpenedAt) {
                this.turn += 1;
                this.turnOpenedAt = message.createdAt;
            }

            if (message.kind !== 'agent-text' || message.isThinking) continue;
            if (typeof message.text !== 'string' || message.text.length === 0) continue;

            // A newer message means every older one is over: their tails are
            // spoken as they stand, and before this message's sentences.
            if (message.createdAt > this.latestCreatedAt) {
                if (this.flushTails((id) => id !== message.id)) added = true;
                this.latestCreatedAt = message.createdAt;
            }

            const prose = stripToSpeakableProse(message.text);
            const { complete, pending } = chunkStreamed(prose, false);
            const already = this.queuedChunks.get(message.id) ?? 0;
            if (complete.length > already) {
                this.enqueue(complete.slice(already), this.turn);
                this.queuedChunks.set(message.id, complete.length);
                added = true;
            }
            if (pending !== null) {
                this.pendingTails.set(message.id, { text: pending, turn: this.turn });
            } else {
                this.pendingTails.delete(message.id);
            }
        }
        if (added) this.noteArrival();
        this.armHold();
        if (added) this.pump();
    }

    /**
     * Cut speech now, mid-word, not at the end of the sentence, and tell
     * every capture that it is over too. Listeners hear about EVERY call,
     * including one made while nothing was speaking: a latched mic with
     * read-aloud off is still a mic that has to stop when the user types.
     */
    interrupt(reason: ReadAloudInterruption): void {
        this.generation += 1;
        this.queue = [];
        this.pendingTails.clear();
        this.clearHold();
        this.speaking = false;
        this.speakingTurn = null;
        // Nothing is owed to a queue the user threw away.
        this.markerDue = false;
        if (this.started) {
            this.started = false;
            void this.engine.stop();
        }
        for (const listener of this.interruptListeners) {
            try {
                listener(reason);
            } catch {
                // One controller failing to stop must not keep the next one
                // from hearing that it should.
            }
        }
    }

    /** Returns the unsubscribe. */
    addInterruptListener(listener: ReadAloudInterruptListener): () => void {
        this.interruptListeners.add(listener);
        return () => { this.interruptListeners.delete(listener); };
    }

    private enqueue(sentences: string[], turn: number): void {
        if (sentences.length === 0) return;
        this.abandonTurnsBefore(turn);
        for (const text of sentences) {
            this.queue.push({ text, words: countWords(text), turn });
        }
    }

    /**
     * A newer turn has something to say, so whatever is left of the older one
     * is dropped and the marker is owed once (DROVE-108).
     *
     * This cuts the utterance in flight WITHOUT going through interrupt():
     * the mic and the other captures hang off that, and a reply arriving is
     * not a reason to stop the user talking.
     */
    private abandonTurnsBefore(turn: number): void {
        const staleQueued = this.queue.some((sentence) => sentence.turn < turn);
        const staleSpeaking = this.speaking && this.speakingTurn !== null && this.speakingTurn < turn;
        if (!staleQueued && !staleSpeaking) return;

        this.queue = this.queue.filter((sentence) => sentence.turn >= turn);
        for (const [id, tail] of [...this.pendingTails]) {
            if (tail.turn < turn) this.pendingTails.delete(id);
        }
        this.markerDue = true;
        if (staleSpeaking) this.cutCurrentUtterance();
    }

    /** Stop the utterance in flight without telling the interrupt listeners. */
    private cutCurrentUtterance(): void {
        this.generation += 1;
        this.speaking = false;
        this.speakingTurn = null;
        if (this.started) {
            this.started = false;
            void this.engine.stop();
        }
    }

    /** Speak the held tails whose message id passes `where`; true if any did. */
    private flushTails(where: (messageId: string) => boolean = () => true): boolean {
        let flushed = false;
        for (const [id, tail] of [...this.pendingTails]) {
            if (!where(id)) continue;
            this.pendingTails.delete(id);
            this.enqueue([tail.text], tail.turn);
            this.queuedChunks.set(id, (this.queuedChunks.get(id) ?? 0) + 1);
            flushed = true;
        }
        return flushed;
    }

    /** New text landed; remember when, and when the batch before it did. */
    private noteArrival(): void {
        const at = this.now();
        if (this.arrivalTurn !== this.turn) {
            this.arrivalTurn = this.turn;
            this.previousArrivalAt = Number.NEGATIVE_INFINITY;
        } else {
            this.previousArrivalAt = this.lastArrivalAt;
        }
        this.lastArrivalAt = at;
    }

    /**
     * Is this turn still being written? Only then may the backlog be cut.
     *
     * Measured from the batch BEFORE the most recent one, which rules out
     * the three ways a finished answer looks busy: a reply delivered whole
     * (there is no earlier batch), one big block landing after a pause (the
     * gap is too long to be a stream), and a stream that has since stopped
     * (the last batch is no longer recent). All three are read to the end.
     *
     * The session's own generating flag, when the caller passes one, vetoes
     * the whole thing: nothing is newer once the agent has finished.
     */
    private stillArriving(): boolean {
        if (this.turnStillRunning !== null && this.focused !== null && !this.turnStillRunning(this.focused)) {
            return false;
        }
        return this.now() - this.previousArrivalAt <= this.arrivalWindowMs;
    }

    /** Seconds of audio left to say, from word count and the speaking rate. */
    private backlogSeconds(): number {
        let words = 0;
        for (const sentence of this.queue) words += sentence.words;
        return (words * 60) / this.wordsPerMinute;
    }

    /**
     * Read faster rather than cut. Flat 1 until the backlog passes the
     * threshold, then linear to `maxRateScale` at twice the threshold.
     */
    private catchUpRate(backlogSeconds: number, threshold: number): number {
        if (threshold <= 0 || backlogSeconds <= threshold) return 1;
        const over = Math.min(1, (backlogSeconds - threshold) / threshold);
        return 1 + over * (this.maxRateScale - 1);
    }

    private armHold(): void {
        this.clearHold();
        if (this.pendingTails.size === 0) return;
        this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            if (this.flushTails()) this.pump();
        }, this.holdMs);
    }

    private clearHold(): void {
        if (this.holdTimer === null) return;
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
    }

    private pump(): void {
        if (this.speaking) return;

        const threshold = this.maxBacklogSeconds();
        const backlog = this.backlogSeconds();

        // The cut (DROVE-108). Three things have to hold at once: there is
        // something newer to skip TO, more than the threshold of unspoken
        // audio is waiting, and the turn is still being written so that
        // newer material actually exists. A finished turn fails the third
        // test however long it is, which is the whole point.
        if (this.queue.length > 1 && backlog > threshold && this.stillArriving()) {
            this.queue = [this.queue[this.queue.length - 1]];
            this.markerDue = true;
        }

        if (this.markerDue) {
            this.markerDue = false;
            this.skips += 1;
            this.speakNow(this.skipMarker, this.queue[0]?.turn ?? this.turn, 1);
            return;
        }

        const next = this.queue.shift();
        if (next === undefined) {
            // Drained. Stopping here is not about cutting anything off, it is
            // about releasing the audio session so ducked music comes back up
            // instead of staying quiet until the next reply.
            if (this.started) {
                this.started = false;
                void this.engine.stop();
            }
            return;
        }
        this.speakNow(next.text, next.turn, this.catchUpRate(backlog, threshold));
    }

    private speakNow(text: string, turn: number, rateScale: number): void {
        this.speaking = true;
        this.speakingTurn = turn;
        this.started = true;
        const generation = this.generation;
        void Promise.resolve()
            .then(() => this.engine.speak(text, { rateScale }))
            .catch(() => {
                // One utterance failing must not wedge every later one. The
                // reply keeps being read from the next sentence on.
            })
            .then(() => {
                if (generation !== this.generation) return;
                this.speaking = false;
                this.speakingTurn = null;
                this.pump();
            });
    }
}
