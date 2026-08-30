import { describe, expect, it } from 'vitest';

import { answersFromResolution, answersFromResult, isQuestionSettled } from './askUserQuestionState';

describe('isQuestionSettled', () => {
    it('stays open while the permission is pending', () => {
        expect(isQuestionSettled({ status: 'pending' }, 'running')).toBe(false);
    });

    it('closes on approval even though the tool goes back to running', () => {
        // The drover regression: another surface answered, the reducer set the
        // request approved and the tool state back to 'running', and the phone
        // kept a live question on screen.
        expect(isQuestionSettled({ status: 'approved' }, 'running')).toBe(true);
        expect(isQuestionSettled({ status: 'canceled' }, 'running')).toBe(true);
    });

    it('falls back to the tool state when there is no permission at all', () => {
        expect(isQuestionSettled(null, 'running')).toBe(false);
        expect(isQuestionSettled(undefined, 'completed')).toBe(true);
    });
});

describe('answersFromResolution', () => {
    it('shows what the winning surface picked', () => {
        expect(answersFromResolution(
            { status: 'approved', reason: 'Popup stayed open · by watch' },
            'running',
            ['question-0'],
        )).toEqual({ 'question-0': ['Popup stayed open · by watch'] });
    });

    it('says nothing rather than an empty map, so a local submit keeps its labels', () => {
        expect(answersFromResolution({ status: 'approved' }, 'running', ['question-0'])).toBeUndefined();
        expect(answersFromResolution({ status: 'pending' }, 'running', ['question-0'])).toBeUndefined();
        expect(answersFromResolution({ status: 'approved', reason: 'x' }, 'running', [])).toBeUndefined();
    });
});

describe('answersFromResult', () => {
    const questions = [{ id: 'question-0', question: 'Drover self-test 1 of 2 — the native Claude prompt. Which surface are you answering this on?' }];

    it('reads the choice off the on-disk toolUseResult', () => {
        expect(answersFromResult(
            { questions: [], answers: { [questions[0].question]: 'watch' } },
            questions,
        )).toEqual({ 'question-0': ['watch'] });
    });

    it('reads the choice off the SDK sentence, even when the question quotes something', () => {
        const q = 'Step 2 was the gum popup titled "Drover self-test 2 of 2" at 23:38. What happened on your end?';
        const text = `Your questions have been answered: "${q}"="Saw it, clicked Yes". You can now continue with these answers in mind.`;
        expect(answersFromResult(text, [{ id: 'question-0', question: q }])).toEqual({ 'question-0': ['Saw it, clicked Yes'] });
    });

    it('says nothing for a result that carries no answer', () => {
        expect(answersFromResult(undefined, questions)).toBeUndefined();
        expect(answersFromResult('Tool ran', questions)).toBeUndefined();
        expect(answersFromResult({ answers: { other: 'x' } }, questions)).toBeUndefined();
    });
});
