import { describe, expect, it, vi } from 'vitest';

// theme.ts reaches for Platform.select and react-native's entry point is Flow
// source vitest cannot parse. The phone is what the mark is for, so pick ios.
vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (options: Record<string, unknown>) => options.ios ?? options.native ?? options.default,
    },
}));

import type { MarkdownSpan } from './parseMarkdown';
import { findSentenceRange, highlightSpans } from './sentenceHighlight';
import { darkTheme, lightTheme } from '@/theme';
import { colorDistance, contrastRatio } from '@/utils/subagentTint';

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

/**
 * The colour the mark is drawn in (DROVE-125).
 *
 * Clay: "actually color it, not highlight it with gray." The grey block read
 * as selected text and was heavy on a dark theme. What is asserted here is
 * the part that can be: it is legible on the ground it sits on, and it is not
 * one of the accents already carrying a meaning a few rows away.
 *
 * What CANNOT be asserted here, and matters more, is in MarkdownView's
 * `spoken` style: the mark is colour and nothing else. A weight, size or
 * family change would re-measure the row, and DROVE-114 turned a re-measure
 * into a seek, so it would move the very thing it is marking.
 */
describe('the spoken-sentence colour (DROVE-125)', () => {
    /** WCAG AA for body text. The mark IS body text, so this is the floor. */
    const bodyTextContrast = 4.5;
    /**
     * Normalised sRGB distance, so 0 is the same colour and 1 is black to
     * white. A quarter of the whole cube is comfortably past "that is a
     * different colour" and well past the gap between the working blue and
     * the link cyan, which is about 0.13.
     */
    const distinctEnough = 0.25;

    const grounds = [
        ['light', lightTheme.colors.spokenSentence, [lightTheme.colors.surface, lightTheme.colors.surfaceHigh]],
        ['dark', darkTheme.colors.spokenSentence, [darkTheme.colors.surface, darkTheme.colors.surfaceHigh]],
    ] as const;

    it.each(grounds)('is legible in the %s theme', (_name, mark, surfaces) => {
        for (const surface of surfaces) {
            expect(contrastRatio(mark, surface)).toBeGreaterThanOrEqual(bodyTextContrast);
        }
    });

    it.each(grounds)('is not confusable with a meaning already taken, in %s', (name, mark) => {
        const theme = name === 'light' ? lightTheme : darkTheme;
        const taken = {
            // The running agent and the subagent tint (DROVE-109).
            working: theme.colors.permission.acceptEdits,
            link: theme.colors.textLink,
            success: theme.colors.success,
            destructive: theme.colors.textDestructive,
            // And it has to be visible AS a mark, so not the body text either.
            body: theme.colors.text,
        };
        for (const colour of Object.values(taken)) {
            expect(colorDistance(mark, colour)).toBeGreaterThan(distinctEnough);
        }
    });
});
