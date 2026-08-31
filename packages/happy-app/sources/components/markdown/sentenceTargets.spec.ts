import { describe, expect, it } from 'vitest';
import type { MarkdownSpan } from './parseMarkdown';
import { parseMarkdown } from './parseMarkdown';
import { splitIntoSentenceRuns } from './sentenceTargets';
import { sameSentence } from '@/voice/sentenceMatch';
import { speakableChunks } from '@/voice/speakable';
import type { Message } from '@/sync/typesMessage';

/**
 * Cutting a rendered block into the sentences a finger can land on
 * (DROVE-163). "Whatever SENTENCE I tap is where you start reading."
 */

function plain(text: string): MarkdownSpan[] {
    return [{ text, styles: [], url: undefined } as unknown as MarkdownSpan];
}

/** The rendered text of a run, which is what a tap sends to the reader. */
function texts(spans: MarkdownSpan[]): string {
    return spans.map((span) => span.text).join('');
}

function agentText(text: string): Message {
    return { kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text } as Message;
}

describe('splitting a block into tappable sentences (DROVE-163)', () => {
    it('gives one run per sentence, in order', () => {
        const runs = splitIntoSentenceRuns(plain('The tests pass. Two files changed. Nothing else moved.'));
        expect(runs.map((run) => run.sentence)).toEqual([
            'The tests pass.',
            'Two files changed.',
            'Nothing else moved.',
        ]);
    });

    /**
     * The first and last are the two that a naive cut gets wrong: one has
     * nothing before it and the other has the block's trailing text after it.
     */
    it('covers every character, so the first and last sentence have no gap around them', () => {
        const block = 'The tests pass. Two files changed. Nothing else moved. ';
        const runs = splitIntoSentenceRuns(plain(block));
        expect(runs.map((run) => texts(run.spans)).join('')).toBe(block);
        expect(texts(runs[0].spans)).toBe('The tests pass.');
        // The last run takes the trailing space with it rather than leaving a
        // sliver of the block that belongs to no sentence at all.
        expect(texts(runs[runs.length - 1].spans)).toBe(' Nothing else moved. ');
    });

    it('starts the first run at the very first character', () => {
        const runs = splitIntoSentenceRuns(plain('First. Second.'));
        expect(texts(runs[0].spans)).toBe('First.');
        expect(texts(runs[1].spans)).toBe(' Second.');
    });

    it('is one run when there is only one sentence', () => {
        const runs = splitIntoSentenceRuns(plain('Just the one thing to say.'));
        expect(runs).toHaveLength(1);
        expect(runs[0].sentence).toBe('Just the one thing to say.');
    });

    it('is one run for a block with nothing sayable in it', () => {
        const runs = splitIntoSentenceRuns(plain('   '));
        expect(runs).toHaveLength(1);
    });

    it('keeps each span\'s styling when a sentence is cut across a bold run', () => {
        const spans = [
            { text: 'The ', styles: [] },
            { text: 'tests', styles: ['bold'] },
            { text: ' pass. And the build is green.', styles: [] },
        ] as unknown as MarkdownSpan[];
        const runs = splitIntoSentenceRuns(spans);
        expect(runs.map((run) => texts(run.spans))).toEqual(['The tests pass.', ' And the build is green.']);
        expect(runs[0].spans.map((span) => span.styles)).toEqual([[], ['bold'], []]);
    });

    it('does not break inside a version number or an abbreviation', () => {
        const runs = splitIntoSentenceRuns(plain('Bumped to 1.2.3, e.g. for the fix. Then shipped it.'));
        expect(runs.map((run) => run.sentence)).toEqual([
            'Bumped to 1.2.3, e.g. for the fix.',
            'Then shipped it.',
        ]);
    });

    /**
     * The whole point of the split: what a tap sends must be findable in the
     * queue, even though the renderer and the speaker strip the markdown
     * differently. Driven end to end against the real parser and the real
     * speakable pipeline rather than a hand-written pair.
     */
    it('produces runs the reader can match against its own sentences', () => {
        const markdown = 'The **tests** pass and `tsc` is clean. Two files changed in `sources/voice`. Nothing else moved.';
        const spoken = speakableChunks(agentText(markdown));
        const blocks = parseMarkdown(markdown);
        const runs = blocks.flatMap((block) => (block.type === 'text' ? splitIntoSentenceRuns(block.content) : []));

        expect(runs).toHaveLength(spoken.length);
        for (let i = 0; i < runs.length; i++) {
            expect(sameSentence(runs[i].sentence, spoken[i])).toBe(true);
        }
        // And a tap on one sentence never resolves to a different one.
        expect(sameSentence(runs[0].sentence, spoken[1])).toBe(false);
        expect(sameSentence(runs[2].sentence, spoken[0])).toBe(false);
    });
});
