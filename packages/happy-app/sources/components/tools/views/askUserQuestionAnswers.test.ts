import { describe, expect, it } from 'vitest';

import {
    hasAnswerableOptions,
    providerAnswersFor,
    questionCards,
    toInlineQuestions,
} from './askUserQuestionAnswers';

const card = {
    question: 'Move this session to work-2?',
    header: 'Flip?',
    options: [{ label: 'Yes' }, { label: 'No, stay here' }],
};

describe('questionCards', () => {
    it('reads the cards off a request', () => {
        expect(questionCards({ questions: [card] })).toEqual([card]);
    });

    it('is empty for anything that is not a question card', () => {
        expect(questionCards(undefined)).toEqual([]);
        expect(questionCards({ command: 'ls' })).toEqual([]);
        expect(questionCards({ questions: 'nope' })).toEqual([]);
    });

    it('drops a malformed card, which keeps the ids and the answer map in step', () => {
        expect(questionCards({ questions: [null, card, { header: 'no body' }] })).toEqual([card]);
    });
});

describe('toInlineQuestions', () => {
    it('ids positionally, which is what providerAnswersFor joins on', () => {
        expect(toInlineQuestions([card, { ...card, question: 'And then?' }]).map((q) => q.id))
            .toEqual(['question-0', 'question-1']);
    });

    it('substitutes an empty options array rather than letting the form map over undefined', () => {
        const [question] = toInlineQuestions([{ question: 'Proceed?' } as never]);
        expect(question.options).toEqual([]);
        expect(question.header).toBe('Question');
    });
});

describe('providerAnswersFor', () => {
    it('keys the answer by the question text, the way Claude expects it back', () => {
        expect(providerAnswersFor([card], { 'question-0': ['Yes'] }))
            .toEqual({ 'Move this session to work-2?': 'Yes' });
    });

    it('joins a multi-select with ", ", which the CLI splits on to match an option', () => {
        expect(providerAnswersFor([card], { 'question-0': ['Yes', 'No, stay here'] }))
            .toEqual({ 'Move this session to work-2?': 'Yes, No, stay here' });
    });

    it('omits a question nobody answered instead of sending an empty string', () => {
        expect(providerAnswersFor([card], { 'question-0': [] })).toEqual({});
        expect(providerAnswersFor([card], {})).toEqual({});
    });
});

describe('hasAnswerableOptions', () => {
    it('is false when the request arrived with no choices to pick', () => {
        expect(hasAnswerableOptions([])).toBe(false);
        expect(hasAnswerableOptions([{ ...card, options: [] }])).toBe(false);
        expect(hasAnswerableOptions([card])).toBe(true);
    });
});
