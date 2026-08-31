import * as React from 'react';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { Metadata } from '@/sync/storageTypes';
import { readBashResult } from './bashResult';

export const BashView = React.memo((props: { tool: ToolCall, metadata: Metadata | null }) => {
    const { input } = props.tool;
    // One reader shared with the full view (DROVE-95).
    const { error } = readBashResult(props.tool);

    return (
        <>
            <ToolSectionView>
                <CommandView 
                    command={input.command}
                    // Don't show output in compact view
                    stdout={null}
                    stderr={null}
                    error={error}
                    hideEmptyOutput
                />
            </ToolSectionView>
        </>
    );
});