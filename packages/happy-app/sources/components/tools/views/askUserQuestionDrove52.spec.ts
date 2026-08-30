import { describe, expect, it } from 'vitest';

import { questionCards, toInlineQuestions } from './askUserQuestionAnswers';
import { answersFromResolution, answersFromToolResult, isQuestionSettled } from './askUserQuestionState';
import { answerNotes, selectedOptionIndexes } from './inlineQuestionMatch';

/**
 * The card Clay photographed, rebuilt from the bytes that produced it.
 *
 * Session 19c2f0a8, tool_use toolu_01AAvS8PsHkcEw7yURzWD9SQ, raised
 * 2026-08-30T18:28:43Z and answered by the drover gum popup in tmux at
 * 18:32:20Z. `input` is copied verbatim from the assistant line of
 * ~/.claude-shared/projects/…/19c2f0a8….jsonl; `result` is the `toolUseResult`
 * of the tool_result line that followed, which is what typesRaw.ts hands the
 * reducer as `tool.result`.
 *
 * On screen it read "DROVE-50: —" and nothing else, and it stayed a dash after
 * he answered. Every assertion here is one half of why.
 */
const QUESTION = 'Every restart of drover creates a new session in the phone app, with empty history. Which fix?';

const input = {
    questions: [
        {
            question: QUESTION,
            header: 'DROVE-50',
            multiSelect: false,
            options: [
                {
                    label: 'Drover owns the picker (Recommended)',
                    description: "A bare `drover --resume` shows drover's own session list instead of Claude Code's.",
                },
                {
                    label: 'Late reattach at the hook',
                    description: "Keep Claude Code's picker.",
                },
                {
                    label: 'Archive and backfill',
                    description: 'Keep minting a new app session but archive the old one.',
                },
            ],
        },
    ],
};

const result = {
    questions: input.questions,
    answers: { [QUESTION]: 'Drover owns the picker (Recommended)' },
};

describe('the question card, from the real tool input', () => {
    it('carries the question and every option with its description', () => {
        const cards = questionCards(input);
        expect(cards).toHaveLength(1);

        const [question] = toInlineQuestions(cards);
        expect(question.header).toBe('DROVE-50');
        expect(question.question).toBe(QUESTION);
        expect(question.options.map((option) => option.label)).toEqual([
            'Drover owns the picker (Recommended)',
            'Late reattach at the hook',
            'Archive and backfill',
        ]);
        expect(question.options.every((option) => Boolean(option.description))).toBe(true);
    });

    it('is not settled while the hook is still holding it', () => {
        // No permission at all: a pane session's AskUserQuestion is owned by
        // the drover PreToolUse hook, not by the app's permission machinery.
        expect(isQuestionSettled(undefined, 'running')).toBe(false);
    });
});

describe('the answer given in tmux', () => {
    it('is read off the tool result, which is the only place it exists', () => {
        expect(answersFromResolution(undefined, 'completed', ['question-0'])).toBeUndefined();
        expect(answersFromToolResult(result, questionCards(input))).toEqual({
            'question-0': ['Drover owns the picker (Recommended)'],
        });
    });

    it('splits a multi-select back apart on the separator every surface writes', () => {
        const cards = [{ question: QUESTION, multiSelect: true }];
        expect(answersFromToolResult({ answers: { [QUESTION]: 'One, Two' } }, cards)).toEqual({
            'question-0': ['One', 'Two'],
        });
        expect(answersFromToolResult({ answers: { [QUESTION]: 'One, Two' } }, [{ question: QUESTION }])).toEqual({
            'question-0': ['One, Two'],
        });
    });

    it('says nothing rather than an empty map when the result has no answers', () => {
        // The empty map is what drew the em dash: truthy, so the card rendered
        // its "answered" face with nothing to put in it.
        expect(answersFromToolResult(undefined, questionCards(input))).toBeUndefined();
        expect(answersFromToolResult('Your questions have been answered', questionCards(input))).toBeUndefined();
        expect(answersFromToolResult({ answers: {} }, questionCards(input))).toBeUndefined();
        expect(answersFromToolResult({ answers: { 'a different question': 'x' } }, questionCards(input)))
            .toBeUndefined();
    });
});

describe('what the settled card shows', () => {
    const options = [
        { label: 'Drover owns the picker (Recommended)' },
        { label: 'Late reattach at the hook' },
        { label: 'Archive and backfill' },
    ];

    it('marks the option the tmux answer chose, and adds nothing else', () => {
        const answers = answersFromToolResult(result, questionCards(input))!['question-0'];
        expect(selectedOptionIndexes(options, answers)).toEqual(new Set([0]));
        expect(answerNotes(options, answers)).toEqual([]);
    });

    it('marks the option AND keeps the attribution when another surface won', () => {
        // completedReasonFor in happy-cli writes "<label> · by <surface>".
        const answers = ['Archive and backfill · by watch'];
        expect(selectedOptionIndexes(options, answers)).toEqual(new Set([2]));
        expect(answerNotes(options, answers)).toEqual(['Archive and backfill · by watch']);
    });

    it('shows a free-text answer under the options rather than losing it', () => {
        expect(selectedOptionIndexes(options, ['something else entirely'])).toEqual(new Set());
        expect(answerNotes(options, ['something else entirely'])).toEqual(['something else entirely']);
    });

    it('marks nothing and says nothing when there is no answer at all', () => {
        // The old card drew an em dash here. Now the question and its options
        // stay on screen, greyed, which is the honest reading of "not answered
        // on this surface".
        expect(selectedOptionIndexes(options, undefined)).toEqual(new Set());
        expect(answerNotes(options, undefined)).toEqual([]);
    });
});
