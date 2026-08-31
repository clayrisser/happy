import { describe, expect, it } from 'vitest';
import type { MarkdownSpan } from './parseMarkdown';
import { findSentenceRange, highlightSpans } from './sentenceHighlight';

function span(text: string, styles: MarkdownSpan['styles'] = []): MarkdownSpan {
    return { text, styles, url: null };
}

function marked(spans: ReturnType<typeof highlightSpans>): string {
    return (spans ?? []).map((s) => (s.highlighted ? `[${s.text}]` : s.text)).join('');
}

describe('finding the spoken sentence in rendered markdown (DROVE-114)', () => {
    it('marks exactly the sentence inside a paragraph', () => {
        const spans = [span('One thing. Then another thing. And a third.')];
        expect(marked(highlightSpans(spans, 'Then another thing.')))
            .toBe('One thing. [Then another thing.] And a third.');
    });

    it('marks across a bold run, because the voice never saw the asterisks', () => {
        const spans = [span('Ran the '), span('whole suite', ['bold']), span(' twice. Then stopped.')];
        // Split, not merged: each piece keeps the styling it had.
        expect(marked(highlightSpans(spans, 'Ran the whole suite twice.')))
            .toBe('[Ran the ][whole suite][ twice.] Then stopped.');
    });

    it('ignores punctuation the speakable filter rewrote', () => {
        const spans = [span('Two files changed — the reducer and the view.')];
        expect(marked(highlightSpans(spans, 'Two files changed, the reducer and the view.')))
            .toBe('[Two files changed — the reducer and the view.]');
    });

    it('marks nothing when the sentence is not in this block', () => {
        expect(highlightSpans([span('Something else entirely.')], 'Then another thing.')).toBeNull();
        expect(highlightSpans([span('anything')], null)).toBeNull();
    });

    it('marks nothing rather than guessing when a dropped command left a hole', () => {
        // stripToSpeakableProse throws shell away, so the spoken sentence has
        // words the rendered line does not join up. No match is the right
        // answer: a wrong highlight is worse than none.
        expect(highlightSpans([span('Run `pnpm test --watch` and wait.')], 'Run and wait.')).toBeNull();
    });

    it('reports the range in the source string, not the normalised one', () => {
        expect(findSentenceRange('  One thing.  Then another.', 'Then another.'))
            .toEqual({ start: 14, end: 27 });
    });
});
