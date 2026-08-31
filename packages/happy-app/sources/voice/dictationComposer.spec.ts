import { describe, expect, it } from 'vitest';
import { DictationCapture, keptTranscript, type DictationEndReason, type DictationEngine } from './dictationCapture';
import { dictationComposerEvents, dictationEndReasons, dictationRestoresDraft } from './dictationComposer';
import { DICTATION_LATCH_IDLE_MS } from './micMode';
import type { ReadAloudInterruption } from './readAloud';

/**
 * The invariant, as a table over the whole union (DROVE-120).
 *
 * Clay lost a dictated sentence twice. The first fix (DROVE-105) closed one
 * route; the mechanism underneath was that ending a capture ANY way other
 * than a send put the pre-mic draft back, erasing every partial already on
 * screen. This file is the guard against that class rather than that case: it
 * walks every DictationEndReason and every ReadAloudInterruption through the
 * real DictationCapture wired to the real composer events, and asserts the
 * words survive. A new reason has to be added to `dictationRestoresDraft` to
 * compile, and lands in this test the moment it is.
 */

/** A recogniser the test drives by hand. */
class FakeRecogniser implements DictationEngine {
    starts = 0;
    stops = 0;
    cancels = 0;
    private stopResolvers: ((text: string) => void)[] = [];

    start(): Promise<unknown> {
        this.starts += 1;
        return Promise.resolve(true);
    }

    stop(): Promise<string> {
        this.stops += 1;
        return new Promise<string>((resolve) => { this.stopResolvers.push(resolve); });
    }

    cancel(): void {
        this.cancels += 1;
    }

    /** The final transcript lands. A no-op when no stop is outstanding. */
    settle(text: string): void {
        this.stopResolvers.shift()?.(text);
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** The mic, the composer and the clock, wired the way useVoiceComposer wires them. */
function harness(base: string) {
    const engine = new FakeRecogniser();
    let clock = 1_000;
    let composer = base;
    let baseDraft = base;
    let sends = 0;
    const errors: string[] = [];
    const capture = new DictationCapture(engine, dictationComposerEvents({
        base: () => baseDraft,
        setComposerText: (text) => { composer = text; },
        send: () => { sends += 1; },
        onError: (message) => errors.push(message),
        onChange: () => { /* the indicator, not the text */ },
    }), () => clock);
    return {
        engine,
        capture,
        errors,
        get composer() { return composer; },
        get sends() { return sends; },
        /** The user editing the composer himself, which resets the base. */
        type(text: string) { composer = text; baseDraft = text; },
        advance(ms: number) { clock += ms; },
        tick() { capture.tick(clock); },
    };
}

type Harness = ReturnType<typeof harness>;

/**
 * End a live capture the way the app ends it for this reason. Every route in
 * the app funnels through one of these five entry points.
 */
async function endCapture(h: Harness, reason: DictationEndReason, final: string): Promise<void> {
    switch (reason) {
        case 'send':
            h.capture.send();
            break;
        case 'stop':
            h.capture.stop();
            break;
        case 'cancel':
            h.capture.cancel();
            break;
        case 'idle':
            h.capture.latch();
            h.advance(DICTATION_LATCH_IDLE_MS);
            h.tick();
            break;
        case 'recogniser':
            h.capture.recogniserEnded(final);
            break;
        default:
            // Everything left in the union is a ReadAloudInterruption, and
            // useVoiceComposer subscribes capture.interrupt straight to
            // readAloud.addInterruptListener. This is the route that bit him.
            h.capture.interrupt(reason);
            break;
    }
    await flush();
    h.engine.settle(final);
    await flush();
}

/** Speak into a fresh capture and leave it live. */
async function speak(base: string, words: string): Promise<Harness> {
    const h = harness(base);
    h.capture.begin('hold');
    await flush();
    h.capture.partial(words.split(' ').slice(0, 2).join(' '));
    h.capture.partial(words);
    return h;
}

describe('the dictation invariant: a capture ending never costs words', () => {
    const base = 'draft so far';
    const words = 'run the tests and tell me what broke';
    const spoken = `${base} ${words}`;

    it('covers every DictationEndReason at runtime', () => {
        // Derived from a `satisfies Record<DictationEndReason, boolean>`
        // table, so this list cannot fall behind the union.
        expect(dictationEndReasons.sort()).toEqual([
            'call-started',
            'cancel',
            'headphones-unplugged',
            'idle',
            'left-session',
            'mic',
            'recogniser',
            'send',
            'sent',
            'stop',
            'switched-session',
            'toggled-off',
            'typed',
        ]);
    });

    it('names exactly one exception, and it is the cancel gesture', () => {
        const restores = dictationEndReasons.filter((reason) => dictationRestoresDraft[reason]);
        expect(restores).toEqual(['cancel']);
    });

    for (const reason of dictationEndReasons) {
        // Stated here, NOT read out of dictationRestoresDraft: the table is
        // what is under test, so an expectation derived from it would agree
        // with any edit to it. The union comes from the table; the rule does
        // not.
        const keeps = reason !== 'cancel';

        it(`${reason}: ${keeps ? 'keeps' : 'takes back'} what is already in the composer`, async () => {
            const h = await speak(base, words);
            expect(h.composer).toBe(spoken);

            await endCapture(h, reason, words);

            expect(h.composer).toBe(keeps ? spoken : base);
        });

        it(`${reason}: keeps the words even when the final transcript comes back empty`, async () => {
            // Apple finalises on its own after a pause or at its own time
            // limit, and the native module clears its transcript when it
            // does, so the stop that follows resolves with nothing. This is
            // the exact shape of "if I stop talking for a moment it clears
            // everything I said".
            const h = await speak(base, words);
            await endCapture(h, reason, '');
            expect(h.composer).toBe(keeps ? spoken : base);
        });
    }

    it('only the lift sends', async () => {
        for (const reason of dictationEndReasons) {
            const h = await speak(base, words);
            await endCapture(h, reason, words);
            expect(`${reason}:${h.sends}`).toBe(`${reason}:${reason === 'send' ? 1 : 0}`);
        }
    });
});

describe('read-aloud interrupts arriving mid-hold', () => {
    const readAloudInterruptions = [
        'typed',
        'sent',
        'mic',
        'left-session',
        'switched-session',
        'toggled-off',
        'call-started',
        'headphones-unplugged',
    ] as const;

    // Fails to compile if ReadAloudInterruption grows or shrinks, so a new
    // interrupt reason cannot reach capture.interrupt() untested.
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const listIsTheWholeUnion: Exact<typeof readAloudInterruptions[number], ReadAloudInterruption> = true;

    it('enumerates the whole ReadAloudInterruption union', () => {
        expect(listIsTheWholeUnion).toBe(true);
        for (const reason of readAloudInterruptions) {
            expect(dictationEndReasons).toContain(reason);
        }
    });

    for (const reason of readAloudInterruptions) {
        it(`${reason} mid-hold leaves the sentence in the composer`, async () => {
            const h = await speak('', 'the whole sentence he just said');
            expect(h.composer).toBe('the whole sentence he just said');

            // readAloud.addInterruptListener -> capture.interrupt(reason).
            h.capture.interrupt(reason);
            await flush();
            h.engine.settle('');
            await flush();

            expect(h.composer).toBe('the whole sentence he just said');
            expect(h.sends).toBe(0);
        });
    }

    it('typing over a partial keeps both the keystrokes and the words', async () => {
        const h = await speak('', 'half a sentence');
        h.type('half a sentence and typed');
        h.capture.interrupt('typed');
        await flush();
        h.engine.settle('half a sentence');
        await flush();
        expect(h.composer).toBe('half a sentence and typed');
    });
});

describe('the two ways a hold ends by itself', () => {
    it('a hold past the recogniser own limit keeps the words, unsent', async () => {
        // The native task ends and emits onDictationEnded with everything it
        // heard; the lift that follows finds nothing left to do.
        const h = await speak('', 'a very long dictation that ran past the limit');
        h.capture.recogniserEnded('a very long dictation that ran past the limit');
        await flush();
        expect(h.composer).toBe('a very long dictation that ran past the limit');
        expect(h.sends).toBe(0);

        h.capture.send();
        await flush();
        expect(h.composer).toBe('a very long dictation that ran past the limit');
        expect(h.sends).toBe(0);
    });

    it('a hold past the limit still keeps the words when the stop lands after the reset', async () => {
        // The other order: the native side already cleared latestTranscript,
        // so the app's own stop resolves with "".
        const h = await speak('', 'a very long dictation that ran past the limit');
        h.capture.send();
        await flush();
        h.engine.settle('');
        await flush();
        expect(h.composer).toBe('a very long dictation that ran past the limit');
    });

    it('a pause long enough for Apple to finalise keeps the words', async () => {
        const h = await speak('notes: ', 'first half of the thought');
        // No speech for a while, Apple gives up with nothing.
        h.capture.recogniserEnded('');
        await flush();
        expect(h.composer).toBe('notes: first half of the thought');
        expect(h.sends).toBe(0);
    });

    it('the latch idle stop keeps the words, unsent', async () => {
        const h = await speak('', 'left running while he thought');
        h.capture.latch();
        h.advance(DICTATION_LATCH_IDLE_MS);
        h.tick();
        await flush();
        h.engine.settle('');
        await flush();
        expect(h.composer).toBe('left running while he thought');
        expect(h.sends).toBe(0);
    });
});

describe('keptTranscript', () => {
    it('keeps what was shown when the final comes back empty', () => {
        expect(keptTranscript('run the tests', '')).toBe('run the tests');
        expect(keptTranscript('run the tests', '   ')).toBe('run the tests');
    });

    it('keeps what was shown when the final is a truncation of it', () => {
        expect(keptTranscript('run the tests and report', 'run the')).toBe('run the tests and report');
    });

    it('takes the final when it is a genuine revision', () => {
        expect(keptTranscript('um hello', 'hello')).toBe('hello');
        expect(keptTranscript('twenty two', '22')).toBe('22');
        expect(keptTranscript('run the', 'run the tests')).toBe('run the tests');
    });

    it('gives nothing back when nothing was ever heard', () => {
        expect(keptTranscript('', '')).toBe('');
    });
});
