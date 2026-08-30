/**
 * The card for a tool nobody wrote a view for (DROVE-51).
 *
 * There will always be more tools than views — every MCP server adds a dozen —
 * so the fallback has to be good, not a JSON dump. A tool input is a
 * JSON-schema'd object, which is enough to lay it out as labelled rows without
 * knowing the tool at all. The raw payload stays one tap away.
 */
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import { structuredRows } from '@/utils/structuredFields';
import { isEmptyToolResult } from '@/utils/toolResult';
import { StructuredFieldsView } from '../StructuredFieldsView';
import { ToolResultView } from '../ToolResultView';
import { ToolSectionView } from '../ToolSectionView';

interface GenericToolViewProps {
    input: unknown;
    result?: unknown;
    /** The detail screen labels its halves; the inline card is tight enough not to. */
    labelled?: boolean;
}

export const GenericToolView = React.memo<GenericToolViewProps>(({ input, result, labelled = false }) => {
    const rows = React.useMemo(() => structuredRows(input), [input]);
    const fields = rows.length > 0
        ? <StructuredFieldsView rows={rows} raw={input} />
        : null;
    const hasOutput = React.useMemo(() => !isEmptyToolResult(result), [result]);
    const output = <ToolResultView result={result} collapseLong={!labelled} />;

    if (!labelled) {
        return (
            <View style={styles.container}>
                {fields}
                {hasOutput ? <View style={styles.output}>{output}</View> : null}
            </View>
        );
    }

    return (
        <View>
            {fields ? <ToolSectionView title={t('toolView.input')}>{fields}</ToolSectionView> : null}
            {hasOutput ? <ToolSectionView title={t('toolView.output')}>{output}</ToolSectionView> : null}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        gap: 10,
        paddingBottom: 4,
    },
    output: {
        gap: 6,
    },
}));
