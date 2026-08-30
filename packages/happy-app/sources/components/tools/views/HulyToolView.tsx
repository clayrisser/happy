/**
 * The Huly ticket ops as a card: which ticket, its title, and what the op
 * changed (DROVE-51). Every drover session files, claims and updates tickets,
 * so `mcp__huly__*` is the MCP tool Clay sees most, and it used to reach the
 * phone as a compact row with the payload hidden behind a JSON blob.
 *
 * What the summary says is decided in utils/hulyTool; this file only draws it.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import { summarizeHulyTool } from '@/utils/hulyTool';
import { structuredRows } from '@/utils/structuredFields';
import { RawDisclosure, RowsView } from '../StructuredFieldsView';
import { ToolViewProps } from './_all';

export const HulyToolView = React.memo<ToolViewProps>(({ tool }) => {
    const summary = React.useMemo(
        () => summarizeHulyTool(tool.name, tool.input, tool.result),
        [tool.name, tool.input, tool.result],
    );
    const changeRows = React.useMemo(
        () => structuredRows(Object.fromEntries(summary.changes.map((change) => [change.key, change.value]))),
        [summary.changes],
    );

    return (
        <View style={styles.container}>
            <View style={styles.headline}>
                <Text style={styles.op}>{summary.op}</Text>
                {summary.identifier ? <Text style={styles.identifier}>{summary.identifier}</Text> : null}
                {summary.status ? <Text style={styles.chip}>{summary.status}</Text> : null}
                {summary.priority ? <Text style={styles.chip}>{summary.priority}</Text> : null}
            </View>
            {summary.title ? <Text style={styles.title}>{summary.title}</Text> : null}
            {changeRows.length > 0 ? <RowsView rows={changeRows} /> : null}
            {summary.text ? (
                <View style={styles.body}>
                    <Text style={styles.bodyText} numberOfLines={12}>{summary.text}</Text>
                </View>
            ) : null}
            {summary.items.length > 0 ? (
                <View style={styles.items}>
                    {summary.items.map((item) => (
                        <View key={item.identifier} style={styles.item}>
                            <Text style={styles.itemId}>{item.identifier}</Text>
                            <Text style={styles.itemTitle} numberOfLines={2}>{item.title}</Text>
                            {item.status ? <Text style={styles.chip}>{item.status}</Text> : null}
                        </View>
                    ))}
                </View>
            ) : null}
            <RawDisclosure value={tool.input} title={t('toolView.input')} />
            {tool.result !== undefined && tool.result !== null
                ? <RawDisclosure value={tool.result} title={t('toolView.output')} />
                : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 8,
        paddingBottom: 4,
    },
    headline: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
    op: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    identifier: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
    },
    chip: {
        fontSize: 11,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 4,
        paddingHorizontal: 6,
        overflow: 'hidden',
    },
    title: {
        fontSize: 14,
        lineHeight: 19,
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
    items: {
        gap: 6,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
    },
    itemId: {
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        minWidth: 74,
    },
    itemTitle: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
    },
}));
