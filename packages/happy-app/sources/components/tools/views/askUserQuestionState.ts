import type { InlineQuestionAnswers } from './InlineQuestionForm';

/**
 * When a question card is done, and what it should say it was answered with.
 *
 * Split out of the view because it is the rule that makes the Cattle Drover bus
 * worth having: the watch, a gum popup in tmux and this card all race for the
 * same event, the bus broadcasts the winner, and every loser has to drop the
 * prompt. Tool STATE cannot carry that on its own — an approved request goes
 * back to 'running', so a card keyed off state alone stayed live and tappable
 * on the phone after the watch had already answered it.
 */
export interface QuestionCardPermission {
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    reason?: string;
}

export function isQuestionSettled(
    permission: QuestionCardPermission | null | undefined,
    toolState: string,
): boolean {
    if (permission) return permission.status !== 'pending';
    return toolState !== 'running';
}

/**
 * The answer to show once some other surface won. The bridge writes it as the
 * completed request's reason — "Popup stayed open · by watch". With nothing to
 * show this returns undefined rather than an empty map, so a local submit still
 * displays the labels it just sent instead of an em dash.
 */
export function answersFromResolution(
    permission: QuestionCardPermission | null | undefined,
    toolState: string,
    questionIds: string[],
): InlineQuestionAnswers | undefined {
    if (!isQuestionSettled(permission, toolState)) return undefined;
    if (!permission?.reason || questionIds.length === 0) return undefined;
    return { [questionIds[0]]: [permission.reason] };
}

/**
 * The answer once it lands in the tool result (DROVE-51). A question answered
 * at the terminal never goes through this app's permission, so the card only
 * learns the choice from the result Claude wrote: on disk that is
 * `{questions, answers: {<question text>: <label>}}`; on the SDK path it is
 * the sentence `Your questions have been answered: "<question>"="<label>". …`.
 * Both are measured from the drover transcripts. Anything else yields
 * undefined so the caller keeps whatever it already knew.
 */
export function answersFromResult(
    result: unknown,
    questions: Array<{ id: string; question: string }>,
): InlineQuestionAnswers | undefined {
    if (questions.length === 0 || result === null || result === undefined) return undefined;

    const byQuestion = new Map<string, string>();
    const record = result as { answers?: unknown };
    if (typeof result === 'object' && record.answers && typeof record.answers === 'object') {
        for (const [question, label] of Object.entries(record.answers as Record<string, unknown>)) {
            if (typeof label === 'string') byQuestion.set(question, label);
        }
    } else if (typeof result === 'string') {
        // "..."="..." pairs; a question can itself contain quotes, so match the
        // label back from the closing `"=` rather than forward from the first quote.
        for (const match of result.matchAll(/"((?:[^"\\]|\\.|"(?!=))*)"="((?:[^"\\]|\\.)*)"/g)) {
            byQuestion.set(match[1], match[2]);
        }
    }
    if (byQuestion.size === 0) return undefined;

    const answers: InlineQuestionAnswers = {};
    for (const question of questions) {
        const label = byQuestion.get(question.question);
        if (label !== undefined) answers[question.id] = [label];
    }
    return Object.keys(answers).length > 0 ? answers : undefined;
}
