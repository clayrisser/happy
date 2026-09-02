import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { getHarnessName } from '@/utils/harnessCatalog';
import { resolveAvatarHarness } from '@/utils/avatarHarness';
import { HarnessGlyph } from './HarnessGlyph';
import { StatusDot } from './StatusDot';
import { useSessionRowDot, type SessionDotFacts } from './sessionDot';
import {
    SESSION_ROW_GLYPH_SIZE,
    SESSION_ROW_INDICATOR_SLOT,
    SESSION_ROW_TIME_STYLE,
    SESSION_ROW_TRAILING_GAP,
    sessionRowIndicator,
    sessionRowTime,
} from './sessionRowTrailingLayout';

/**
 * The stamp at the edge of a row (DROVE-398). The flat row has one; the card
 * row does not.
 */
export interface SessionRowTime {
    /** Already formatted: sessionListTimestamp.ts owns the words. */
    text: string;
    /**
     * A colour when the stamp is carrying a signal, which on the flat row is
     * unread or a gate (flatSessionRowPresentation.ts). Null draws it in the
     * secondary text colour, which is nearly every row.
     */
    color: string | null;
    /** What a screen reader hears when the colour means something. */
    accessibilityLabel?: string;
}

/**
 * The trailing end of a session row (DROVE-393, DROVE-398): the harness
 * glyph, then the status dot, then the time.
 *
 * ONE component for the project-card row and the flat row, on purpose.
 * sessionRowTrailingLayout.ts has the why; sessionRowTrailingLayout.spec.ts
 * holds both rows to this file. Layout is the row's own flexbox: the cluster
 * takes what it needs and the title beside it shrinks, so nothing here is
 * positioned by a number and the time is never boxed into one.
 *
 * `dot` is null on retired work, and then the slot is not drawn at all. The
 * dot's clock is a hook that ticks while a session is down, so the slot is
 * its own component: a row with nothing to say starts no interval.
 *
 * `time` is null on a row with no stamp, and then the edge is simply empty.
 * Nothing else is ever drawn in its place: the 20pt unread badge that used to
 * take the time's column is gone, and the dot is drawn once, in the slot.
 */
export const SessionRowTrailing = React.memo(({ flavor, clientId, dot, hasDraft, time = null }: {
    flavor: string | null;
    clientId: string | null;
    dot: SessionDotFacts | null;
    /** What the slot may swap the dot for, not what the session has (DROVE-243). */
    hasDraft: boolean;
    time?: SessionRowTime | null;
}) => {
    const styles = stylesheet;
    const harness = resolveAvatarHarness(flavor, clientId);
    const stamp = time ? sessionRowTime(time.text) : null;

    return (
        <View style={styles.cluster}>
            {harness && (
                <HarnessGlyph
                    harness={harness}
                    size={SESSION_ROW_GLYPH_SIZE}
                    accessibilityLabel={getHarnessName(harness)}
                />
            )}
            {dot && <SessionRowIndicatorSlot dot={dot} hasDraft={hasDraft} />}
            {stamp !== null && time && (
                <Text
                    style={[styles.time, time.color !== null && { color: time.color }]}
                    numberOfLines={1}
                    accessibilityLabel={time.accessibilityLabel}
                >
                    {stamp}
                </Text>
            )}
        </View>
    );
});

const SessionRowIndicatorSlot = React.memo(({ dot, hasDraft }: {
    dot: SessionDotFacts;
    hasDraft: boolean;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const presentation = useSessionRowDot(dot);
    const indicator = sessionRowIndicator(presentation.state, hasDraft);

    return (
        <View style={styles.indicatorSlot}>
            {indicator === 'draft' ? (
                <Ionicons
                    name="create-outline"
                    size={14}
                    color={theme.colors.textSecondary}
                />
            ) : (
                <StatusDot
                    color={presentation.color}
                    isPulsing={presentation.isPulsing}
                    accessibilityLabel={presentation.label}
                />
            )}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    cluster: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: SESSION_ROW_TRAILING_GAP,
        gap: SESSION_ROW_TRAILING_GAP,
    },
    // 18 wide so the dot's centre lines up with the centre of the project
    // header's "+" button above the card, on both platform paddings
    // (DROVE-243).
    indicatorSlot: {
        alignItems: 'center',
        justifyContent: 'center',
        width: SESSION_ROW_INDICATOR_SLOT,
        height: SESSION_ROW_INDICATOR_SLOT,
    },
    // Its own width, never a column (DROVE-398): sessionRowTrailingLayout.ts.
    time: {
        ...SESSION_ROW_TIME_STYLE,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
}));
