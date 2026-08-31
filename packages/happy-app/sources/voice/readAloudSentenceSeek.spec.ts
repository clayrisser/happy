import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';
import { sameSentence, sentenceKey } from './sentenceMatch';

/**
 * Reading starts at the SENTENCE that was double tapped (DROVE-163).
 *
 * Clay, refining DROVE-146: "Whatever SENTENCE I tap is where you start
 * reading." The block-level seek resolved a tap to the first sayable thing at
 * or after a message's createdAt, which in the middle of a long reply is the
 * top of the block rather than the line under his finger.
 *
 * The gesture that gets here is two taps, not one (DROVE-235). What arrives at
 * the reader is the same either way, so nothing below changes: the count is
 * counted in `components/doubleTapPress.ts` and the wiring is pinned in
 * `sentenceTapEndToEnd.spec.ts`.
 */

class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    stops = 0;
    private resolvers: (() => void)[] = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
        this.stops += 1;
        const pending = this.resolvers;
        this.resolvers = [];
        for (const resolve of pending) resolve();
    }

    finishOne(): void {
        this.resolvers.shift()?.();
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function agentText(id: string, text: string, createdAt = 1): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text } as Message;
}

const reply = 'The first thing. The second thing. The third thing. The fourth thing.';

describe('matching a tapped sentence to a spoken one', () => {
    it('ignores every difference except the words', () => {
        // What the renderer shows against what the speaker was handed: the
        // emphasis markers, the backticks and the bracket are all gone by the
        // time the queue sees it, and the two must still be one sentence.
        expect(sameSentence('The **tests** pass (finally).', 'The tests pass finally.')).toBe(true);
        expect(sentenceKey('  Two   files,  changed. ')).toBe('two files changed');
    });

    it('does not match two different sentences', () => {
        expect(sameSentence('The tests pass.', 'The build is green.')).toBe(false);
        expect(sameSentence('', 'anything at all')).toBe(false);
    });
});

describe('seeking to a double-tapped sentence (DROVE-163)', () => {
    function reading(): { reader: ReadAloudReader; engine: FakeEngine } {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        return { reader, engine };
    }

    it('starts from the sentence in the middle of a reply, not the top of the block', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();
        expect(engine.spoken).toEqual(['The first thing.']);

        expect(reader.seekToSentence('m1', 'The third thing.')).toBe(true);
        await settle();
        expect(engine.spoken).toEqual(['The first thing.', 'The third thing.']);
        expect(reader.playhead?.sentence).toBe('The third thing.');

        engine.finishOne();
        await settle();
        expect(engine.spoken).toEqual(['The first thing.', 'The third thing.', 'The fourth thing.']);
    });

    it('works on the first sentence of a block and on the last', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();
        for (let i = 0; i < 3; i++) {
            engine.finishOne();
            await settle();
        }
        expect(engine.spoken).toHaveLength(4);

        expect(reader.seekToSentence('m1', 'The fourth thing.')).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('The fourth thing.');

        expect(reader.seekToSentence('m1', 'The first thing.')).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('The first thing.');
    });

    /**
     * A tap is a REQUEST, so it outranks DROVE-126's spoken-once rule: that
     * exists to stop the queue repeating itself while nobody asked, and being
     * asked is the exception it was always missing.
     */
    it('reads a sentence that has already been spoken, and carries on past it', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();
        for (let i = 0; i < 3; i++) {
            engine.finishOne();
            await settle();
        }
        expect(engine.spoken).toEqual([
            'The first thing.', 'The second thing.', 'The third thing.', 'The fourth thing.',
        ]);

        reader.seekToSentence('m1', 'The second thing.');
        await settle();
        engine.finishOne();
        await settle();
        expect(engine.spoken.slice(4)).toEqual(['The second thing.', 'The third thing.']);
    });

    it('reads a sentence that has NOT been read yet without touching the ones before it', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();
        expect(engine.spoken).toEqual(['The first thing.']);

        reader.seekToSentence('m1', 'The fourth thing.');
        await settle();
        expect(engine.spoken).toEqual(['The first thing.', 'The fourth thing.']);

        // The two it stepped over were never spoken, so they are still there
        // to be tapped rather than burnt.
        expect(reader.seekToSentence('m1', 'The second thing.')).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('The second thing.');
    });

    it('matches the rendered form of a sentence, not just the spoken one', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', 'All set. The **tests** pass, finally. Nothing else moved.')]);
        await settle();

        // What the markdown renderer would hand over: the asterisks are still
        // in the source and gone from the spans, and the queue's copy went
        // through a different stripper again.
        expect(reader.seekToSentence('m1', 'The tests pass, finally.')).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('The tests pass, finally.');
    });

    it('says no when the sentence is not in the queue, and leaves reading alone', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();

        expect(reader.seekToSentence('m1', 'Something it never said.')).toBe(false);
        // The same sentence in a different message is not this one.
        expect(reader.seekToSentence('m2', 'The third thing.')).toBe(false);
        await settle();
        expect(engine.spoken).toEqual(['The first thing.']);
        expect(engine.stops).toBe(0);
    });

    it('resolves to the tapped message when two replies share a sentence', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [
            agentText('m1', 'The same line. One.'),
            agentText('m2', 'The same line. Two.', 2),
        ]);
        await settle();

        reader.seekToSentence('m2', 'The same line.');
        await settle();
        engine.finishOne();
        await settle();
        // The copy inside m2, so what follows it is m2's, not m1's.
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Two.');
    });

    /** A tap is not a reason to stop the microphone (DROVE-143). */
    it('does not tell the captures anything', async () => {
        const { reader } = reading();
        const heard: string[] = [];
        reader.addInterruptListener((reason) => heard.push(reason));
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();

        reader.seekToSentence('m1', 'The third thing.');
        await settle();
        expect(heard).toEqual([]);
    });
});
