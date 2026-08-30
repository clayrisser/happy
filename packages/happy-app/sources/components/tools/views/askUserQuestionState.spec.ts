import { describe, expect, it } from 'vitest';

import { answersFromResolution, isQuestionSettled } from './askUserQuestionState';

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
