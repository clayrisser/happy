import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { defaultMaxRateScale, ReadAloudReader, type ReadAloudOptions, type SpeakOptions, type SpeechEngine } from './readAloud';

/** An engine that lets a test decide when each utterance ends. */
class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    /** The catch-up multiplier asked for per utterance (DROVE-108). */
    rates: number[] = [];
    stops = 0;
    private resolvers: (() => void)[] = [];

    speak(text: string, options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        this.rates.push(options?.rateScale ?? 1);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        this.stops += 1;
        const pending = this.resolvers;
        this.resolvers = [];
        for (const resolve of pending) resolve();
    }

    /** Let the current utterance finish. */
    finishOne(): void {
        const resolve = this.resolvers.shift();
        resolve?.();
    }
}

/** Let every queued microtask run, the way the reader chains them. */
async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function agentText(id: string, text: string, createdAt = 1): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

/** What opens a new turn, as far as the reader can see (DROVE-108). */
function userText(id: string, createdAt: number, text = 'and now this'): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text } as Message;
}

/** `count` sentences of three words each, numbered so order is checkable. */
function sentences(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => `${prefix} sentence ${i + 1}.`);
}

describe('ReadAloudReader', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
    });

    it('speaks assistant prose one sentence at a time', async () => {
        reader.onMessages('s1', [agentText('m1', 'All set. Tests pass. Nothing else changed.')]);
        await settle();
        expect(engine.spoken).toEqual(['All set.']);

        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['All set.', 'Tests pass.']);

        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['All set.', 'Tests pass.', 'Nothing else changed.']);
    });

    it('starts speaking before the rest of the reply is queued', async () => {
        reader.onMessages('s1', [agentText('m1', 'First part lands.')]);
        await settle();
        expect(engine.spoken).toEqual(['First part lands.']);

        // Second block of the same turn, still mid-turn.
        reader.onMessages('s1', [agentText('m2', 'Second part lands.', 2)]);
        await settle();
        expect(engine.spoken).toEqual(['First part lands.']);

        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['First part lands.', 'Second part lands.']);
    });

    it('never speaks tool calls, thinking or the user', async () => {
        const tool = {
            kind: 'tool-call', id: 't1', localId: null, createdAt: 1, children: [],
            tool: {
                name: 'Bash', state: 'completed', input: { command: 'ls' },
                createdAt: 1, startedAt: 1, completedAt: 2, description: 'ls',
            },
        } as unknown as Message;
        const thinking = {
            kind: 'agent-text', id: 'k1', localId: null, createdAt: 2,
            text: '*deciding*', isThinking: true,
        } as unknown as Message;
        const user = {
            kind: 'user-text', id: 'u1', localId: null, createdAt: 3, text: 'go on',
        } as unknown as Message;

        reader.onMessages('s1', [tool, thinking, user]);
        await settle();
        expect(engine.spoken).toEqual([]);
    });

    it('reads only the session in focus', async () => {
        reader.onMessages('s2', [agentText('m1', 'Other session talking.')]);
        await settle();
        expect(engine.spoken).toEqual([]);
    });

    it('says nothing at all while disabled', async () => {
        reader.setEnabled(false);
        reader.onMessages('s1', [agentText('m1', 'Quiet please.')]);
        await settle();
        expect(engine.spoken).toEqual([]);
    });

    it('cuts speech and drops the rest of the queue when interrupted', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two. Three.')]);
        await settle();
        expect(engine.spoken).toEqual(['One.']);

        reader.interrupt('typed');
        await settle();
        expect(engine.stops).toBe(1);
        expect(reader.pending).toBe(0);
        // The straggler settling under the old generation must not restart it.
        expect(engine.spoken).toEqual(['One.']);
    });

    it('goes quiet when read-aloud is toggled off mid-reply', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        reader.setEnabled(false);
        await settle();
        expect(engine.stops).toBe(1);
        expect(engine.spoken).toEqual(['One.']);
    });

    it('stops when the session being read changes', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        reader.focus('s2');
        await settle();
        expect(engine.stops).toBe(1);
        expect(engine.spoken).toEqual(['One.']);
    });

    it('stops when the session is left entirely', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        reader.focus(null, 'left-session');
        await settle();
        expect(engine.stops).toBe(1);
    });

    it('lets a second chat unmount without taking the voice away', async () => {
        reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        // The embedded side chat, on some other session, going away.
        reader.blur('s2');
        await settle();
        expect(reader.focusedSessionId).toBe('s1');
        expect(engine.stops).toBe(0);

        reader.blur('s1');
        await settle();
        expect(reader.focusedSessionId).toBeNull();
        expect(engine.stops).toBe(1);
    });

    it('does not re-read a message that is redelivered unchanged', async () => {
        const message = agentText('m1', 'Only once.');
        reader.onMessages('s1', [message]);
        await settle();
        engine.finishOne();
        await settle();
        reader.onMessages('s1', [message]);
        await settle();
        expect(engine.spoken).toEqual(['Only once.']);
    });

    it('reads only the new tail when a message grows', async () => {
        reader.onMessages('s1', [agentText('m1', 'First.')]);
        await settle();
        engine.finishOne();
        await settle();
        reader.onMessages('s1', [agentText('m1', 'First. Second.')]);
        await settle();
        expect(engine.spoken).toEqual(['First.', 'Second.']);
    });

    it('releases the audio session once the queue drains', async () => {
        reader.onMessages('s1', [agentText('m1', 'Just one sentence.')]);
        await settle();
        expect(engine.stops).toBe(0);
        engine.finishOne();
        await settle();
        expect(engine.stops).toBe(1);
    });

    it('keeps going when one utterance fails', async () => {
        const flaky: SpeechEngine = {
            spoken: [] as string[],
            speak(text: string) {
                (this as any).spoken.push(text);
                return (this as any).spoken.length === 1
                    ? Promise.reject(new Error('voice unavailable'))
                    : Promise.resolve();
            },
            stop() {},
        } as unknown as SpeechEngine;
        const other = new ReadAloudReader(flaky);
        other.setEnabled(true);
        other.focus('s1');
        other.onMessages('s1', [agentText('m1', 'One. Two.')]);
        await settle();
        expect((flaky as any).spoken).toEqual(['One.', 'Two.']);
    });

    describe('whole sentences only (DROVE-97)', () => {
        afterEach(() => { vi.useRealTimers(); });

        it('holds an unfinished tail until the message grows into a sentence', async () => {
            reader.onMessages('s1', [agentText('m1', 'The tests pass now. Two files')]);
            await settle();
            expect(engine.spoken).toEqual(['The tests pass now.']);
            engine.finishOne();
            await settle();
            // "Two files" is not a sentence yet, so nothing more is said.
            expect(engine.spoken).toEqual(['The tests pass now.']);

            reader.onMessages('s1', [agentText('m1', 'The tests pass now. Two files changed, e.g. the reducer. Nothing')]);
            await settle();
            expect(engine.spoken).toEqual(['The tests pass now.', 'Two files changed, e.g. the reducer.']);
        });

        it('speaks a held tail once a later message shows the reply moved on', async () => {
            reader.onMessages('s1', [agentText('m1', 'Done with the first part')]);
            await settle();
            expect(engine.spoken).toEqual([]);
            reader.onMessages('s1', [agentText('m2', 'Second part.', 2)]);
            await settle();
            expect(engine.spoken).toEqual(['Done with the first part']);
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Done with the first part', 'Second part.']);
        });

        it('speaks a held tail as it stands once the hold expires', async () => {
            vi.useFakeTimers();
            const held = new ReadAloudReader(engine, { holdMs: 500 });
            held.setEnabled(true);
            held.focus('s1');
            held.onMessages('s1', [agentText('m1', 'Almost there')]);
            await settle();
            expect(engine.spoken).toEqual([]);
            vi.advanceTimersByTime(499);
            await settle();
            expect(engine.spoken).toEqual([]);
            vi.advanceTimersByTime(1);
            await settle();
            expect(engine.spoken).toEqual(['Almost there']);
        });

        it('drops a held tail when interrupted', async () => {
            vi.useFakeTimers();
            const held = new ReadAloudReader(engine, { holdMs: 500 });
            held.setEnabled(true);
            held.focus('s1');
            held.onMessages('s1', [agentText('m1', 'Almost there')]);
            held.interrupt('typed');
            vi.advanceTimersByTime(1000);
            await settle();
            expect(engine.spoken).toEqual([]);
        });
    });

    /**
     * The cut, rewritten (DROVE-108).
     *
     * The tests here used to assert the DROVE-97 rule: a sentence that had
     * been waiting longer than the threshold was dropped. That fires on
     * every long reply, because speech is always slower than generation, so
     * the rule and its tests are replaced rather than deleted. What is
     * asserted now is the corrected rule: a finished turn is read to the
     * end, a still-arriving one may be cut when too much unspoken audio has
     * piled up, and a new turn abandons the old tail.
     *
     * 60 words a minute makes the arithmetic readable: one word is one
     * second of audio, so a four-second threshold is four words of backlog.
     */
    describe('skipping ahead (DROVE-108)', () => {
        let clock: number;

        function streamed(overrides: ReadAloudOptions = {}): ReadAloudReader {
            const made = new ReadAloudReader(engine, {
                now: () => clock,
                wordsPerMinute: 60,
                maxBacklogSeconds: () => 4,
                arrivalWindowMs: 4000,
                ...overrides,
            });
            made.setEnabled(true);
            made.focus('s1');
            return made;
        }

        beforeEach(() => { clock = 1_000_000; });

        it('reads a finished reply to the end, however far the voice falls behind', async () => {
            const talk = streamed();
            const said = sentences('Finished', 12);
            // 36 words against a 4 s threshold: nine times over, and spoken
            // three seconds a sentence, so the old rule cut this to pieces.
            talk.onMessages('s1', [agentText('m1', said.join(' '))]);
            await settle();
            for (let i = 1; i < said.length; i++) {
                clock += 3000;
                engine.finishOne();
                await settle();
            }
            expect(engine.spoken).toEqual(said);
            expect(talk.skipCount).toBe(0);
            expect(talk.pending).toBe(0);
        });

        it('cuts a turn that is still arriving once the backlog passes the threshold', async () => {
            const talk = streamed();
            talk.onMessages('s1', [agentText('m1', 'Streaming sentence 1. Streaming sentence 2.')]);
            await settle();
            expect(engine.spoken).toEqual(['Streaming sentence 1.']);

            // More of the same turn lands while the first sentence is still
            // being read: there IS something newer to be current with.
            clock += 3000;
            talk.onMessages('s1', [agentText('m2', 'Streaming sentence 3. Streaming sentence 4.', 2)]);
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Streaming sentence 1.', 'Skipping ahead.']);
            expect(talk.skipCount).toBe(1);

            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Streaming sentence 1.', 'Skipping ahead.', 'Streaming sentence 4.']);
            expect(talk.pending).toBe(0);
        });

        it('does not cut a big backlog once the turn has stopped arriving', async () => {
            const talk = streamed();
            talk.onMessages('s1', [agentText('m1', 'Streaming sentence 1. Streaming sentence 2.')]);
            await settle();
            clock += 3000;
            talk.onMessages('s1', [agentText('m2', 'Streaming sentence 3. Streaming sentence 4.', 2)]);

            // The turn ends here. Nothing arrives again, so what is left is
            // the answer itself and every word of it is read.
            clock += 5000;
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Streaming sentence 1.', 'Streaming sentence 2.']);
            for (let i = 0; i < 2; i++) {
                clock += 3000;
                engine.finishOne();
                await settle();
            }
            expect(engine.spoken).toEqual([
                'Streaming sentence 1.', 'Streaming sentence 2.',
                'Streaming sentence 3.', 'Streaming sentence 4.',
            ]);
            expect(talk.skipCount).toBe(0);
        });

        it('reads out one big block that lands after a pause, rather than cutting it', async () => {
            const talk = streamed();
            talk.onMessages('s1', [agentText('m1', 'Streaming sentence 1. Streaming sentence 2.')]);
            await settle();

            // A tool call ran, then the whole final answer landed at once.
            // Two batches, but not a stream: the gap is too long, and this
            // block is the answer rather than something to be current with.
            clock += 9000;
            talk.onMessages('s1', [agentText('m2', sentences('Final', 8).join(' '), 2)]);
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Streaming sentence 1.', 'Streaming sentence 2.']);
            for (let i = 0; i < 8; i++) {
                clock += 3000;
                engine.finishOne();
                await settle();
            }
            expect(engine.spoken).toEqual([
                'Streaming sentence 1.', 'Streaming sentence 2.', ...sentences('Final', 8),
            ]);
            expect(talk.skipCount).toBe(0);
        });

        it('never cuts once the session says it has stopped generating', async () => {
            let generating = true;
            const talk = streamed({ turnStillRunning: () => generating });
            talk.onMessages('s1', [agentText('m1', 'Streaming sentence 1. Streaming sentence 2.')]);
            await settle();
            clock += 3000;
            talk.onMessages('s1', [agentText('m2', 'Streaming sentence 3. Streaming sentence 4.', 2)]);

            // Same arrival pattern that cut two tests ago, but the agent has
            // finished, so there is nothing newer and every word is read.
            generating = false;
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Streaming sentence 1.', 'Streaming sentence 2.']);
            expect(talk.skipCount).toBe(0);
        });

        it('abandons the previous turn when a new one starts, and says so once', async () => {
            const talk = streamed({ maxBacklogSeconds: () => 30 });
            talk.onMessages('s1', [agentText('m1', sentences('Old', 4).join(' '))]);
            await settle();
            expect(engine.spoken).toEqual(['Old sentence 1.']);

            clock += 2000;
            talk.onMessages('s1', [userText('u1', 5), agentText('m2', 'New sentence 1. New sentence 2.', 6)]);
            await settle();
            // The old sentence was cut mid-word, not finished politely.
            expect(engine.stops).toBe(1);
            expect(engine.spoken).toEqual(['Old sentence 1.', 'Skipping ahead.']);

            engine.finishOne();
            await settle();
            // More of the SAME new turn says the marker no second time.
            clock += 1000;
            talk.onMessages('s1', [agentText('m3', 'New sentence 3.', 7)]);
            engine.finishOne();
            await settle();
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual([
                'Old sentence 1.', 'Skipping ahead.',
                'New sentence 1.', 'New sentence 2.', 'New sentence 3.',
            ]);
            expect(engine.spoken).not.toContain('Old sentence 2.');
            expect(talk.skipCount).toBe(1);
        });

        it('says nothing about skipping when the previous turn had already finished', async () => {
            const talk = streamed({ maxBacklogSeconds: () => 30 });
            talk.onMessages('s1', [agentText('m1', 'Old sentence 1.')]);
            await settle();
            engine.finishOne();
            await settle();

            clock += 2000;
            talk.onMessages('s1', [userText('u1', 5), agentText('m2', 'New sentence 1.', 6)]);
            await settle();
            expect(engine.spoken).toEqual(['Old sentence 1.', 'New sentence 1.']);
            expect(talk.skipCount).toBe(0);
        });

        it('speaks a lone sentence however far behind it is, having nothing to skip to', async () => {
            const talk = streamed();
            talk.onMessages('s1', [agentText('m1', 'Alone sentence 1.')]);
            await settle();
            clock += 3000;
            const long = 'This one sentence runs on for quite a while and takes ages to say.';
            talk.onMessages('s1', [agentText('m2', long, 2)]);
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Alone sentence 1.', long]);
            expect(talk.skipCount).toBe(0);
        });

        it('keeps reading in order while the backlog stays inside the threshold', async () => {
            const talk = streamed();
            talk.onMessages('s1', [agentText('m1', 'Short one. Short two.')]);
            await settle();
            clock += 1000;
            talk.onMessages('s1', [agentText('m2', 'Short three.', 2)]);
            engine.finishOne();
            await settle();
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Short one.', 'Short two.', 'Short three.']);
            expect(talk.skipCount).toBe(0);
        });

        it('reads faster instead of cutting, and never past the ceiling', async () => {
            const talk = streamed();
            talk.onMessages('s1', [agentText('m1', sentences('Long', 6).join(' '))]);
            await settle();
            // 18 s of audio against a 4 s threshold: the catch-up is capped.
            expect(engine.rates[0]).toBeCloseTo(defaultMaxRateScale, 5);
            for (let i = 0; i < 5; i++) {
                clock += 1000;
                engine.finishOne();
                await settle();
            }
            expect(engine.spoken).toEqual(sentences('Long', 6));
            // With only the last sentence left there is nothing to catch up on.
            expect(engine.rates[engine.rates.length - 1]).toBe(1);
            expect(engine.rates.every((rate) => rate <= defaultMaxRateScale)).toBe(true);
            expect(talk.skipCount).toBe(0);
        });

        it('reads the threshold live so a settings change applies to the next sentence', async () => {
            let threshold = 30;
            const talk = streamed({ maxBacklogSeconds: () => threshold });
            talk.onMessages('s1', [agentText('m1', sentences('Live', 4).join(' '))]);
            await settle();
            clock += 2000;
            talk.onMessages('s1', [agentText('m2', 'Live sentence 5.', 2)]);
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Live sentence 1.', 'Live sentence 2.']);

            threshold = 5;
            clock += 1000;
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Live sentence 1.', 'Live sentence 2.', 'Skipping ahead.']);
            expect(talk.skipCount).toBe(1);
        });
    });
});

/**
 * Every way speech can be cut has to reach a capture listener, with the
 * reason (DROVE-30). The mic hangs off this, so a path that cut speech
 * without notifying would be a latched mic left hot.
 */
describe('ReadAloudReader interrupt listeners', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;
    let heard: string[];

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        heard = [];
        reader.addInterruptListener((reason) => heard.push(reason));
    });

    it('hears a direct interrupt even while nothing is speaking', () => {
        reader.interrupt('typed');
        reader.interrupt('sent');
        expect(heard).toEqual(['typed', 'sent']);
        // And the engine was never asked to stop, because it never started.
        expect(engine.stops).toBe(0);
    });

    it('hears focus moving, losing focus, and the toggle going off', () => {
        reader.setEnabled(true);
        reader.focus('s1');
        reader.focus('s2');
        reader.blur('s2');
        reader.setEnabled(false);
        expect(heard).toEqual(['switched-session', 'switched-session', 'left-session', 'toggled-off']);
        // Turning it off when it is already off cuts nothing and says nothing.
        reader.setEnabled(false);
        expect(heard).toHaveLength(4);
    });

    it('carries the reason a call started and the mic was pressed', () => {
        reader.interrupt('call-started');
        reader.interrupt('mic');
        expect(heard).toEqual(['call-started', 'mic']);
    });

    it('keeps notifying the rest when one listener throws', () => {
        const after: string[] = [];
        reader.addInterruptListener(() => { throw new Error('boom'); });
        reader.addInterruptListener((reason) => after.push(reason));
        reader.interrupt('typed');
        expect(after).toEqual(['typed']);
    });

    it('stops notifying after the unsubscribe', () => {
        const late: string[] = [];
        const off = reader.addInterruptListener((reason) => late.push(reason));
        reader.interrupt('typed');
        off();
        reader.interrupt('sent');
        expect(late).toEqual(['typed']);
    });
});

/**
 * The transcript as a playhead (DROVE-114).
 *
 * Clay: "If I scroll down you would start reading from there, so whatever
 * you're reading is always visible. When I scroll you jump down to where I
 * scrolled, or you jump up if I scroll up." And: "Go up to something you
 * already said, and you just wait till I scroll back down."
 *
 * So the reading position and the scroll position are one thing. What is
 * asserted here is the queue's half of that: it can be moved backwards as
 * well as forwards, it stops at the bottom of the screen instead of running
 * past it, and nothing is thrown away when it does.
 */
describe('the transcript as a playhead (DROVE-114)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    /** Three messages, three sentences each, one stamp apart. */
    function seedThree(into: ReadAloudReader): void {
        into.onMessages('s1', [
            agentText('m1', sentences('First', 3).join(' '), 1),
            agentText('m2', sentences('Second', 3).join(' '), 2),
            agentText('m3', sentences('Third', 3).join(' '), 3),
        ]);
    }

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
    });

    it('seeks forwards: scrolling down reads from what is now visible', async () => {
        seedThree(reader);
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.']);

        reader.seekTo(3);
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.', 'Third sentence 1.']);
        expect(reader.playhead?.messageId).toBe('m3');
    });

    it('seeks backwards: scrolling up re-reads something already said', async () => {
        seedThree(reader);
        await settle();
        reader.seekTo(3);
        await settle();

        reader.seekTo(1);
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.', 'Third sentence 1.', 'First sentence 1.']);
        expect(reader.playhead?.messageId).toBe('m1');
    });

    it('a seek into the message being read does not restart it', async () => {
        seedThree(reader);
        await settle();
        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.', 'First sentence 2.']);
        const stops = engine.stops;

        // The list reports its top row on every scroll frame. If that could
        // rewind the message being read, the same sentence would stutter for
        // ever. This is the reader's half of the no-feedback-loop property.
        reader.seekTo(1);
        reader.seekTo(1);
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.', 'First sentence 2.']);
        expect(engine.stops).toBe(stops);
    });

    it('reads only as far as the screen reaches, and waits there', async () => {
        reader.setReadableThrough(1);
        seedThree(reader);
        await settle();
        engine.finishOne();
        await settle();
        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(sentences('First', 3));

        // Parked. The rest is not lost, it is waiting below the fold.
        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(sentences('First', 3));
        expect(reader.pending).toBe(6);
        expect(reader.playhead).toBeNull();
    });

    it('resumes from the unread tail when the view comes back down', async () => {
        reader.setReadableThrough(1);
        seedThree(reader);
        await settle();
        for (let i = 0; i < 3; i++) { engine.finishOne(); await settle(); }
        expect(engine.spoken).toEqual(sentences('First', 3));

        reader.setReadableThrough(null);
        await settle();
        expect(engine.spoken).toEqual([...sentences('First', 3), 'Second sentence 1.']);
    });

    it('new content arriving while the view is parked in the history does not move reading', async () => {
        let clock = 1_000_000;
        const talk = new ReadAloudReader(engine, {
            now: () => clock,
            wordsPerMinute: 60,
            maxBacklogSeconds: () => 4,
        });
        talk.setEnabled(true);
        talk.focus('s1');
        // The user is looking at the oldest message.
        talk.setReadableThrough(1);
        talk.onMessages('s1', [agentText('m1', 'First sentence 1. First sentence 2.', 1)]);
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.']);

        // A reply lands, still streaming, far more than the threshold of it.
        clock += 3000;
        talk.onMessages('s1', [agentText('m2', sentences('Second', 4).join(' '), 2)]);
        engine.finishOne();
        await settle();

        // No cut, no jump: reading carries on where the user is looking.
        expect(engine.spoken).toEqual(['First sentence 1.', 'First sentence 2.']);
        expect(talk.skipCount).toBe(0);

        engine.finishOne();
        await settle();
        expect(talk.playhead).toBeNull();
        expect(talk.pending).toBe(4);

        // And when the view comes down, all four are still there, in order.
        talk.setReadableThrough(2);
        await settle();
        for (let i = 0; i < 3; i++) { engine.finishOne(); await settle(); }
        expect(engine.spoken).toEqual([
            'First sentence 1.',
            'First sentence 2.',
            ...sentences('Second', 4),
        ]);
    });

    it('publishes the sentence at the engine, with the message it came from', async () => {
        const seen: (string | null)[] = [];
        reader.addPlayheadListener((playhead) => seen.push(playhead === null ? null : `${playhead.messageId}:${playhead.sentence}`));
        seedThree(reader);
        await settle();
        engine.finishOne();
        await settle();
        expect(seen).toEqual(['m1:First sentence 1.', 'm1:First sentence 2.']);
        expect(reader.playhead?.turn).toBe(0);
    });

    it('clears the marking the moment speech is interrupted', async () => {
        seedThree(reader);
        await settle();
        expect(reader.playhead).not.toBeNull();

        reader.interrupt('typed');
        expect(reader.playhead).toBeNull();
        expect(reader.pending).toBe(0);
    });

    it('an interrupted transcript can still be scrolled back into and re-read', async () => {
        seedThree(reader);
        await settle();
        reader.interrupt('typed');
        await settle();

        reader.seekTo(2);
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.', 'Second sentence 1.']);
    });

    it('marks nothing while it is saying the skip marker', async () => {
        let clock = 1_000_000;
        const talk = new ReadAloudReader(engine, {
            now: () => clock,
            wordsPerMinute: 60,
            maxBacklogSeconds: () => 4,
        });
        talk.setEnabled(true);
        talk.focus('s1');
        talk.onMessages('s1', [agentText('m1', 'Streaming sentence 1. Streaming sentence 2.', 1)]);
        await settle();
        clock += 3000;
        talk.onMessages('s1', [agentText('m2', sentences('Second', 4).join(' '), 2)]);
        engine.finishOne();
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Skipping ahead.');
        expect(talk.playhead).toBeNull();

        engine.finishOne();
        await settle();
        expect(talk.playhead?.messageId).toBe('m2');
    });

    it('keeps a read position while idle, so a later scroll knows where it was', async () => {
        seedThree(reader);
        await settle();
        expect(reader.readPosition).toBe(1);

        reader.seekTo(3);
        await settle();
        reader.interrupt('sent');
        expect(reader.playhead).toBeNull();
        expect(reader.readPosition).toBe(3);
    });
});
