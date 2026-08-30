import * as React from 'react';

import { sessionAllow } from '@/sync/ops';
import { useGateForQuestion } from '@/hooks/usePendingGates';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestion,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';
import { providerAnswersFor, questionCards, toInlineQuestions } from './askUserQuestionAnswers';
import { answersFromResolution, answersFromToolResult, isQuestionSettled } from './askUserQuestionState';

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const cards = React.useMemo(() => questionCards(tool.input), [tool.input]);
    const questions = React.useMemo<InlineQuestion[]>(() => toInlineQuestions(cards), [cards]);
    const gate = useGateForQuestion(cards[0]?.question ?? '');

    // Where an answer typed here has to go. A session Claude Code drives from
    // a tmux pane carries no permission on the tool — the drover PreToolUse
    // hook is holding the answer — so the card submits against the bus event
    // mirrored into the bridge session instead (DROVE-52). Without this the
    // in-session card drew a full form whose Submit silently did nothing.
    const target = React.useMemo(() => {
        if (sessionId && tool.permission?.id) {
            return { sessionId, requestId: tool.permission.id };
        }
        return gate ? { sessionId: gate.sessionId, requestId: gate.requestId } : null;
    }, [gate, sessionId, tool.permission?.id]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!target) return;

        // Claude resolves AskUserQuestion through its permission callback and
        // expects the chosen values merged into the tool input. The gates
        // screen submits through the same helper, so the two surfaces cannot
        // drift apart.
        await sessionAllow(
            target.sessionId,
            target.requestId,
            undefined,
            undefined,
            'approved',
            { answers: providerAnswersFor(cards, answers) },
        );
    }, [cards, target]);

    // Settled the moment ANY surface answers — see askUserQuestionState for why
    // the tool's own state cannot decide that.
    const settled = isQuestionSettled(tool.permission, tool.state);
    // Two places an answer can be, in the order they become true. The
    // permission's reason is written by the bridge when another surface won the
    // race; the tool result is what Claude Code itself recorded once the hook
    // returned, and it is the ONLY record of a gum-popup answer. There is no
    // third fallback: passing an empty map here is what drew "DROVE-50: —" and
    // left it a dash for good (DROVE-52).
    const answeredElsewhere = React.useMemo<InlineQuestionAnswers | undefined>(
        () => answersFromResolution(tool.permission, tool.state, questions.map((q) => q.id))
            ?? answersFromToolResult(tool.result, cards),
        [cards, tool.permission, tool.result, tool.state, questions],
    );

    if (questions.length === 0) return null;

    return (
        <InlineQuestionForm
            questions={questions}
            canInteract={tool.state === 'running' && !settled && target !== null}
            submittedAnswers={answeredElsewhere}
            onSubmit={handleSubmit}
        />
    );
});
