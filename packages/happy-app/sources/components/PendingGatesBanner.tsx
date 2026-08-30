import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import type { StyleProp, ViewStyle } from 'react-native';

import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { usePendingGates } from '@/hooks/usePendingGates';
import { describePendingGates } from './pendingGatesSummary';

/**
 * "N waiting" at the top of the session list, with a way in (BASED-98).
 *
 * Before this, a pending request rendered in exactly ONE place: inside a
 * session's chat transcript. The home screen showed a per-session orange dot
 * and nothing else — no question text, no answer control — so a question that
 * had already reached the phone read as a session that was merely busy. That
 * is the whole of "why am I not seeing the questions on the mobile app".
 *
 * The subtitle carries the oldest gate's actual words for the same reason: a
 * banner that only counts is another dot.
 */
export const PendingGatesBanner = React.memo(({
    style,
    headerStyle,
}: {
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
}) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const gates = usePendingGates();
    const summary = describePendingGates(gates.map((entry) => entry.gate));

    if (!summary) return null;

    return (
        <ItemGroup style={style} headerStyle={headerStyle}>
            <Item
                title={summary.title}
                subtitle={summary.subtitle}
                icon={<Ionicons name="hand-left-outline" size={28} color={theme.colors.box.warning.text} />}
                showChevron={true}
                onPress={() => router.push('/gates')}
            />
        </ItemGroup>
    );
});

PendingGatesBanner.displayName = 'PendingGatesBanner';
