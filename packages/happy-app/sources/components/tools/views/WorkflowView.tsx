/**
 * Workflow as a card: the name, what it is for, and its phases (DROVE-51).
 *
 * A workflow script is many screens of code, so the transcript used to show
 * either a truncated blob or nothing useful. The meta block at the top of the
 * script is the part a reader wants; the script itself stays one tap away.
 *
 * Phases come out of the meta block by regex (see utils/workflowMeta) — a
 * script that computes its phases shows none, which is a card with less on it,
 * never an error.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { structuredRowsOmitting } from '@/utils/structuredFields';
import { getWorkflowScript, parseWorkflowMeta, parseWorkflowPhases } from '@/utils/workflowMeta';
import { RawDisclosure, RowsView } from '../StructuredFieldsView';
import { ToolResultView } from '../ToolResultView';
import { ToolViewProps } from './_all';

export const WorkflowView = React.memo<ToolViewProps>(({ tool }) => {
    const script = getWorkflowScript(tool.input);
    const meta = React.useMemo(() => parseWorkflowMeta(script), [script]);
    const phases = React.useMemo(() => parseWorkflowPhases(script), [script]);
    const rest = React.useMemo(
        () => structuredRowsOmitting(tool.input, ['script', 'code', 'source', 'workflow', 'content']),
        [tool.input],
    );

    return (
        <View style={styles.container}>
            {meta.name ? <Text style={styles.name}>{meta.name}</Text> : null}
            {meta.description ? <Text style={styles.description}>{meta.description}</Text> : null}
            {phases.length > 0 ? (
                <View style={styles.phases}>
                    {phases.map((phase, index) => (
                        <View key={`${phase.title}-${index}`} style={styles.phase}>
                            <Text style={styles.phaseIndex}>{index + 1}</Text>
                            <View style={styles.phaseBody}>
                                <Text style={styles.phaseTitle}>{phase.title}</Text>
                                {phase.detail ? <Text style={styles.phaseDetail}>{phase.detail}</Text> : null}
                            </View>
                        </View>
                    ))}
                </View>
            ) : null}
            {rest.length > 0 ? <RowsView rows={rest} /> : null}
            <ToolResultView result={tool.result} />
            {script ? <RawDisclosure value={script} title="Script" /> : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 8,
        paddingBottom: 4,
    },
    name: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    description: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
    },
    phases: {
        gap: 6,
    },
    phase: {
        flexDirection: 'row',
        gap: 8,
    },
    phaseIndex: {
        width: 18,
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    phaseBody: {
        flex: 1,
        minWidth: 0,
    },
    phaseTitle: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
    },
    phaseDetail: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.textSecondary,
    },
}));
