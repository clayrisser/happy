/**
 * SendMessage as a card (DROVE-51).
 *
 * Claude Code's SendMessage tool is what a session uses to talk to its own
 * subagents and to other sessions, and it fires constantly while agents run
 * in parallel. The header row (from knownTools) already reads
 * `Message to <to>: <first line>`, so the card body starts folded: one
 * disclosure line, and behind it the summary the sender wrote, the whole
 * message as markdown, any field this card has never heard of as generic
 * rows, and the raw JSON. Fold, never drop.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { structuredRowsOmitting } from '@/utils/structuredFields';
import {
    sendMessageBody,
    sendMessageLineCount,
    sendMessageOutcome,
    sendMessageOwnKeys,
    sendMessageSummaryField,
} from '@/utils/sendMessageCard';
import { RawDisclosure, RowsView } from '../StructuredFieldsView';
import { ToolCollapsibleSection } from '../ToolCollapsibleSection';
import { ToolViewProps } from './_all';

export const SendMessageView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const body = sendMessageBody(tool.input);
    const summary = sendMessageSummaryField(tool.input);
    const lineCount = sendMessageLineCount(tool.input);
    const rest = React.useMemo(
        () => structuredRowsOmitting(tool.input, sendMessageOwnKeys),
        [tool.input],
    );
    const outcome = React.useMemo(() => sendMessageOutcome(tool.result), [tool.result]);

    return (
        <View style={styles.container}>
            <ToolCollapsibleSection title={t('tools.sendMessage.message')} lineCount={lineCount}>
                <View style={styles.expanded}>
                    {summary ? (
                        <View style={styles.summary}>
                            <Text style={styles.label}>{t('tools.sendMessage.summary')}</Text>
                            <Text style={styles.summaryText}>{summary}</Text>
                        </View>
                    ) : null}
                    {body ? (
                        <View style={styles.body}>
                            <MarkdownView markdown={body} sessionId={sessionId} />
                        </View>
                    ) : null}
                    {rest.length > 0 ? <RowsView rows={rest} /> : null}
                    {outcome?.ok && outcome.text ? (
                        <Text style={styles.delivered}>{outcome.text}</Text>
                    ) : null}
                    <RawDisclosure value={tool.input} />
                </View>
            </ToolCollapsibleSection>
            {/* A refusal from the bus is worth seeing without unfolding anything;
                the tool itself completed, so the card's error banner stays quiet. */}
            {outcome && !outcome.ok && outcome.text && tool.state !== 'error' ? (
                <Text style={styles.failed}>{outcome.text}</Text>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingBottom: 4,
    },
    expanded: {
        gap: 10,
    },
    summary: {
        gap: 2,
    },
    label: {
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    summaryText: {
        fontSize: 14,
        lineHeight: 19,
        fontWeight: '600',
        color: theme.colors.text,
    },
    body: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    delivered: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.textSecondary,
    },
    failed: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.warning,
        marginBottom: 8,
    },
}));
