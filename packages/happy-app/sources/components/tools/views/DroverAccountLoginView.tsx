import * as React from 'react';

import { sessionAllow } from '@/sync/ops';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { isQuestionSettled } from './askUserQuestionState';
import { DroverAccountLoginBody } from './DroverAccountLoginBody';

/**
 * Adding a Claude account without touching the Mac (DROVE-61), in the
 * transcript.
 *
 * `drover account login` starts Claude Code's own login on the Mac with no
 * terminal and puts the URL it printed on the bus. That card arrives here.
 * The link and the code field are DroverAccountLoginBody, which is shared with
 * the gate overlay and the gates screen — the card used to exist only in this
 * one place, so every other surface drew it as a generic Allow / Deny
 * permission with the raw JSON of its arguments for a body (DROVE-212).
 */
export const DroverAccountLoginView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const settled = isQuestionSettled(tool.permission, tool.state);
    const canInteract = tool.state === 'running' && !settled;

    const answer = React.useCallback(async (input: Record<string, unknown>) => {
        if (!sessionId || !tool.permission?.id) return;
        await sessionAllow(sessionId, tool.permission.id, undefined, undefined, 'approved', input);
    }, [sessionId, tool.permission?.id]);

    return (
        <ToolSectionView>
            <DroverAccountLoginBody
                args={tool.input}
                canInteract={canInteract}
                onAnswer={answer}
            />
        </ToolSectionView>
    );
});

DroverAccountLoginView.displayName = 'DroverAccountLoginView';
