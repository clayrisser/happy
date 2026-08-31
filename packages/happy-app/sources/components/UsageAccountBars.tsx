/**
 * The usage popup's rows (DROVE-107), in fixed columns (DROVE-117).
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
 *
 * DROVE-117 made the columns hold their width. The first cut let the track
 * take whatever the trailing text did not use, so `jamrizzi` with no reset
 * time drew a longer bar than `bitspur.com` at a similar headroom, and `main`
 * with no figure left a hole where the number goes. Bar length then encoded
 * two different things at once and the column stopped being comparable, which
 * was the only reason to draw bars. Now the track is one fixed width for the
 * whole popup, computed from the measured container, the number column always
 * renders (a dash when nothing was measured) and the trailing column always
 * holds its slot whether or not there is a time to put in it.
 */
import * as React from 'react';
import { LayoutChangeEvent, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import {
    usageBarColumns,
    usageBarPercentLabel,
    usageBarTrackWidth,
    type UsageBarGroup,
    type UsageBarRow,
    type UsageBarTone,
} from './agentInputUsage';

/** Thin enough that eight rows cost less than the three-line block did for two. */
const rowHeight = 20;
const trackHeight = 5;

/**
 * What the track is drawn at until the container has been measured. A phone
 * width, so the first frame is the right shape rather than a stub that jumps.
 */
export const usageBarFallbackWidth = 345;

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

export function UsageAccountBarRow(props: { row: UsageBarRow; trackWidth?: number }) {
    const { theme } = useUnistyles();
    const row = props.row;
    const fill = toneColor(row.tone, theme);
    const trackWidth = props.trackWidth ?? usageBarTrackWidth(usageBarFallbackWidth);
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
                gap: usageBarColumns.gap,
                opacity: row.disabled ? 0.5 : 1,
            }}
        >
            <Text
                numberOfLines={1}
                style={{
                    width: usageBarColumns.name,
                    fontSize: 11,
                    color: theme.colors.text,
                    ...Typography.default(),
                }}
            >
                {row.name}
            </Text>
            {/* The track is always drawn, so a 0% account is still a row you
                can see and count, not a gap in the column. Fixed width, never
                flex: a row with no trailing text must not get a longer bar. */}
            <View style={{
                width: trackWidth,
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
            {/* Always rendered. An unmeasured account shows a dash and keeps
                the column, rather than sliding the row's tail leftward. */}
            <Text
                numberOfLines={1}
                style={{
                    width: usageBarColumns.percent,
                    textAlign: 'right',
                    fontSize: 11,
                    color: row.percentText ? theme.colors.text : theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {usageBarPercentLabel(row.percentText)}
            </Text>
            {/* Trailing, truncated, and holding its slot even when empty: the
                time is the least of the four facts, it must never push the row
                onto a second line, and it must never lend its width to the
                track of the one row that happens to lack it. */}
            <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{
                    width: usageBarColumns.trailing,
                    fontSize: 10,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {row.trailing}
            </Text>
        </View>
    );
}

export function UsageAccountBars(props: { groups: UsageBarGroup[]; width?: number }) {
    const { theme } = useUnistyles();
    const [measured, setMeasured] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        setMeasured((current) => (current === width ? current : width));
    }, []);
    const trackWidth = usageBarTrackWidth(props.width ?? measured ?? usageBarFallbackWidth);
    return (
        <View
            onLayout={props.width == null ? onLayout : undefined}
            style={{
                paddingHorizontal: usageBarColumns.horizontalPadding,
                paddingTop: 4,
                paddingBottom: 2,
            }}
        >
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
                        <UsageAccountBarRow key={row.key} row={row} trackWidth={trackWidth} />
                    ))}
                </View>
            ))}
        </View>
    );
}
