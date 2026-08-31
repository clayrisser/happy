import type { MarkdownSpan } from './parseMarkdown';
import { findSentenceRange } from './sentenceHighlight';
import { splitIntoSentences } from '@/voice/speakable';

/**
 * Cutting a rendered block into the sentences a finger can land on
 * (DROVE-163).
 *
 * Clay: "Whatever SENTENCE I tap is where you start reading." The reader's
 * queue is already keyed by sentence and DROVE-125 marks the spoken one, so
 * the boundaries exist on both sides; what was missing was a way to turn a
 * touch into one of them inside a rendered markdown body.
 *
 * The hit test is not a measurement. Splitting the block's spans into one
 * pressable run per sentence makes the layout engine do it: whichever run the
 * finger is inside is the one whose `onPress` fires, at whatever font size,
 * line height and wrap the text happens to have, with no coordinates and
 * nothing that could disagree with what is on screen.
 *
 * Boundaries come from `splitIntoSentences`, the same splitter that fills the
 * queue, so the two agree about where a sentence ends even though they are
 * looking at differently stripped text. Where they cannot agree — a sentence
 * whose middle was a dropped shell command — the run still exists and its text
 * simply does not match anything in the queue, and the tap falls back to the
 * block. Every character of the block belongs to exactly one run, so there is
 * no gap between sentences for a tap to fall into.
 */

export interface SentenceRun {
    /** The sentence as rendered, for matching against the queue. */
    sentence: string;
    /** The block's spans, cut at this run's boundaries. */
    spans: MarkdownSpan[];
}

/** Slice `spans` to the half-open source range, keeping each span's styling. */
function spansIn(spans: MarkdownSpan[], start: number, end: number): MarkdownSpan[] {
    const out: MarkdownSpan[] = [];
    let at = 0;
    for (const span of spans) {
        const spanStart = at;
        const spanEnd = at + span.text.length;
        at = spanEnd;
        if (span.text.length === 0) continue;
        const from = Math.max(start, spanStart);
        const to = Math.min(end, spanEnd);
        if (from >= to) continue;
        out.push({ ...span, text: span.text.slice(from - spanStart, to - spanStart) });
    }
    return out;
}

/**
 * The block's spans as one run per sentence, in order.
 *
 * A block with nothing to split — one sentence, or one whose sentences cannot
 * be located in the rendered text — comes back as a single run over the whole
 * thing, which taps as the block did before.
 */
export function splitIntoSentenceRuns(spans: MarkdownSpan[]): SentenceRun[] {
    const plain = spans.map((span) => span.text).join('');
    const whole: SentenceRun[] = [{ sentence: plain.trim(), spans }];
    if (plain.trim().length === 0) return whole;

    const sentences = splitIntoSentences(plain);
    if (sentences.length < 2) return whole;

    const runs: SentenceRun[] = [];
    let cut = 0;
    for (let i = 0; i < sentences.length; i++) {
        const range = findSentenceRange(plain, sentences[i], cut);
        // One sentence the renderer and the splitter disagree about would put
        // every later run on the wrong text, so the whole block falls back
        // rather than being cut in the wrong places.
        if (range === null) return whole;
        // Each run reaches from where the last one stopped to the end of this
        // sentence, so the gap between two sentences belongs to the one that
        // follows it and the last run soaks up any trailing text. Nothing is
        // left over for a tap to miss.
        const end = i === sentences.length - 1 ? plain.length : range.end;
        runs.push({ sentence: sentences[i], spans: spansIn(spans, cut, end) });
        cut = end;
    }
    return runs.length > 0 ? runs : whole;
}
