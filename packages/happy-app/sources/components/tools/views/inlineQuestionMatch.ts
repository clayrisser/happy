/**
 * Reading an answer back onto the options it chose.
 *
 * A settled question card keeps its question and every option on screen with
 * the chosen one marked (DROVE-52). Doing that means matching a recorded
 * answer to an option, and the answers arrive in more than one phrasing: the
 * form and the watch submit the bare label, Claude Code's tool result records
 * the bare label, and happy-cli's bridge writes a resolution won by another
 * surface as "<label> · by watch" so the card can say who answered.
 *
 * Lives in its own module because the form is a .tsx and this vitest config
 * only collects .ts — the rule that decides what the card highlights is the
 * part worth a test.
 */

/** Whether a recorded answer refers to this option. */
export function namesOption(answer: string, label: string): boolean {
    return answer === label || answer.startsWith(`${label} · `);
}

/** The indexes an answer set selects, in option order. */
export function selectedOptionIndexes(
    options: Array<{ label: string }>,
    answers: string[] | undefined,
): Set<number> {
    const indexes = new Set<number>();
    for (const answer of answers ?? []) {
        const index = options.findIndex((option) => namesOption(answer, option.label));
        if (index >= 0) indexes.add(index);
    }
    return indexes;
}

/**
 * What an answer says that the highlighted option does not already.
 *
 * Free text, an option that has since changed, or the "· by <surface>"
 * attribution. Shown under the list rather than dropped.
 */
export function answerNotes(
    options: Array<{ label: string }>,
    answers: string[] | undefined,
): string[] {
    return (answers ?? []).filter((answer) => !options.some((option) => option.label === answer));
}
