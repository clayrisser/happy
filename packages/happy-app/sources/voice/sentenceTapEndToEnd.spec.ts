import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
import { splitIntoSentenceRuns } from '@/components/markdown/sentenceTargets';
import type { Message } from '@/sync/typesMessage';
import { ReadAloudReader, type SpeakOptions, type SpeechEngine } from './readAloud';
import { readSentenceFromHere } from './readAloudTap';

/**
 * ONE TAP ON A SENTENCE, ALL THE WAY THROUGH (DROVE-195).
 *
 * Clay reported "double tap on sentence to read from it didn't work". It is a
 * SINGLE tap since DROVE-163, and the question this file answers is the one
 * the ticket asked first: is the single tap actually broken on his build, or
 * did nobody tell him it changed?
 *
 * The pieces each had a test and the chain between them did not, so this walks
 * the whole of it with nothing faked but the synthesiser: the reply is real
 * markdown, `parseMarkdown` gives the blocks the renderer draws,
 * `splitIntoSentenceRuns` cuts them into the pressable runs a finger lands on,
 * and `run.sentence` is verbatim what `MarkdownView`'s `onPress` hands to
 * `MessageView`, which hands it to `readSentenceFromHere` against the real
 * reader fed by the real `onMessages`.
 *
 * What is NOT covered here is React: vitest runs on node and the suite is
 * `.ts` only, so the `<Text onPress>` per run is read rather than mounted.
 * That leaves one link untested and it is the one link DROVE-163 did not
 * change the shape of, since a link's press inside the same body has worked
 * throughout.
 *
 * ANSWER: it works. Every sentence of a rendered reply resolves to itself.
 */

class FakeEngine implements SpeechEngine {
    spoken: string[] = [];
    private resolvers: (() => void)[] = [];

    speak(text: string, _options?: SpeakOptions): Promise<unknown> {
        this.spoken.push(text);
        return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
    }

    stop(): void {
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

/** Exactly what a finger can land on, in the order it is drawn. */
function tappableSentences(markdown: string): string[] {
    return parseMarkdown(markdown).flatMap((block) => {
        if (block.type === 'text' || block.type === 'header') {
            return splitIntoSentenceRuns(block.content).map((run) => run.sentence);
        }
        if (block.type === 'list' || block.type === 'numbered-list') {
            return block.items.flatMap((item: { spans: unknown }) =>
                splitIntoSentenceRuns(item.spans as never).map((run) => run.sentence));
        }
        return [];
    });
}

const reply = [
    'Landed the change and pushed it.',
    'Two files moved in `sources/voice`, and the **rest** is untouched.',
    'Nothing else needs doing.',
].join(' ');

describe('a single tap on a sentence of a rendered reply (DROVE-195)', () => {
    function reading(): { reader: ReadAloudReader; engine: FakeEngine } {
        const engine = new FakeEngine();
        const reader = new ReadAloudReader(engine);
        reader.setEnabled(true);
        reader.focus('s1');
        return { reader, engine };
    }

    it('cuts the reply into three runs, which is what the finger sees', () => {
        expect(tappableSentences(reply)).toHaveLength(3);
    });

    it('reads from the sentence that was touched, not the top of the block', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();
        expect(engine.spoken).toEqual(['Landed the change and pushed it.']);

        // The third run, pressed once. This is the literal payload of
        // MarkdownView's onPress.
        const runs = tappableSentences(reply);
        expect(readSentenceFromHere(reader, 's1', 'm1', runs[2], 1)).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('Nothing else needs doing.');
    });

    it('lands the mark on the sentence that was tapped, at once', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();

        const runs = tappableSentences(reply);
        readSentenceFromHere(reader, 's1', 'm1', runs[1], 1);
        await settle();
        // The confirmation the gesture gives itself: the yellow mark is the
        // playhead, keyed by message and sentence, and it is on the run that
        // was pressed before the engine has said anything else.
        expect(reader.playhead?.messageId).toBe('m1');
        expect(reader.playhead?.sentence).toBe(engine.spoken[engine.spoken.length - 1]);
        expect(runs[1]).toContain('Two files moved');
    });

    it('resolves EVERY run of the reply to itself, so no sentence is a dead target', async () => {
        const runs = tappableSentences(reply);
        for (const run of runs) {
            const { reader, engine } = reading();
            reader.onMessages('s1', [agentText('m1', reply)]);
            await settle();
            expect(readSentenceFromHere(reader, 's1', 'm1', run, 1)).toBe(true);
            await settle();
            // A miss would fall back to the block and say the first sentence.
            expect(reader.playhead?.sentence).not.toBeUndefined();
            if (run !== runs[0]) {
                expect(engine.spoken[engine.spoken.length - 1]).not.toBe(runs[0]);
            }
        }
    });

    it('works the same on a bullet list, where the runs live inside items', async () => {
        const markdown = '- The first item. It has two sentences.\n- The second item.';
        const runs = tappableSentences(markdown);
        expect(runs).toEqual(['The first item.', 'It has two sentences.', 'The second item.']);

        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', markdown)]);
        await settle();
        expect(readSentenceFromHere(reader, 's1', 'm1', 'The second item.', 1)).toBe(true);
        await settle();
        expect(engine.spoken[engine.spoken.length - 1]).toBe('The second item.');
    });

    /**
     * A double tap is two presses. If Clay keeps reaching for the old gesture
     * it must not be worse than one press, and it is not: the second press on
     * the same run seeks to the same place, and on the NEXT run seeks to that
     * one. Neither is silence, which is what he reported.
     */
    it('is not made worse by a second tap', async () => {
        const { reader, engine } = reading();
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();
        const runs = tappableSentences(reply);

        readSentenceFromHere(reader, 's1', 'm1', runs[1], 1);
        await settle();
        readSentenceFromHere(reader, 's1', 'm1', runs[1], 1);
        await settle();
        expect(reader.playhead?.sentence).toBe(engine.spoken[engine.spoken.length - 1]);
        expect(engine.spoken[engine.spoken.length - 1]).toContain('Two files moved');
    });

    /** DROVE-179's gate must not see a seek as a stop. */
    it('tells no capture anything, so the gate never sees it', async () => {
        const { reader } = reading();
        const heard: string[] = [];
        reader.addInterruptListener((reason) => heard.push(reason));
        reader.onMessages('s1', [agentText('m1', reply)]);
        await settle();

        readSentenceFromHere(reader, 's1', 'm1', tappableSentences(reply)[2], 1);
        await settle();
        expect(heard).toEqual([]);
    });
});
