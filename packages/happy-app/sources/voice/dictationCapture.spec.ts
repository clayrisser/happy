import { beforeEach, describe, expect, it } from 'vitest';
import { DictationCapture, type DictationCaptureState, type DictationEngine } from './dictationCapture';
import { DICTATION_LATCH_IDLE_MS } from './micMode';

/** A recogniser the test drives by hand. */
class FakeRecogniser implements DictationEngine {
    starts = 0;
    stops = 0;
    cancels = 0;
    startFails: string | null = null;
    private stopResolvers: ((text: string) => void)[] = [];

    start(): Promise<unknown> {
        this.starts += 1;
        if (this.startFails) return Promise.reject(new Error(this.startFails));
        return Promise.resolve(true);
    }

    stop(): Promise<string> {
        this.stops += 1;
        return new Promise<string>((resolve) => { this.stopResolvers.push(resolve); });
    }

    cancel(): void {
        this.cancels += 1;
    }

    /** The final transcript lands. */
    settle(text: string): void {
        const resolve = this.stopResolvers.shift();
        resolve?.(text);
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('DictationCapture', () => {
    let clock: number;
    let engine: FakeRecogniser;
    let commits: { text: string; send: boolean; reason: string }[];
    let partials: string[];
    let discards: string[];
    let errors: string[];
    let states: DictationCaptureState[];
    let capture: DictationCapture;

    beforeEach(() => {
        clock = 1_000;
        engine = new FakeRecogniser();
        commits = [];
        partials = [];
        discards = [];
        errors = [];
        states = [];
        capture = new DictationCapture(engine, {
            onCommit: (text, send, reason) => commits.push({ text, send, reason }),
            onPartial: (text) => partials.push(text),
            onDiscard: (reason) => discards.push(reason),
            onError: (message) => errors.push(message),
            onChange: (state) => states.push(state),
        }, () => clock);
    });

    describe('hold to talk', () => {
        it('records while held and sends on the lift', async () => {
            capture.begin('hold');
            await flush();
            expect(engine.starts).toBe(1);
            expect(capture.current.active).toBe(true);
            expect(capture.current.mode).toBe('hold');
            // A finger on the button is the timeout.
            expect(capture.current.idleAt).toBeNull();

            capture.send();
            expect(capture.current.active).toBe(false);
            await flush();
            engine.settle('run the tests');
            await flush();
            expect(commits).toEqual([{ text: 'run the tests', send: true, reason: 'send' }]);
        });

        it('never stops itself however long it is held', async () => {
            capture.begin('hold');
            await flush();
            clock += 10 * DICTATION_LATCH_IDLE_MS;
            capture.tick();
            expect(capture.current.active).toBe(true);
            expect(engine.stops).toBe(0);
        });

        it('sends nothing and says so when nothing was heard', async () => {
            capture.begin('hold');
            await flush();
            capture.send();
            await flush();
            engine.settle('   ');
            await flush();
            expect(commits).toEqual([]);
            expect(discards).toEqual(['send']);
        });

        it('reports a recogniser that will not start, and is idle again', async () => {
            engine.startFails = 'microphone access was denied';
            capture.begin('hold');
            await flush();
            expect(errors).toEqual(['microphone access was denied']);
            expect(capture.current.active).toBe(false);
        });
    });

    describe('latch', () => {
        it('a hold becomes a latch on latch(), and the idle clock starts then', async () => {
            capture.begin('hold');
            await flush();
            expect(capture.current.idleAt).toBeNull();
            clock += 200;
            capture.latch();
            expect(capture.current.mode).toBe('latch');
            expect(capture.current.idleAt).toBe(clock + DICTATION_LATCH_IDLE_MS);
            // The same microphone: no second start.
            expect(engine.starts).toBe(1);
        });

        it('stays on until the second tap, which stops WITHOUT sending (DROVE-105)', async () => {
            capture.begin('latch');
            await flush();
            expect(capture.current.active).toBe(true);
            expect(capture.current.idleAt).toBe(clock + DICTATION_LATCH_IDLE_MS);

            clock += 4_000;
            capture.tick();
            expect(capture.current.active).toBe(true);

            capture.stop();
            await flush();
            engine.settle('open the file');
            await flush();
            expect(commits).toEqual([{ text: 'open the file', send: false, reason: 'stop' }]);
        });

        it('stops itself after the idle timeout and does NOT send', async () => {
            capture.begin('latch');
            await flush();
            capture.partial('deploy it');
            clock += DICTATION_LATCH_IDLE_MS;
            capture.tick();
            expect(capture.current.active).toBe(false);
            await flush();
            engine.settle('deploy it');
            await flush();
            expect(commits).toEqual([{ text: 'deploy it', send: false, reason: 'idle' }]);
        });

        it('counts idle from the last change to the transcript, not from the start', async () => {
            capture.begin('latch');
            await flush();
            clock += DICTATION_LATCH_IDLE_MS - 1_000;
            capture.partial('still talking');
            clock += 2_000;
            capture.tick();
            // Two seconds after the last word is not idle.
            expect(capture.current.active).toBe(true);
            clock += DICTATION_LATCH_IDLE_MS;
            capture.tick();
            expect(capture.current.active).toBe(false);
        });

        it('does not reset the idle clock on a partial that says nothing new', async () => {
            capture.begin('latch');
            await flush();
            const deadline = capture.current.idleAt;
            clock += 3_000;
            capture.partial('');
            expect(capture.current.idleAt).toBe(deadline);
        });

        it('latch() on an already latched mic changes nothing', async () => {
            capture.begin('latch');
            await flush();
            const deadline = capture.current.idleAt;
            clock += 3_000;
            capture.latch();
            expect(capture.current.idleAt).toBe(deadline);
        });
    });

    describe('partials', () => {
        it('exposes what it is hearing, and tells the composer each revision', async () => {
            capture.begin('hold');
            await flush();
            capture.partial('rename the');
            capture.partial('rename the branch');
            capture.partial('rename the branch');
            expect(capture.current.transcript).toBe('rename the branch');
            expect(capture.current.since).toBe(1_000);
            // The repeat is not a revision.
            expect(partials).toEqual(['rename the', 'rename the branch']);
        });

        it('ignores a partial that lands after the capture ended', () => {
            capture.partial('ghost');
            expect(partials).toEqual([]);
        });
    });

    describe('anything that stops speech stops capture', () => {
        it('keeps the words, unsent, when the user starts typing', async () => {
            capture.begin('latch');
            await flush();
            capture.interrupt('typed');
            expect(capture.current.active).toBe(false);
            await flush();
            engine.settle('half a thought');
            await flush();
            expect(commits).toEqual([{ text: 'half a thought', send: false, reason: 'typed' }]);
        });

        it.each(['sent', 'left-session', 'switched-session', 'toggled-off', 'call-started'] as const)(
            'drops the recording on %s',
            async (reason) => {
                capture.begin('latch');
                await flush();
                capture.interrupt(reason);
                expect(capture.current.active).toBe(false);
                expect(engine.cancels).toBe(1);
                expect(engine.stops).toBe(0);
                expect(commits).toEqual([]);
                expect(discards).toEqual([reason]);
            },
        );

        it('cuts a held mic the same way', async () => {
            capture.begin('hold');
            await flush();
            capture.interrupt('left-session');
            expect(capture.current.active).toBe(false);
            expect(engine.cancels).toBe(1);
            // The lift that follows has nothing to do.
            capture.send();
            expect(engine.stops).toBe(0);
        });

        it('is a no-op while nothing is recording', () => {
            capture.interrupt('typed');
            capture.interrupt('mic');
            expect(engine.cancels).toBe(0);
            expect(engine.stops).toBe(0);
            expect(discards).toEqual([]);
        });
    });

    /**
     * The recogniser giving up. A `final` is a PAUSE and reopens the
     * microphone instead of ending anything; that half lives in
     * dictationContinuity.spec.ts (DROVE-140). These are the endings that
     * really are endings: an error, or a reason nothing recognises.
     */
    describe('the recogniser ending on its own', () => {
        it('ends the latch with the words kept and unsent', async () => {
            capture.begin('latch');
            await flush();
            capture.recogniserEnded('that is all', 'No speech detected');
            expect(capture.current.active).toBe(false);
            expect(engine.cancels).toBe(1);
            expect(commits).toEqual([{ text: 'that is all', send: false, reason: 'recogniser' }]);
        });

        it('ends a held mic too, so the button never lies about listening', async () => {
            capture.begin('hold');
            await flush();
            capture.recogniserEnded('', 'No speech detected');
            expect(capture.current.active).toBe(false);
            expect(commits).toEqual([]);
            expect(discards).toEqual(['recogniser']);
        });

        /**
         * The reason is the whole of the difference, so it is asserted as a
         * pair rather than one at a time. `final` is Apple ending an
         * utterance after a silence and the capture outlives it; anything
         * else is the recogniser saying it cannot go on.
         */
        it('a final keeps the mic open and an error closes it', async () => {
            capture.begin('hold');
            await flush();
            capture.partial('mid sentence');
            capture.recogniserEnded('mid sentence', 'final');
            await flush();
            expect(capture.current.active).toBe(true);
            expect(engine.starts).toBe(2);

            capture.recogniserEnded('', 'kAFAssistantErrorDomain 1110');
            await flush();
            expect(capture.current.active).toBe(false);
            expect(commits).toEqual([{ text: 'mid sentence', send: false, reason: 'recogniser' }]);
        });
    });

    describe('stragglers', () => {
        it('drops a stop that settles after the capture was discarded', async () => {
            capture.begin('latch');
            await flush();
            capture.stop();
            await flush();
            capture.discard();
            engine.settle('too late');
            await flush();
            expect(commits).toEqual([]);
        });

        it('refuses to start again while the last stop is still settling', async () => {
            capture.begin('latch');
            await flush();
            capture.stop();
            await flush();
            expect(capture.current.settling).toBe(true);
            capture.begin('latch');
            await flush();
            expect(engine.starts).toBe(1);
            engine.settle('done');
            await flush();
            expect(capture.current.settling).toBe(false);
            capture.begin('latch');
            await flush();
            expect(engine.starts).toBe(2);
        });
    });
    /**
     * The gesture table from DROVE-105, at the capture's level rather than
     * the button's: what each ending does with the words. The button decides
     * WHICH of these runs (micButton.spec.ts); this decides what each one
     * means.
     */
    describe('the gesture table: who sends and who does not', () => {
        const heard = 'ship it on monday';

        async function run(end: (c: DictationCapture) => void, mode: 'hold' | 'latch' = 'latch') {
            capture.begin(mode);
            await flush();
            capture.partial(heard);
            end(capture);
            await flush();
            engine.settle(heard);
            await flush();
        }

        it('a lift on the button sends', async () => {
            await run((c) => c.send(), 'hold');
            expect(commits).toEqual([{ text: heard, send: true, reason: 'send' }]);
            expect(discards).toEqual([]);
        });

        it('the tap off a latch keeps the words and sends nothing', async () => {
            await run((c) => c.stop());
            expect(commits).toEqual([{ text: heard, send: false, reason: 'stop' }]);
            expect(discards).toEqual([]);
        });

        it('the slide-off cancel throws the words away and sends nothing', async () => {
            await run((c) => c.cancel(), 'hold');
            expect(commits).toEqual([]);
            expect(discards).toEqual(['cancel']);
            expect(engine.cancels).toBe(1);
            // Nothing was ever transcribed: cancel does not stop, it drops.
            expect(engine.stops).toBe(0);
        });

        it('the idle stop keeps the words, unsent', async () => {
            capture.begin('latch');
            await flush();
            capture.partial(heard);
            clock += DICTATION_LATCH_IDLE_MS + 1;
            capture.tick(clock);
            await flush();
            engine.settle(heard);
            await flush();
            expect(commits).toEqual([{ text: heard, send: false, reason: 'idle' }]);
        });

        it('a speech cut from typing keeps the words, unsent', async () => {
            capture.begin('latch');
            await flush();
            capture.partial(heard);
            capture.interrupt('typed');
            await flush();
            engine.settle(heard);
            await flush();
            expect(commits).toEqual([{ text: heard, send: false, reason: 'typed' }]);
        });

        it('the recogniser ending on its own keeps the words, unsent', async () => {
            capture.begin('latch');
            await flush();
            capture.partial(heard);
            // An ERROR ends. A `final` is a pause and reopens the microphone
            // instead; see dictationContinuity.spec.ts (DROVE-140).
            capture.recogniserEnded(heard, 'No speech detected');
            await flush();
            expect(commits).toEqual([{ text: heard, send: false, reason: 'recogniser' }]);
        });

        it('exactly one of the five ends sends', async () => {
            const ends: ((c: DictationCapture) => void)[] = [
                (c) => c.send(),
                (c) => c.stop(),
                (c) => c.cancel(),
                (c) => c.tick(clock + DICTATION_LATCH_IDLE_MS + 1),
                (c) => c.recogniserEnded(heard, 'No speech detected'),
            ];
            const sent: boolean[] = [];
            for (const end of ends) {
                commits = [];
                engine = new FakeRecogniser();
                capture = new DictationCapture(engine, {
                    onCommit: (text, send, reason) => commits.push({ text, send, reason }),
                    onPartial: () => { },
                    onDiscard: () => { },
                    onError: () => { },
                    onChange: () => { },
                }, () => clock);
                capture.begin('latch');
                await flush();
                capture.partial(heard);
                end(capture);
                await flush();
                engine.settle(heard);
                await flush();
                sent.push(commits.some((c) => c.send));
            }
            expect(sent).toEqual([true, false, false, false, false]);
        });
    });

    /**
     * A pause must never cost the words already transcribed (DROVE-105).
     * Apple's on-device recogniser finalises on its own after a silence, so
     * the final string a later stop resolves with can be EMPTY while the
     * partials are on screen. Discarding there is what read as "you cancel
     * everything I said".
     */
    describe('a pause never discards what was already transcribed', () => {
        it('keeps the words when a silence longer than the idle deadline stops the latch', async () => {
            capture.begin('latch');
            await flush();
            capture.partial('deploy the build');
            expect(partials).toEqual(['deploy the build']);

            // Silence: no partial changes, the clock runs past the deadline.
            clock += DICTATION_LATCH_IDLE_MS + 1;
            capture.tick(clock);
            expect(capture.current.active).toBe(false);
            await flush();
            // The recogniser finalised behind us, so its final string is empty.
            engine.settle('');
            await flush();

            expect(discards).toEqual([]);
            expect(commits).toEqual([
                { text: 'deploy the build', send: false, reason: 'idle' },
            ]);
        });

        it('the last partial stands in for an empty final on every ending', async () => {
            for (const end of ['send', 'stop'] as const) {
                commits = [];
                discards = [];
                engine = new FakeRecogniser();
                capture = new DictationCapture(engine, {
                    onCommit: (text, send, reason) => commits.push({ text, send, reason }),
                    onPartial: () => { },
                    onDiscard: (reason) => discards.push(reason),
                    onError: () => { },
                    onChange: () => { },
                }, () => clock);
                capture.begin('latch');
                await flush();
                capture.partial('half a sentence');
                capture[end]();
                await flush();
                engine.settle('');
                await flush();
                expect(discards).toEqual([]);
                expect(commits.map((c) => c.text)).toEqual(['half a sentence']);
            }
        });

        it('the recogniser giving up with nothing keeps what it already reported', async () => {
            capture.begin('latch');
            await flush();
            capture.partial('what I said before the pause');
            capture.recogniserEnded('', 'No speech detected');
            expect(discards).toEqual([]);
            expect(commits).toEqual([
                { text: 'what I said before the pause', send: false, reason: 'recogniser' },
            ]);
        });

        it('still discards when nothing was ever heard', async () => {
            capture.begin('latch');
            await flush();
            capture.stop();
            await flush();
            engine.settle('');
            await flush();
            expect(commits).toEqual([]);
            expect(discards).toEqual(['stop']);
        });
    });
});
