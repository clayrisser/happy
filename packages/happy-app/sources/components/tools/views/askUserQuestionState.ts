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
 * DROVE-51 and DROVE-52 arrived at this from opposite ends and it is one
 * function because there is one question: what did the user actually pick,
 * when the app's permission machinery never saw the answer? A session Claude
 * Code drives from a tmux pane has no `tool.permission` at all — the drover
 * PreToolUse hook holds the prompt and answers it in a gum popup — so the card
 * read `permission.reason`, found nothing, and drew "DROVE-50: —" for good.
 *
 * Two shapes, both copied off real drover transcripts:
 *  - on disk, `{questions: […], answers: {"<question text>": "<label>"}}`,
 *    which typesRaw.ts hands the reducer verbatim as `tool.result` (measured on
 *    session 19c2f0a8, tool_use toolu_01AAvS8Ps…, answered 18:32:20Z);
 *  - on the SDK path, the sentence `Your questions have been answered:
 *    "<question>"="<label>". …`.
 *
 * A multi-select arrives as one string joined with ", " — the same separator
 * providerAnswersFor writes and happy-cli's busResolutionFor splits on — so it
 * is split back apart here and nowhere else. Anything else yields undefined so
 * the caller keeps whatever it already knew; an empty map is never returned,
 * because an empty map is truthy and that is what drew the em dash.
 *
 * `id` is optional so a caller holding raw AskUserQuestionCards can pass them
 * straight in: the ids the form uses are positional (`question-0`), the same
 * key providerAnswersFor joins on, so the fallback here is the same rule.
 */
export function answersFromResult(
    result: unknown,
    questions: Array<{ id?: string; question: string; multiSelect?: boolean | null }>,
): InlineQuestionAnswers | undefined {
    if (questions.length === 0 || result === null || result === undefined) return undefined;

    const byQuestion = new Map<string, unknown>();
    const record = result as { answers?: unknown };
    if (
        typeof result === 'object'
        && record.answers
        && typeof record.answers === 'object'
        && !Array.isArray(record.answers)
    ) {
        for (const [question, label] of Object.entries(record.answers as Record<string, unknown>)) {
            byQuestion.set(question, label);
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
    questions.forEach((question, index) => {
        const picked = labelsFor(byQuestion.get(question.question), question.multiSelect === true);
        if (picked.length) answers[question.id ?? `question-${index}`] = picked;
    });
    return Object.keys(answers).length > 0 ? answers : undefined;
}

function labelsFor(value: unknown, multiSelect: boolean): string[] {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    }
    if (typeof value !== 'string' || !value) return [];
    if (!multiSelect) return [value];
    return value.split(', ').map((part) => part.trim()).filter(Boolean);
}
