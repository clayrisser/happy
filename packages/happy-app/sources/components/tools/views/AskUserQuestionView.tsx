import * as React from 'react';

import { sessionAllow } from '@/sync/ops';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestion,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';
import { providerAnswersFor, questionCards, toInlineQuestions } from './askUserQuestionAnswers';
import { answersFromResolution, answersFromResult, isQuestionSettled } from './askUserQuestionState';

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const cards = React.useMemo(() => questionCards(tool.input), [tool.input]);
    const questions = React.useMemo<InlineQuestion[]>(() => toInlineQuestions(cards), [cards]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !tool.permission?.id) return;

        // Claude resolves AskUserQuestion through its permission callback and
        // expects the chosen values merged into the tool input. The gates
        // screen submits through the same helper, so the two surfaces cannot
        // drift apart.
        await sessionAllow(
            sessionId,
            tool.permission.id,
            undefined,
            undefined,
            'approved',
            { answers: providerAnswersFor(cards, answers) },
        );
    }, [cards, sessionId, tool.permission?.id]);

    // Settled the moment ANY surface answers — see askUserQuestionState for why
    // the tool's own state cannot decide that.
    const settled = isQuestionSettled(tool.permission, tool.state);
    // A question answered at the terminal never goes through this app's
    // permission, so the only record of the choice is the result Claude wrote.
    // Without this the card showed the question answered but not WHICH option
    // won, which is the half Clay actually wanted on the phone (DROVE-51).
    const answeredElsewhere = React.useMemo<InlineQuestionAnswers | undefined>(
        () => answersFromResolution(tool.permission, tool.state, questions.map((q) => q.id))
            ?? answersFromResult(tool.result, questions),
        [tool.permission, tool.state, tool.result, questions],
    );

    if (questions.length === 0) return null;

    return (
        <InlineQuestionForm
            questions={questions}
            canInteract={tool.state === 'running' && !settled}
            submittedAnswers={answeredElsewhere ?? (tool.state === 'completed' ? {} : undefined)}
            onSubmit={handleSubmit}
        />
    );
});
