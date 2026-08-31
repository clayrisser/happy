import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { catchUpScale, defaultMaxRateScale, ReadAloudReader, type ReadAloudOptions, type SpeakOptions, type SpeechEngine } from './readAloud';

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
            const talk = streamed({ jumpBacklogSeconds: () => 40 });
            talk.onMessages('s1', [agentText('m1', sentences('Long', 6).join(' '))]);
            await settle();
            // 18 s of audio against a 4 s threshold, but it landed whole, so
            // nothing is being fallen behind yet (DROVE-177).
            expect(engine.rates[0]).toBe(1);
            // Now it is a stream, and inside the band: faster, not cut.
            clock += 1000;
            talk.onMessages('s1', [agentText('m2', 'Long sentence 7.', 2)]);
            for (let i = 0; i < 6; i++) {
                engine.finishOne();
                await settle();
                clock += 1000;
            }
            expect(engine.spoken).toEqual(sentences('Long', 7));
            expect(engine.rates[1]).toBeGreaterThan(1);
            // With only the last sentence left there is nothing to catch up on.
            expect(engine.rates[engine.rates.length - 1]).toBe(1);
            expect(engine.rates.every((rate) => rate <= defaultMaxRateScale)).toBe(true);
            expect(talk.skipCount).toBe(0);
        });

        it('reads both thresholds live so a settings change applies to the next sentence', async () => {
            let jump = 30;
            const talk = streamed({ maxBacklogSeconds: () => 4, jumpBacklogSeconds: () => jump });
            talk.onMessages('s1', [agentText('m1', sentences('Live', 4).join(' '))]);
            await settle();
            clock += 2000;
            talk.onMessages('s1', [agentText('m2', 'Live sentence 5.', 2)]);
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Live sentence 1.', 'Live sentence 2.']);

            jump = 5;
            clock += 1000;
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Live sentence 1.', 'Live sentence 2.', 'Skipping ahead.']);
            expect(talk.skipCount).toBe(1);
        });

        /**
         * DROVE-116, and the reason catch-up never once saved a jump. The cut
         * used to fire at the SAME number the ramp started at, so the band the
         * ramp was described as running through did not exist: past the
         * threshold the tail was thrown away rather than read faster.
         */
        describe('speeding up before jumping (DROVE-116)', () => {
            it('reads faster right through the band between the two thresholds', async () => {
                const talk = streamed({ maxBacklogSeconds: () => 4, jumpBacklogSeconds: () => 40 });
                // 18 s of audio: well past the speed-up threshold and nowhere
                // near the jump, which is exactly where the old code cut.
                talk.onMessages('s1', [agentText('m1', sentences('Long', 6).join(' '))]);
                await settle();
                clock += 1000;
                talk.onMessages('s1', [agentText('m2', sentences('More', 6).join(' '), 2)]);
                engine.finishOne();
                await settle();

                expect(talk.skipCount).toBe(0);
                expect(engine.rates.some((rate) => rate > 1)).toBe(true);
                expect(engine.spoken).toEqual(['Long sentence 1.', 'Long sentence 2.']);
            });

            it('jumps only once the backlog passes the jump threshold', async () => {
                const talk = streamed({ maxBacklogSeconds: () => 4, jumpBacklogSeconds: () => 10 });
                talk.onMessages('s1', [agentText('m1', sentences('Long', 6).join(' '))]);
                await settle();
                clock += 1000;
                // 15 more words on top of what is left: past 10 s, so the cut.
                talk.onMessages('s1', [agentText('m2', sentences('More', 5).join(' '), 2)]);
                engine.finishOne();
                await settle();
                expect(talk.skipCount).toBe(1);
            });

            it('ramps from 1 at the speed-up threshold to the ceiling at the jump, while the stream is live', async () => {
                const rates: number[] = [];
                const talk = streamed({
                    maxBacklogSeconds: () => 4,
                    jumpBacklogSeconds: () => 40,
                    maxRateScale: () => 2,
                });
                // Thirteen sentences, three words each, landing whole: 39 s
                // of audio and nothing streaming, so the first is read at 1
                // (DROVE-177), however far over the speed-up threshold it is.
                talk.onMessages('s1', [agentText('m1', sentences('Ramp', 13).join(' '))]);
                await settle();
                expect(engine.rates[0]).toBe(1);

                // A second batch a second later makes it a stream. 36 s of the
                // first is left and this adds 4: exactly the jump threshold,
                // so the top of the ramp and no cut.
                clock += 1000;
                talk.onMessages('s1', [agentText('m2', 'Ramp sentence number fourteen.', 2)]);
                for (let i = 0; i < 13; i++) {
                    engine.finishOne();
                    await settle();
                    rates.push(engine.rates[engine.rates.length - 1]);
                }
                expect(talk.skipCount).toBe(0);
                expect(rates[0]).toBe(2);
                // Monotonically down as the backlog drains, and back to 1 once
                // there is no more than the speed-up threshold left to say.
                for (let i = 1; i < rates.length; i++) {
                    expect(rates[i]).toBeLessThanOrEqual(rates[i - 1]);
                }
                expect(rates[rates.length - 1]).toBe(1);
            });

            /**
             * Clay, an hour after DROVE-116 shipped: "why are you talking so
             * fast when not behind" (DROVE-177). The ramp had no arrival guard,
             * so any reply over the speed-up threshold was read fast from its
             * first sentence, finished or not.
             */
            it('reads a reply that landed whole at the normal rate, however long it is', async () => {
                const talk = streamed({ maxBacklogSeconds: () => 4, jumpBacklogSeconds: () => 40, maxRateScale: () => 2 });
                // 30 s of audio against a 4 s speed-up threshold, in one piece.
                const said = sentences('Whole', 10);
                talk.onMessages('s1', [agentText('m1', said.join(' '))]);
                await settle();
                for (let i = 1; i < said.length; i++) {
                    clock += 3000;
                    engine.finishOne();
                    await settle();
                }
                expect(engine.spoken).toEqual(said);
                expect(engine.rates).toEqual(said.map(() => 1));
                expect(talk.skipCount).toBe(0);
            });

            it('drops back to the normal rate as soon as the stream stops', async () => {
                const talk = streamed({ maxBacklogSeconds: () => 4, jumpBacklogSeconds: () => 100, maxRateScale: () => 2 });
                talk.onMessages('s1', [agentText('m1', sentences('Live', 8).join(' '))]);
                await settle();
                clock += 1000;
                talk.onMessages('s1', [agentText('m2', sentences('More', 8).join(' '), 2)]);
                engine.finishOne();
                await settle();
                expect(engine.rates[1]).toBeGreaterThan(1);

                // Past the arrival window with nothing new: the 40-odd seconds
                // still queued are the answer, and they are read at 1.
                clock += 5000;
                engine.finishOne();
                await settle();
                expect(engine.rates[2]).toBe(1);
            });

            it('ends the catch-up the moment the agent finishes', async () => {
                let running = true;
                const talk = streamed({
                    maxBacklogSeconds: () => 4,
                    jumpBacklogSeconds: () => 100,
                    maxRateScale: () => 2,
                    turnStillRunning: () => running,
                });
                talk.onMessages('s1', [agentText('m1', sentences('Live', 8).join(' '))]);
                await settle();
                clock += 1000;
                talk.onMessages('s1', [agentText('m2', sentences('More', 8).join(' '), 2)]);
                engine.finishOne();
                await settle();
                expect(engine.rates[1]).toBeGreaterThan(1);

                running = false;
                engine.finishOne();
                await settle();
                expect(engine.rates[2]).toBe(1);
            });

            /**
             * The ceiling is read per pump, not captured in the constructor,
             * so dragging either speed slider applies to the next sentence.
             */
            it('reads the ceiling live', async () => {
                let ceiling = 1;
                const talk = streamed({ maxBacklogSeconds: () => 4, jumpBacklogSeconds: () => 40, maxRateScale: () => ceiling });
                talk.onMessages('s1', [agentText('m1', sentences('Live', 8).join(' '))]);
                await settle();
                expect(engine.rates[0]).toBe(1);

                ceiling = 1.5;
                clock += 1000;
                talk.onMessages('s1', [agentText('m2', 'Live sentence 9.', 2)]);
                engine.finishOne();
                await settle();
                expect(engine.rates[1]).toBeGreaterThan(1);
            });
        });
    });

    /**
     * The ramp's shape with the shipped numbers: speed up at 15 s, jump at
     * 45 s, and 0.78 over 0.52 as the ceiling (DROVE-177, checking DROVE-116).
     */
    describe('catchUpScale', () => {
        const scale = 0.78 / 0.52;

        it('is exactly 1 at and below the speed-up threshold, backlog of zero included', () => {
            expect(catchUpScale(0, 15, 45, scale)).toBe(1);
            expect(catchUpScale(7.5, 15, 45, scale)).toBe(1);
            expect(catchUpScale(15, 15, 45, scale)).toBe(1);
        });

        it('starts strictly above the speed-up threshold', () => {
            expect(catchUpScale(15.01, 15, 45, scale)).toBeGreaterThan(1);
            expect(catchUpScale(15.01, 15, 45, scale)).toBeLessThan(1.001);
        });

        it('is halfway up the band halfway between the thresholds', () => {
            expect(catchUpScale(30, 15, 45, scale)).toBeCloseTo(1.25, 10);
        });

        it('reaches the catch-up rate only at the jump threshold, and holds there', () => {
            expect(catchUpScale(44.99, 15, 45, scale)).toBeLessThan(scale);
            expect(catchUpScale(45, 15, 45, scale)).toBeCloseTo(scale, 10);
            expect(catchUpScale(90, 15, 45, scale)).toBeCloseTo(scale, 10);
        });
    });

    /**
     * Sending a message must not open a hole (DROVE-122). DROVE-108's cut is
     * right, it just used to fire a model's worth of latency too early: at the
     * moment the user's text lands there is nothing of the answer to move to.
     */
    describe('no silent gap when a message is sent (DROVE-122)', () => {
        it('keeps reading the old reply while the new turn has nothing to say yet', async () => {
            reader.onMessages('s1', [agentText('m1', sentences('Old', 4).join(' '))]);
            await settle();
            expect(engine.spoken).toEqual(['Old sentence 1.']);

            // Send, then the user's own message lands in the transcript and
            // opens the turn. Neither is a reason to stop talking.
            reader.userSent();
            reader.onMessages('s1', [userText('u1', 5)]);
            await settle();
            expect(engine.stops).toBe(0);
            expect(engine.spoken).toEqual(['Old sentence 1.']);

            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Old sentence 1.', 'Old sentence 2.']);
            expect(reader.skipCount).toBe(0);
        });

        it('cuts on the new turn\'s first speakable sentence, with one marker', async () => {
            reader.onMessages('s1', [agentText('m1', sentences('Old', 4).join(' '))]);
            await settle();
            reader.userSent();
            reader.onMessages('s1', [userText('u1', 5)]);
            await settle();
            expect(engine.spoken).toEqual(['Old sentence 1.']);

            reader.onMessages('s1', [agentText('m2', 'New sentence 1. New sentence 2.', 6)]);
            await settle();
            // Cut mid-word, and the marker said exactly once.
            expect(engine.stops).toBe(1);
            expect(engine.spoken).toEqual(['Old sentence 1.', 'Skipping ahead.']);

            engine.finishOne();
            await settle();
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual([
                'Old sentence 1.', 'Skipping ahead.',
                'New sentence 1.', 'New sentence 2.',
            ]);
            expect(engine.spoken).not.toContain('Old sentence 2.');
            expect(reader.skipCount).toBe(1);
        });

        it('rests rather than reading anything stale when the old reply drains first', async () => {
            reader.onMessages('s1', [agentText('m1', 'Old sentence 1.')]);
            await settle();
            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['Old sentence 1.']);

            reader.userSent();
            reader.onMessages('s1', [userText('u1', 5)]);
            await settle();
            // Nothing left to say, so nothing is said, and no marker is owed.
            expect(engine.spoken).toEqual(['Old sentence 1.']);

            reader.onMessages('s1', [agentText('m2', 'New sentence 1.', 6)]);
            await settle();
            expect(engine.spoken).toEqual(['Old sentence 1.', 'New sentence 1.']);
            expect(reader.skipCount).toBe(0);
        });

        it('still tells every capture that the message was sent', () => {
            const heard: string[] = [];
            reader.addInterruptListener((reason) => heard.push(reason));
            reader.userSent();
            expect(heard).toEqual(['sent']);
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
 * The transcript as a playhead (DROVE-114), moved by a tap (DROVE-146).
 *
 * DROVE-114 read Clay's "if I scroll down you would start reading from there"
 * as one position shared by the voice and the viewport. He has since settled
 * it the other way: "It will go back up if you double tap. Double tap a
 * section and that's what changes the reading, not scrolling."
 *
 * So the queue still has a playhead that moves backwards as well as forwards.
 * What moves it is a gesture, and nothing else can stop it: there is no bound
 * on how far reading may run any more, which is why a stale viewport cannot
 * silence read-aloud (DROVE-146).
 */
describe('the transcript as a playhead (DROVE-114, DROVE-146)', () => {
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

    it('reads on from a tap further down', async () => {
        seedThree(reader);
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.']);

        reader.seekTo(3);
        await settle();
        expect(engine.spoken).toEqual(['First sentence 1.', 'Third sentence 1.']);
        expect(reader.playhead?.messageId).toBe('m3');
    });

    /**
     * A tap outranks DROVE-126, and that is the whole difference between a
     * gesture and a scroll frame. "It will go back up if you double tap": the
     * section is read again because being asked is the exception the no-repeat
     * invariant was always missing.
     */
    it('reads a section again when it is tapped', async () => {
        seedThree(reader);
        await settle();
        for (let i = 0; i < 2; i++) { engine.finishOne(); await settle(); }
        expect(engine.spoken).toEqual(sentences('First', 3));

        reader.seekTo(1);
        await settle();
        expect(engine.spoken).toEqual([...sentences('First', 3), 'First sentence 1.']);
        expect(reader.playhead?.messageId).toBe('m1');
    });

    it('leaves reading alone when there is nothing sayable at the tap', async () => {
        seedThree(reader);
        await settle();
        const spoken = [...engine.spoken];
        const stops = engine.stops;

        // A tool card below the last thing anyone said.
        reader.seekTo(99);
        await settle();
        expect(engine.spoken).toEqual(spoken);
        expect(engine.stops).toBe(stops);
    });

    /**
     * The case that took read-aloud out entirely (DROVE-146). A reply lands
     * while the user sits at the bottom and never touches the scroll view, and
     * nothing on the outside is consulted about whether it may be read.
     */
    it('reads every reply that arrives, with no viewport feed at all', async () => {
        const expected: string[] = [];
        for (let i = 1; i <= 4; i++) {
            expected.push(...sentences(`Block${i}`, 2));
            reader.onMessages('s1', [agentText(`m${i}`, sentences(`Block${i}`, 2).join(' '), i)]);
            await settle();
            engine.finishOne();
            await settle();
        }
        for (let i = 0; i < 8; i++) { engine.finishOne(); await settle(); }
        expect(engine.spoken).toEqual(expected);
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

    it('an interrupted transcript can still be tapped into and re-read', async () => {
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

    it('keeps a read position while idle, so a later tap knows where it was', async () => {
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

/**
 * A sentence is never spoken twice on the queue's own initiative (DROVE-126).
 *
 * Clay: "you keep repeating things when you're reading things back. You stop,
 * then another message comes in and you read it back, and you end up reading
 * the same message again."
 *
 * The repeat came out of DROVE-114's scroll seek landing back on the first
 * sentence of a message already read out. That seek is gone (DROVE-146), so
 * the invariant now only has to hold against what the queue does by itself:
 * an interruption, a new turn, a reply arriving in blocks. A double tap is
 * the user asking, and is tested above.
 */
describe('a sentence is never spoken twice on its own (DROVE-126)', () => {
    let engine: FakeEngine;
    let reader: ReadAloudReader;

    function duplicatesIn(said: readonly string[]): string[] {
        return said.filter((text, i) => said.indexOf(text) !== i);
    }

    beforeEach(() => {
        engine = new FakeEngine();
        reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
    });

    it('says each sentence exactly once across a stop and new content', async () => {
        reader.onMessages('s1', [agentText('m1', sentences('First', 3).join(' '), 1)]);
        await settle();
        for (let i = 0; i < 3; i++) { engine.finishOne(); await settle(); }
        expect(engine.spoken).toEqual(sentences('First', 3));

        reader.userSent();
        reader.onMessages('s1', [userText('u1', 2), agentText('m2', sentences('Second', 3).join(' '), 3)]);
        await settle();
        for (let i = 0; i < 4; i++) { engine.finishOne(); await settle(); }

        expect(duplicatesIn(engine.spoken)).toEqual([]);
        expect(engine.spoken.filter((t) => t.startsWith('First'))).toEqual(sentences('First', 3));
    });

    /**
     * The mic and the reader share one AVAudioSession, and dictation loses the
     * fight (DROVE-143). `interrupt('mic')` cuts the sentence in flight, but
     * the reader is a QUEUE: a reply still streaming in enqueues another
     * sentence a moment later, that pumps, that speaks, and every speak sets
     * the session to `.playback`. The recogniser then reads its input format
     * in the wrong category and the native guard refuses the capture, which
     * from outside is an alert and a mic button that will not stay open.
     */
    describe('while the microphone holds the audio session', () => {
        it('says nothing, and stops what was already speaking', async () => {
            reader.onMessages('s1', [agentText('m1', 'One. Two. Three.')]);
            await settle();
            expect(engine.spoken).toEqual(['One.']);

            reader.setMicHeld(true);
            expect(reader.isMicHeld).toBe(true);
            // The session goes back, rather than a paused utterance keeping it.
            expect(engine.stops).toBe(1);

            engine.finishOne();
            await settle();
            expect(engine.spoken).toEqual(['One.']);
        });

        it('stays silent while a reply keeps arriving, and reads it after', async () => {
            reader.setMicHeld(true);
            reader.onMessages('s1', [agentText('m1', 'Arrived while the mic was open.')]);
            await settle();
            expect(engine.spoken).toEqual([]);

            reader.setMicHeld(false);
            await settle();
            expect(engine.spoken).toEqual(['Arrived while the mic was open.']);
        });

        it('picks up where it left off rather than losing what it had not said', async () => {
            reader.onMessages('s1', [agentText('m1', 'One. Two. Three.')]);
            await settle();
            reader.setMicHeld(true);
            await settle();

            reader.setMicHeld(false);
            await settle();
            // Two follows One: the position was held, not thrown away.
            expect(engine.spoken).toEqual(['One.', 'Two.']);
        });

        it('is idempotent, so a second hold does not stop anything twice', async () => {
            reader.onMessages('s1', [agentText('m1', 'One. Two.')]);
            await settle();
            reader.setMicHeld(true);
            const stops = engine.stops;
            reader.setMicHeld(true);
            expect(engine.stops).toBe(stops);
        });

        it('the whole capture is covered, cut and gate together, the way the composer drives it', async () => {
            reader.onMessages('s1', [agentText('m1', 'One. Two. Three.')]);
            await settle();
            // useVoiceComposer's mic-open effect, in order.
            reader.setMicHeld(true);
            reader.interrupt('mic');
            // The reply is still being written while he talks.
            reader.onMessages('s1', [agentText('m2', 'Still writing.', 2)]);
            await settle();
            expect(engine.spoken).toEqual(['One.']);

            reader.setMicHeld(false);
            await settle();
            expect(engine.spoken).toEqual(['One.', 'Still writing.']);
        });
    });

    it('does not re-read the tail of a reply that was cut by a new turn', async () => {
        reader.onMessages('s1', [agentText('m1', sentences('Old', 4).join(' '), 1)]);
        await settle();
        reader.userSent();
        reader.onMessages('s1', [userText('u1', 2), agentText('m2', sentences('New', 2).join(' '), 3)]);
        await settle();
        for (let i = 0; i < 4; i++) { engine.finishOne(); await settle(); }

        expect(duplicatesIn(engine.spoken)).toEqual([]);
        expect(engine.spoken.filter((t) => t === 'Old sentence 1.')).toHaveLength(1);
    });

    it('does not re-read a reply that arrives in blocks', async () => {
        reader.onMessages('s1', [agentText('m1', 'Part one lands.', 1)]);
        await settle();
        reader.onMessages('s1', [agentText('m1', 'Part one lands. Part two lands.', 1)]);
        await settle();
        for (let i = 0; i < 3; i++) { engine.finishOne(); await settle(); }

        expect(engine.spoken).toEqual(['Part one lands.', 'Part two lands.']);
    });
});
