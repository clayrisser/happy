/**
 * A tool's structured input drawn as labelled rows instead of a JSON blob
 * (DROVE-51). Clay screenshotted a SendMessage card whose whole body was
 * `{ "to": …, "message": … }` and said the card should be standard, because
 * the input already IS structured.
 *
 * Every decision about WHAT a row says lives in utils/structuredFields; this
 * file only draws it, so the card and the tool detail screen render the same
 * rows and cannot drift apart again. The raw JSON stays one tap away — fold,
 * never drop.
 */
import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { t } from '@/text';
import { CodeView } from '@/components/CodeView';
import { DisclosureFooter, useInlineDisclosure } from '@/components/DisclosureFooter';
import { isInlineValue, rawJson, type StructuredRow, type StructuredValue } from '@/utils/structuredFields';

/** A folded text block shows this much before the reader asks for the rest. */
const foldedLines = 6;

const FoldedText = React.memo<{ text: string }>(({ text }) => {
    const [expanded, setExpanded] = React.useState(false);
    const lineCount = text.split('\n').length;
    // Only offer the toggle when there is genuinely something hidden.
    const foldable = lineCount > foldedLines || text.length > 400;

    return (
        <View style={styles.block}>
            <Text
                style={styles.blockText}
                numberOfLines={expanded || !foldable ? undefined : foldedLines}
            >
                {text}
            </Text>
            {foldable ? (
                <Pressable onPress={() => setExpanded((value) => !value)} hitSlop={8}>
                    <Text style={styles.more}>
                        {expanded ? t('toolView.showLess') : t('toolView.showMore')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});

const InlineValue = React.memo<{ value: StructuredValue }>(({ value }) => {
    switch (value.kind) {
        case 'empty':
            return <Text style={styles.emptyValue}>—</Text>;
        case 'boolean':
            return <Text style={styles.value}>{value.value ? 'yes' : 'no'}</Text>;
        case 'number':
            return <Text style={styles.monoValue}>{value.text}</Text>;
        case 'path':
            return <Text style={styles.monoValue} numberOfLines={2}>{value.path}</Text>;
        case 'text':
            return <Text style={styles.value}>{value.text}</Text>;
        default:
            return null;
    }
});

const BlockValue = React.memo<{ value: StructuredValue; depth: number }>(({ value, depth }) => {
    if (value.kind === 'text') {
        return <FoldedText text={value.text} />;
    }
    if (value.kind === 'list') {
        return (
            <View style={styles.list}>
                {value.items.map((item, index) => (
                    <View key={index} style={styles.listItem}>
                        <Text style={styles.bullet}>•</Text>
                        <View style={styles.listItemBody}>
                            {isInlineValue(item)
                                ? <InlineValue value={item} />
                                : <BlockValue value={item} depth={depth + 1} />}
                        </View>
                    </View>
                ))}
            </View>
        );
    }
    if (value.kind === 'object') {
        return (
            <View style={styles.nested}>
                <RowsView rows={value.rows} depth={depth + 1} />
            </View>
        );
    }
    return <InlineValue value={value} />;
});

const RowView = React.memo<{ row: StructuredRow; depth: number }>(({ row, depth }) => {
    // An alias is the same fact under a second name; it rides the label rather
    // than earning a second row (SendMessage sends `to`/`recipient`).
    const label = row.aliases.length > 0
        ? `${row.label} · ${row.aliases.join(' · ')}`
        : row.label;

    if (!label) {
        return isInlineValue(row.value)
            ? <View style={styles.row}><InlineValue value={row.value} /></View>
            : <BlockValue value={row.value} depth={depth} />;
    }

    if (isInlineValue(row.value)) {
        return (
            <View style={styles.inlineRow}>
                <Text style={styles.label} numberOfLines={2}>{label}</Text>
                <View style={styles.inlineValue}>
                    <InlineValue value={row.value} />
                </View>
            </View>
        );
    }

    return (
        <View style={styles.blockRow}>
            <Text style={styles.label}>{label}</Text>
            <BlockValue value={row.value} depth={depth} />
        </View>
    );
});

export const RowsView = React.memo<{ rows: StructuredRow[]; depth?: number }>(({ rows, depth = 0 }) => (
    <View style={styles.rows}>
        {rows.map((row, index) => (
            <RowView key={`${row.key}-${index}`} row={row} depth={depth} />
        ))}
    </View>
));

/**
 * The raw payload behind a tap. Deliberately not a `ToolCollapsibleSection`:
 * that one advertises a line count, and what matters here is that the reader
 * can still get at the exact bytes, not how many lines they are.
 */
export const RawDisclosure = React.memo<{ value: unknown; title?: string }>(({ value, title }) => {
    const { theme } = useUnistyles();
    const { expanded, toggle, collapse, headerRef, footerRef } = useInlineDisclosure();
    const label = title ?? t('toolView.raw');

    return (
        <View style={styles.rawSection}>
            <Pressable
                ref={headerRef}
                collapsable={false}
                onPress={toggle}
                hitSlop={6}
                style={({ pressed }) => [styles.rawHeader, pressed && styles.pressed]}
            >
                <Text style={styles.rawTitle}>{label}</Text>
                <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={13}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
            {expanded ? (
                <>
                    <CodeView code={rawJson(value)} />
                    <DisclosureFooter
                        label={label}
                        onPress={collapse}
                        innerRef={footerRef}
                        textStyle={styles.rawTitle}
                    />
                </>
            ) : null}
        </View>
    );
});

interface StructuredFieldsViewProps {
    rows: StructuredRow[];
    /** The payload the rows came from, kept reachable behind a tap. */
    raw?: unknown;
    rawTitle?: string;
}

export const StructuredFieldsView = React.memo<StructuredFieldsViewProps>(({ rows, raw, rawTitle }) => (
    <View>
        <RowsView rows={rows} />
        {raw !== undefined ? <RawDisclosure value={raw} title={rawTitle} /> : null}
    </View>
));

const styles = StyleSheet.create((theme) => ({
    rows: {
        gap: 6,
    },
    row: {
        flexDirection: 'row',
    },
    inlineRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    blockRow: {
        gap: 4,
    },
    label: {
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        // Wide enough for "subagent type" without stealing the value's room.
        minWidth: 76,
        maxWidth: 132,
    },
    inlineValue: {
        flex: 1,
        minWidth: 0,
    },
    value: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
    },
    emptyValue: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    monoValue: {
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    block: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 6,
    },
    blockText: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.text,
    },
    more: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textLink,
    },
    list: {
        gap: 4,
    },
    listItem: {
        flexDirection: 'row',
        gap: 6,
    },
    listItemBody: {
        flex: 1,
        minWidth: 0,
    },
    bullet: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    nested: {
        paddingLeft: 10,
        borderLeftWidth: 1,
        borderLeftColor: theme.colors.divider,
        gap: 6,
    },
    rawSection: {
        marginTop: 10,
        gap: 6,
    },
    rawHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 4,
    },
    pressed: {
        opacity: 0.6,
    },
    rawTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
}));
