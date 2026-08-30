/**
 * SendMessage as a card: who it went to, and what was said (DROVE-51).
 *
 * This is the tool call Clay screenshotted — six keys of raw JSON, two of them
 * the same value twice (`to`/`recipient`, `message`/`content`). The card names
 * the recipient once, leads with the summary the sender wrote, and gives the
 * body the room it needs. Everything else falls through to generic rows, so a
 * field this view has never heard of still shows up.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { structuredRowsOmitting } from '@/utils/structuredFields';
import { RawDisclosure, RowsView } from '../StructuredFieldsView';
import { ToolResultView } from '../ToolResultView';
import { ToolViewProps } from './_all';

/** Two names for the recipient, two for the body. Both pairs are one fact. */
const toKeys = ['to', 'recipient'];
const bodyKeys = ['message', 'content'];

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}

export const SendMessageView = React.memo<ToolViewProps>(({ tool }) => {
    const input = (tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
        ? tool.input
        : {}) as Record<string, unknown>;

    const to = firstString(input, toKeys);
    const body = firstString(input, bodyKeys);
    const summary = typeof input.summary === 'string' ? input.summary : undefined;

    const rest = React.useMemo(
        () => structuredRowsOmitting(input, [...toKeys, ...bodyKeys, 'summary']),
        [input],
    );

    return (
        <View style={styles.container}>
            {to ? (
                <View style={styles.toRow}>
                    <Text style={styles.arrow}>→</Text>
                    <Text style={styles.to} numberOfLines={1}>{to}</Text>
                </View>
            ) : null}
            {summary ? <Text style={styles.summary}>{summary}</Text> : null}
            {body ? (
                <View style={styles.body}>
                    <Text style={styles.bodyText}>{body}</Text>
                </View>
            ) : null}
            {rest.length > 0 ? <RowsView rows={rest} /> : null}
            <ToolResultView result={tool.result} mono={false} />
            <RawDisclosure value={tool.input} />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 8,
        paddingBottom: 4,
    },
    toRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    arrow: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    to: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    summary: {
        fontSize: 14,
        lineHeight: 19,
        fontWeight: '600',
        color: theme.colors.text,
    },
    body: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    bodyText: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.text,
    },
}));
