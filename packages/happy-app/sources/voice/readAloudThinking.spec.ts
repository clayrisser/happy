import { beforeEach, describe, expect, it } from 'vitest';
import { ReadAloudReader, type SpeakOptions } from './readAloud';
import type { Message } from '@/sync/typesMessage';

/**
 * The reader reads the THINKING too (DROVE-181).
 *
 * Clay: "Read thought processes too". Thinking blocks were skipped outright.
 *
 * The four things that had to be true, and each has a test here:
 *  - It is said BEFORE the reply it precedes, in place, not appended after.
 *  - It sounds different from the reply, and different in the other direction
 *    from an aside: lower, not faster.
 *  - Spoken-once, the mic gate, the catch-up and the jump all apply, so a
 *    minute of thinking is skippable to reach the answer.
 *  - It does NOT re-open the arrival window (DROVE-177). The model thinking is
 *    not the model writing, and a thought counting as an arrival would bring
 *    the catch-up rate back on a reply that had already landed whole.
 */

interface Said {
    text: string;
    thinking: boolean;
    aside: boolean;
    rateScale: number;
}

describe('reading the thinking', () => {
    let now = 0;
    let said: Said[] = [];
    let reader: ReadAloudReader;

    function thought(id: string, text: string, createdAt: number): Message {
        return {
            id,
            localId: null,
            createdAt,
            kind: 'agent-text',
            isThinking: true,
            text: `*${text}*`,
        } as unknown as Message;
    }

    function prose(id: string, text: string, createdAt: number): Message {
        return { id, localId: null, createdAt, kind: 'agent-text', text } as unknown as Message;
    }

    function build(options: Parameters<typeof makeReader>[0] = {}) {
        return makeReader(options);
    }

    function makeReader(options: {
        thinkingOn?: boolean;
        maxBacklogSeconds?: number;
        jumpBacklogSeconds?: number;
        turnStillRunning?: boolean;
    }) {
        const built = new ReadAloudReader(
            {
                speak(text: string, opts?: SpeakOptions) {
                    said.push({
                        text,
                        thinking: opts?.thinking === true,
                        aside: opts?.aside === true,
                        rateScale: opts?.rateScale ?? 1,
                    });
                    return Promise.resolve();
                },
                stop() { },
            },
            {
                now: () => now,
                ...(options.maxBacklogSeconds !== undefined
                    ? { maxBacklogSeconds: () => options.maxBacklogSeconds as number }
                    : {}),
                ...(options.jumpBacklogSeconds !== undefined
                    ? { jumpBacklogSeconds: () => options.jumpBacklogSeconds as number }
                    : {}),
                ...(options.turnStillRunning !== undefined
                    ? { turnStillRunning: () => options.turnStillRunning as boolean }
                    : {}),
                // The service's own hook, minus the setting: unwrap the
                // italics the reducer stores a thinking block in.
                thinkingFor: options.thinkingOn === false
                    ? () => null
                    : (message) => {
                        if (message.kind !== 'agent-text' || typeof message.text !== 'string') return null;
                        const trimmed = message.text.trim();
                        return trimmed.startsWith('*') ? trimmed.slice(1, -1) : trimmed;
                    },
            },
        );
        built.setEnabled(true);
        built.focus('s1');
        built.setSessionEnabled('s1', true);
        return built;
    }

    beforeEach(() => {
        now = 1_000_000;
        said = [];
        reader = build();
    });

    async function settle(): Promise<void> {
        for (let i = 0; i < 40; i++) await Promise.resolve();
    }

    it('says the thought before the reply it precedes', async () => {
        reader.onMessages('s1', [
            thought('t1', 'Let me check the file.', now),
            prose('m1', 'The file is empty.', now + 1),
        ]);
        await settle();
        expect(said.map((entry) => entry.text)).toEqual([
            'Let me check the file.',
            'The file is empty.',
        ]);
    });

    it('marks the thought as thinking and the reply as neither', async () => {
        reader.onMessages('s1', [thought('t1', 'Hmm.', now), prose('m1', 'Yes.', now + 1)]);
        await settle();
        expect(said[0].thinking).toBe(true);
        expect(said[0].aside).toBe(false);
        expect(said[1].thinking).toBe(false);
    });

    it('says a thought once, however often the message is redelivered', async () => {
        const message = thought('t1', 'One thought.', now);
        reader.onMessages('s1', [message]);
        await settle();
        reader.onMessages('s1', [message]);
        await settle();
        expect(said.map((entry) => entry.text)).toEqual(['One thought.']);
    });

    it('is silent with the setting off, and the reply is untouched', async () => {
        const off = build({ thinkingOn: false });
        off.onMessages('s1', [thought('t1', 'Skipped.', now), prose('m1', 'Answer.', now + 1)]);
        await settle();
        expect(said.map((entry) => entry.text)).toEqual(['Answer.']);
    });

    it('says nothing while the mic holds the route, and picks up after', async () => {
        reader.setMicHeld(true);
        reader.onMessages('s1', [thought('t1', 'Held.', now)]);
        await settle();
        expect(said).toEqual([]);
        reader.setMicHeld(false);
        await settle();
        expect(said.map((entry) => entry.text)).toEqual(['Held.']);
    });

    it('is skippable: a long thought is jumped to reach the answer', async () => {
        // The whole reason the jump has to apply to thinking. A minute of
        // reasoning followed by the answer must not mean a minute of waiting.
        const jumping = build({
            maxBacklogSeconds: 1,
            jumpBacklogSeconds: 2,
            turnStillRunning: true,
        });
        const long = Array.from({ length: 60 }, (_, i) => `Thought ${i}.`).join(' ');
        jumping.onMessages('s1', [thought('t1', long, now)]);
        now += 100;
        jumping.onMessages('s1', [
            thought('t1', long, now - 100),
            prose('m1', 'The answer.', now),
        ]);
        await settle();
        expect(jumping.skipCount).toBeGreaterThan(0);
        expect(said[said.length - 1].text).toBe('The answer.');
    });

    it('does not count a thought as an arrival, so the rate stays normal', async () => {
        // DROVE-177's rule, extended. A finished reply is read at exactly the
        // slider; a thought landing beside it must not re-open the window and
        // bring the catch-up rate back.
        const ramped = build({ maxBacklogSeconds: 1, jumpBacklogSeconds: 100 });
        const long = Array.from({ length: 40 }, (_, i) => `Word ${i}.`).join(' ');
        ramped.onMessages('s1', [thought('t1', long, now)]);
        now += 500;
        ramped.onMessages('s1', [thought('t2', long, now)]);
        await settle();
        expect(said.length).toBeGreaterThan(0);
        for (const entry of said) expect(entry.rateScale).toBe(1);
    });
});
