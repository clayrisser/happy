import type { MarkdownSpan } from './parseMarkdown';

/**
 * Finding the sentence the voice is on inside rendered markdown (DROVE-114).
 *
 * The speaker is handed prose that has already been through
 * stripToSpeakableProse: emphasis markers gone, links reduced to their labels,
 * most inline code dropped. The renderer does its own version of the same
 * thing into spans. The two agree on the WORDS and disagree on nearly all the
 * punctuation, so the match is made on letters and digits alone, with runs of
 * anything else treated as one gap.
 *
 * Where they genuinely differ (a sentence whose middle was a dropped shell
 * command) there is no match and nothing is marked. That is the right failure:
 * a wrong highlight is worse than none, and the voice carries on either way.
 */

export interface HighlightedSpan extends MarkdownSpan {
    /** Part of the sentence at the engine right now. */
    highlighted: boolean;
}

interface Normalized {
    text: string;
    /** For each character of `text`, where it came from in the source. */
    sourceIndex: number[];
}

function isWordChar(char: string): boolean {
    return /[\p{L}\p{N}]/u.test(char);
}

function normalize(source: string): Normalized {
    let text = '';
    const sourceIndex: number[] = [];
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (isWordChar(char)) {
            text += char.toLowerCase();
            sourceIndex.push(i);
            continue;
        }
        if (text.length === 0 || text.endsWith(' ')) continue;
        text += ' ';
        sourceIndex.push(i);
    }
    while (text.endsWith(' ')) {
        text = text.slice(0, -1);
        sourceIndex.pop();
    }
    return { text, sourceIndex };
}

/**
 * Where `sentence` sits in `plain`, as a half-open range of source indices, or
 * null when it is not in there.
 */
export function findSentenceRange(plain: string, sentence: string): { start: number; end: number } | null {
    const needle = normalize(sentence);
    if (needle.text.length === 0) return null;
    const hay = normalize(plain);
    const at = hay.text.indexOf(needle.text);
    if (at === -1) return null;
    const start = hay.sourceIndex[at];
    const last = hay.sourceIndex[at + needle.text.length - 1];
    if (start === undefined || last === undefined) return null;
    // The match ends on the last LETTER, and a sentence ends on its full stop.
    // Take the punctuation that is welded to it (the stop, a closing quote or
    // bracket) and stop at the first space, which is the next sentence's.
    let end = last + 1;
    while (end < plain.length && !isWordChar(plain[end]) && !/\s/.test(plain[end])) end += 1;
    return { start, end };
}

/**
 * The same spans, split so that exactly the sentence is marked. Null when the
 * sentence is not in these spans at all, which is the caller's signal to
 * render what it already had rather than rebuild an identical list.
 */
export function highlightSpans(spans: MarkdownSpan[], sentence: string | null): HighlightedSpan[] | null {
    if (sentence === null || sentence.length === 0) return null;
    const plain = spans.map((span) => span.text).join('');
    const range = findSentenceRange(plain, sentence);
    if (range === null) return null;

    const out: HighlightedSpan[] = [];
    let at = 0;
    for (const span of spans) {
        const spanStart = at;
        const spanEnd = at + span.text.length;
        at = spanEnd;
        if (span.text.length === 0) continue;
        const from = Math.max(range.start, spanStart);
        const to = Math.min(range.end, spanEnd);
        if (from >= to) {
            out.push({ ...span, highlighted: false });
            continue;
        }
        if (from > spanStart) {
            out.push({ ...span, text: span.text.slice(0, from - spanStart), highlighted: false });
        }
        out.push({ ...span, text: span.text.slice(from - spanStart, to - spanStart), highlighted: true });
        if (to < spanEnd) {
            out.push({ ...span, text: span.text.slice(to - spanStart), highlighted: false });
        }
    }
    return out;
}
