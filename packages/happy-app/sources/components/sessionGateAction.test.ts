import { describe, expect, it } from 'vitest';

import { sessionGateAction, sessionGateReadOnlyHint } from './sessionGateAction';

const questionArgs = {
    questions: [{
        header: 'DROVE-50',
        question: 'Who owns the picker?',
        options: [
            { label: 'Drover owns it', description: 'The wrapper draws the menu' },
            { label: 'Claude owns it' },
        ],
    }],
};

describe('sessionGateAction', () => {
    it('answers a question with its own options', () => {
        expect(sessionGateAction('question', questionArgs)).toBe('answer-question');
    });

    it('gives a permission Allow and Deny', () => {
        expect(sessionGateAction('permission', { command: 'rm -rf build' })).toBe('allow-deny');
    });

    // Denying a question resolves it for every other surface with no answer to
    // hand back, which is why the bus refuses a bare allow on one. A question
    // that arrived without options is readable here and answered where it was
    // raised, never guessed at with a yes/no.
    it('never offers Allow and Deny for a question, options or not', () => {
        expect(sessionGateAction('question', { questions: [{ question: 'Proceed?', options: [] }] }))
            .toBe('read-only');
        expect(sessionGateAction('question', {})).toBe('read-only');
    });
});

describe('sessionGateReadOnlyHint', () => {
    // The gates SCREEN says "Open the session to answer this one". Saying that
    // on the session view sends you hunting for a screen you are standing on,
    // which is the whole of DROVE-19.
    it('does not tell you to open the session you are already in', () => {
        expect(sessionGateReadOnlyHint.toLowerCase()).not.toContain('open the session');
    });
});
