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
 * The answer Claude Code itself recorded, read off the tool RESULT.
 *
 * DROVE-52. When the drover PreToolUse hook answers an AskUserQuestion in a
 * gum popup, Claude Code writes the chosen label into the tool result's
 * `answers`, keyed by the question's own text, and never touches the app's
 * permission machinery — a pane session has no `tool.permission` at all. The
 * card only ever read `permission.reason`, so a question answered at the
 * terminal came back on the phone as "DROVE-50: —": the header, an em dash,
 * no question, no options, and it stayed a dash forever.
 *
 * Measured on session 19c2f0a8's transcript, tool_use toolu_01AAvS8Ps…,
 * answered 2026-08-30T18:32:20Z, whose toolUseResult is
 * `{questions:[…], answers:{"<question text>":"Drover owns the picker …"}}`.
 * typesRaw.ts hands that whole object through as `tool.result`.
 *
 * A multi-select arrives as one string joined with ", " — the same separator
 * providerAnswersFor writes and happy-cli's busResolutionFor splits on — so it
 * is split back apart here and nowhere else.
 */
export function answersFromToolResult(
    result: unknown,
    cards: Array<{ question: string; multiSelect?: boolean }>,
): InlineQuestionAnswers | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const answers = (result as { answers?: unknown }).answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
    const byQuestion = answers as Record<string, unknown>;
    const out: InlineQuestionAnswers = {};
    cards.forEach((card, index) => {
        const picked = labelsFor(byQuestion[card.question], card.multiSelect === true);
        if (picked.length) out[`question-${index}`] = picked;
    });
    return Object.keys(out).length > 0 ? out : undefined;
}

function labelsFor(value: unknown, multiSelect: boolean): string[] {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    }
    if (typeof value !== 'string' || !value) return [];
    if (!multiSelect) return [value];
    return value.split(', ').map((part) => part.trim()).filter(Boolean);
}
