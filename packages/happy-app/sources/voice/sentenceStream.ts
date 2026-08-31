import { endsOnSentenceBoundary, splitIntoSentences } from './speakable';

/**
 * Sentence chunking for text that is still arriving (DROVE-97).
 *
 * The compact iOS voice sounds robotic mostly because it was handed
 * fragments: prosody is planned per utterance, so half a sentence gets the
 * falling contour of a whole one and the other half starts flat. The
 * synthesiser therefore only ever gets whole sentences. A trailing run with
 * no terminator is held back as `pending` until more text arrives, until the
 * reader decides the message is over, or until it is force-cut for length.
 *
 * The look-ahead lives in splitIntoSentences: a full stop only ends a
 * sentence once the next word is visible and does not start lower-case, so
 * "e.g." and an unlisted abbreviation wait for the word after them.
 */
export interface StreamChunks {
    /** Sentences safe to speak now, in order. */
    complete: string[];
    /** The unfinished tail, or null when the text ends on a terminator. */
    pending: string | null;
}

/**
 * Split `prose` (already reduced by stripToSpeakableProse) into what can be
 * spoken now and what has to wait. `final` says no more text is coming for
 * this message, so the tail is spoken as it stands.
 */
export function chunkStreamed(prose: string, final: boolean): StreamChunks {
    const sentences = splitIntoSentences(prose);
    if (sentences.length === 0) return { complete: [], pending: null };
    if (final || endsOnSentenceBoundary(prose)) {
        return { complete: sentences, pending: null };
    }
    const complete = sentences.slice(0, -1);
    const pending = sentences[sentences.length - 1];
    return { complete, pending };
}
