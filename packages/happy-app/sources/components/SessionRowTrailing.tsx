import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getHarnessName } from '@/utils/harnessCatalog';
import { resolveAvatarHarness } from '@/utils/avatarHarness';
import { HarnessGlyph } from './HarnessGlyph';
import { StatusDot } from './StatusDot';
import { useSessionRowDot, type SessionDotFacts } from './sessionDot';
import {
    SESSION_ROW_GLYPH_SIZE,
    SESSION_ROW_INDICATOR_SLOT,
    SESSION_ROW_TRAILING_GAP,
    sessionRowIndicator,
} from './sessionRowTrailingLayout';

/**
 * The trailing end of a session row (DROVE-393): the harness glyph, then the
 * status dot.
 *
 * ONE component for the project-card row and the flat row, on purpose.
 * sessionRowTrailingLayout.ts has the why; sessionRowTrailingLayout.spec.ts holds both
 * rows to this file. Layout is the row's own flexbox: the cluster takes what
 * it needs and the text beside it shrinks, so nothing here is positioned by
 * a number.
 *
 * `dot` is null on retired work, and then the slot is not drawn at all. The
 * dot's clock is a hook that ticks while a session is down, so the slot is
 * its own component: a row with nothing to say starts no interval.
 */
export const SessionRowTrailing = React.memo(({ flavor, clientId, dot, hasDraft }: {
    flavor: string | null;
    clientId: string | null;
    dot: SessionDotFacts | null;
    /** What the slot may swap the dot for, not what the session has (DROVE-243). */
    hasDraft: boolean;
}) => {
    const styles = stylesheet;
    const harness = resolveAvatarHarness(flavor, clientId);

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

const stylesheet = StyleSheet.create(() => ({
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
}));
