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
 * Two things were added for DROVE-97. The synthesiser only ever gets whole
 * sentences: a message's unfinished tail is held until the message grows,
 * a later message arrives, or a short hold expires. And every queued sentence
 * remembers when it arrived, so when the voice has fallen further behind the
 * text than the lag threshold the backlog is dropped, a two-word marker is
 * spoken, and speech resumes from the newest sentence.
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

export interface SpeechEngine {
    /** Speak one utterance; settles when it is over, finished or cut. */
    speak(text: string): Promise<unknown>;
    /** Cut whatever is speaking now, and hand the audio session back. */
    stop(): Promise<unknown> | void;
}

export interface ReadAloudOptions {
    /** Clock, injectable for the tests. */
    now?: () => number;
    /**
     * Read at every pump rather than once, so a slider in settings takes
     * effect on the next sentence instead of the next launch.
     */
    maxLagSeconds?: () => number;
    /** What is said when the backlog is dropped. */
    skipMarker?: string;
    /**
     * How long an unfinished tail waits for more text before it is spoken as
     * it stands. Messages usually arrive whole, so this mostly covers a reply
     * whose last sentence has no full stop.
     */
    holdMs?: number;
}

export const defaultMaxLagSeconds = 15;
export const defaultSkipMarker = 'Skipping ahead.';
const defaultHoldMs = 1500;

interface QueuedSentence {
    text: string;
    arrivedAt: number;
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
    private readonly maxLagSeconds: () => number;
    private readonly skipMarker: string;
    private readonly holdMs: number;
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
    private pendingTails = new Map<string, string>();
    private holdTimer: ReturnType<typeof setTimeout> | null = null;
    private latestCreatedAt = 0;
    /** How many times the backlog was dropped; for the tests and for logs. */
    private skips = 0;

    constructor(engine: SpeechEngine, options: ReadAloudOptions = {}) {
        this.engine = engine;
        this.now = options.now ?? Date.now;
        this.maxLagSeconds = options.maxLagSeconds ?? (() => defaultMaxLagSeconds);
        this.skipMarker = options.skipMarker ?? defaultSkipMarker;
        this.holdMs = options.holdMs ?? defaultHoldMs;
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
                this.enqueue(complete.slice(already));
                this.queuedChunks.set(message.id, complete.length);
                added = true;
            }
            if (pending !== null) {
                this.pendingTails.set(message.id, pending);
            } else {
                this.pendingTails.delete(message.id);
            }
        }
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

    private enqueue(sentences: string[]): void {
        const arrivedAt = this.now();
        for (const text of sentences) this.queue.push({ text, arrivedAt });
    }

    /** Speak the held tails whose message id passes `where`; true if any did. */
    private flushTails(where: (messageId: string) => boolean = () => true): boolean {
        let flushed = false;
        for (const [id, tail] of [...this.pendingTails]) {
            if (!where(id)) continue;
            this.pendingTails.delete(id);
            this.enqueue([tail]);
            this.queuedChunks.set(id, (this.queuedChunks.get(id) ?? 0) + 1);
            flushed = true;
        }
        return flushed;
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

        // The cut (DROVE-97): the sentence about to be spoken arrived longer
        // ago than the threshold, and newer ones are waiting behind it. Drop
        // everything but the newest, say so, and carry on from there. With
        // nothing newer waiting there is nothing to skip to, so it is spoken.
        const lagMs = this.maxLagSeconds() * 1000;
        if (this.queue.length > 1 && this.now() - this.queue[0].arrivedAt > lagMs) {
            const newest = this.queue[this.queue.length - 1];
            this.queue = [newest];
            this.skips += 1;
            this.speakNow(this.skipMarker);
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
        this.speakNow(next.text);
    }

    private speakNow(text: string): void {
        this.speaking = true;
        this.started = true;
        const generation = this.generation;
        void Promise.resolve()
            .then(() => this.engine.speak(text))
            .catch(() => {
                // One utterance failing must not wedge every later one. The
                // reply keeps being read from the next sentence on.
            })
            .then(() => {
                if (generation !== this.generation) return;
                this.speaking = false;
                this.pump();
            });
    }
}
