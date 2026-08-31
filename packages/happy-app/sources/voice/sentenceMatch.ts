/**
 * Matching a sentence on the SCREEN to a sentence in the QUEUE (DROVE-163).
 *
 * The two sides never agree character for character. The speaker is handed
 * prose that has been through stripToSpeakableProse — emphasis markers gone,
 * links reduced to their labels, most inline code dropped, a pipe flattened to
 * a comma — while the renderer does its own version of the same reduction into
 * spans. They agree on the WORDS and disagree on nearly all the punctuation.
 *
 * So a tap is resolved on letters and digits alone, with a run of anything
 * else counting as one gap. That is the same rule sentenceHighlight.ts uses to
 * put the yellow mark on the spoken sentence, which is what makes the tap and
 * the mark land on the same thing: tap a sentence, and the sentence that
 * lights up is the one you touched.
 */

/** The comparable form of a sentence: its letters and digits, gaps collapsed. */
export function sentenceKey(text: string): string {
    return text
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Do these two say the same thing?
 *
 * Not a bare equality, because the rendered text and the spoken text are cut
 * at slightly different places: the renderer keeps a trailing bracket or a
 * footnote marker the speaker dropped, and the speaker force-cuts a run longer
 * than 220 characters that the renderer shows whole. Either containing the
 * other is close enough to be the same sentence, and an empty key never
 * matches anything.
 */
export function sameSentence(a: string, b: string): boolean {
    const left = sentenceKey(a);
    const right = sentenceKey(b);
    if (left.length === 0 || right.length === 0) return false;
    return left === right || left.includes(right) || right.includes(left);
}
