/**
 * Live transcript into the composer, revised in place (DROVE-74).
 *
 * The recogniser sends the WHOLE utterance so far on every partial result,
 * and it rewrites earlier words as later ones give it context. So the
 * composer cannot append: it holds what was there before the mic opened (the
 * BASE) and re-joins the latest partial onto it every time, and the final
 * transcript replaces the last partial the same way.
 */

/**
 * The base with the spoken text after it. One space between them when the
 * base does not already end in whitespace; a base that ends in a newline
 * keeps its newline. An empty transcript gives the base back untouched, so
 * a mic that heard nothing leaves the draft exactly as it was.
 */
export function joinDictation(base: string, spoken: string): string {
    const words = spoken.trim();
    if (words.length === 0) return base;
    if (base.length === 0) return words;
    if (/\s$/.test(base)) return `${base}${words}`;
    return `${base} ${words}`;
}

/**
 * What the composer should show for a dictation that began over `base` and
 * has heard `partials` in order. Only the LAST partial matters: each one is
 * the full utterance so far, not a delta.
 */
export function composeDictation(base: string, partials: string[]): string {
    const latest = partials.length > 0 ? partials[partials.length - 1] : '';
    return joinDictation(base, latest);
}
