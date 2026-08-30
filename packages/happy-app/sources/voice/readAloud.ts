import type { Message } from '@/sync/typesMessage';
import { speakableChunks } from './speakable';

/**
 * The read-aloud queue (DROVE-30, mode B).
 *
 * Fed from the same seam the meta voice agent already reads — applyMessages in
 * sync/sync.ts — and speaks one sentence at a time so that stopping lands
 * mid-sentence rather than at the end of a paragraph. The engine is injected
 * so this whole thing is testable without a device.
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

export class ReadAloudReader {
    private readonly engine: SpeechEngine;
    private enabled = false;
    private focused: string | null = null;
    private queue: string[] = [];
    private speaking = false;
    /**
     * Bumped on every interruption. An utterance that settles under an old
     * generation is a straggler from before the cut and must not pull the next
     * one off a queue that has since been cleared.
     */
    private generation = 0;
    private started = false;
    /**
     * How many chunks of a given message have already been queued. Messages
     * arrive whole today (the CLI forwards complete JSONL lines), but
     * applyMessages reports a message as changed whenever anything about it
     * changes, so without this a redelivery would read the whole reply again.
     */
    private queuedChunks = new Map<string, number>();

    constructor(engine: SpeechEngine) {
        this.engine = engine;
    }

    get isSpeaking(): boolean {
        return this.speaking;
    }

    get pending(): number {
        return this.queue.length;
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
        this.interrupt(reason);
    }

    /**
     * Give focus up, but only if this session still holds it.
     *
     * More than one chat can be mounted — the tablet side panel, an embedded
     * view, the screen being replaced — and they unmount on their own
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
            const chunks = speakableChunks(message);
            if (chunks.length === 0) continue;
            const already = this.queuedChunks.get(message.id) ?? 0;
            if (chunks.length <= already) continue;
            this.queue.push(...chunks.slice(already));
            this.queuedChunks.set(message.id, chunks.length);
            added = true;
        }
        if (added) this.pump();
    }

    /** Cut speech now — mid-word, not at the end of the sentence. */
    interrupt(_reason: ReadAloudInterruption): void {
        this.generation += 1;
        this.queue = [];
        this.speaking = false;
        if (this.started) {
            this.started = false;
            void this.engine.stop();
        }
    }

    private pump(): void {
        if (this.speaking) return;
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

        this.speaking = true;
        this.started = true;
        const generation = this.generation;
        void Promise.resolve()
            .then(() => this.engine.speak(next))
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
