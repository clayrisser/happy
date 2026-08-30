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
