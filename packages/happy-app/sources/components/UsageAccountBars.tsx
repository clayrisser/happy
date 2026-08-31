/**
 * The usage popup's rows (DROVE-107).
 *
 * Clay, with a screenshot: "it should be displayed as bars and be more thin,
 * not take up so much space." Every account cost three text lines before this
 * - the name and percent on one, the reset time on the next, a long name
 * wrapping onto a third - so five accounts filled the phone and the percentage
 * was buried in a sentence.
 *
 * One row per account now: name, a track filled to the headroom left, the
 * number, and the reset or back-at time trailing behind it, truncated rather
 * than wrapped. Every row is the same height, current account included, so the
 * whole popup reads as a column of bars. The fill is coloured by headroom, not
 * by account, which is what makes 43% and 0% comparable down the column, and a
 * 0% row still draws its empty track so it is not an invisible row.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { UsageBarGroup, UsageBarRow, UsageBarTone } from './agentInputUsage';

/** Thin enough that eight rows cost less than the three-line block did for two. */
const rowHeight = 20;
const trackHeight = 5;
const nameWidth = 84;
const percentWidth = 34;

function toneColor(tone: UsageBarTone, theme: ReturnType<typeof useUnistyles>['theme']): string {
    switch (tone) {
        case 'critical':
            return theme.colors.warningCritical;
        // The theme's own `warning` is grey, which is the one thing this row
        // must not be: grey is what "never measured" looks like.
        case 'low':
            return theme.dark ? '#FF9F0A' : '#FF9500';
        case 'ample':
            return theme.colors.success;
        default:
            return theme.colors.textSecondary;
    }
}

export function UsageAccountBarRow(props: { row: UsageBarRow }) {
    const { theme } = useUnistyles();
    const row = props.row;
    const fill = toneColor(row.tone, theme);
    return (
        <View
            accessible
            accessibilityLabel={[
                row.fullName,
                row.percentText,
                row.trailing,
            ].filter(Boolean).join(', ')}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                height: rowHeight,
                gap: 8,
                opacity: row.disabled ? 0.5 : 1,
            }}
        >
            <Text
                numberOfLines={1}
                style={{
                    width: nameWidth,
                    fontSize: 11,
                    color: theme.colors.text,
                    ...Typography.default(),
                }}
            >
                {row.name}
            </Text>
            {/* The track is always drawn, so a 0% account is still a row you
                can see and count, not a gap in the column. */}
            <View style={{
                flex: 1,
                minWidth: 40,
                height: trackHeight,
                borderRadius: trackHeight / 2,
                backgroundColor: theme.colors.divider,
                overflow: 'hidden',
            }}>
                <View style={{
                    width: `${Math.round(row.fraction * 100)}%`,
                    height: '100%',
                    borderRadius: trackHeight / 2,
                    backgroundColor: fill,
                }} />
            </View>
            <Text
                numberOfLines={1}
                style={{
                    width: percentWidth,
                    textAlign: 'right',
                    fontSize: 11,
                    color: theme.colors.text,
                    ...Typography.default(),
                }}
            >
                {row.percentText ?? ''}
            </Text>
            {row.trailing ? (
                // Trailing, truncated, and allowed to shrink to nothing before
                // anything else on the row does: the time is the least of the
                // four facts and must never push the row onto a second line.
                <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{
                        flexShrink: 1,
                        maxWidth: 96,
                        fontSize: 10,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {row.trailing}
                </Text>
            ) : null}
        </View>
    );
}

export function UsageAccountBars(props: { groups: UsageBarGroup[] }) {
    const { theme } = useUnistyles();
    return (
        <View style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 2 }}>
            {props.groups.map((group, index) => (
                <View key={group.key} style={{ marginTop: index > 0 ? 8 : 2 }}>
                    {group.title ? (
                        <Text
                            numberOfLines={1}
                            style={{
                                fontSize: 10,
                                color: theme.colors.textSecondary,
                                marginBottom: 2,
                                ...Typography.default(),
                            }}
                        >
                            {group.title}
                        </Text>
                    ) : null}
                    {group.rows.map((row) => (
                        <UsageAccountBarRow key={row.key} row={row} />
                    ))}
                </View>
            ))}
        </View>
    );
}
