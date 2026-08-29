import type { InlineQuestion, InlineQuestionAnswers } from './InlineQuestionForm';

/**
 * Reading an AskUserQuestion request and writing back the answer it expects.
 *
 * Split out of AskUserQuestionView so the global gates screen submits the
 * BYTE-IDENTICAL payload the chat transcript submits. Two surfaces building
 * their own idea of the answer is how the wrist ended up sending `optionId`
 * while the phone sent `answers` — the bridge now has to accept both
 * (busResolutionFor in happy-cli), and nobody wants a third shape.
 */

export interface AskUserQuestionCard {
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
}

/** The cards on a request, or [] when it carries none. */
export function questionCards(input: unknown): AskUserQuestionCard[] {
    const questions = (input as { questions?: unknown } | undefined)?.questions;
    if (!Array.isArray(questions)) return [];
    return questions.filter((card): card is AskUserQuestionCard => (
        !!card && typeof card === 'object' && typeof (card as AskUserQuestionCard).question === 'string'
    ));
}

/**
 * The form's shape. Ids are positional (`question-0`), which is also the key
 * providerAnswersFor joins on, so the two must be generated from the same
 * array in the same order.
 */
export function toInlineQuestions(cards: AskUserQuestionCard[]): InlineQuestion[] {
    return cards.map((card, index) => ({
        ...card,
        // A card that arrived without options still has to render: the form
        // maps over this array, and a missing one is a crash rather than an
        // unanswerable question.
        options: Array.isArray(card.options) ? card.options : [],
        header: typeof card.header === 'string' ? card.header : 'Question',
        id: `question-${index}`,
        required: true,
    }));
}

/**
 * Claude resolves AskUserQuestion through its permission callback and expects
 * the chosen values merged into the tool input, keyed by the question's own
 * text. A multi-select joins its labels with ", " — the CLI splits on that when
 * matching a label back to a bus option, so the separator is load-bearing.
 */
export function providerAnswersFor(
    cards: AskUserQuestionCard[],
    answers: InlineQuestionAnswers,
): Record<string, string> {
    const providerAnswers: Record<string, string> = {};
    cards.forEach((card, index) => {
        const selected = answers[`question-${index}`];
        if (selected?.length) {
            providerAnswers[card.question] = selected.join(', ');
        }
    });
    return providerAnswers;
}

/** Whether the card can actually be answered here, or only read. */
export function hasAnswerableOptions(cards: AskUserQuestionCard[]): boolean {
    return cards.some((card) => Array.isArray(card.options) && card.options.length > 0);
}
