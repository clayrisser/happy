import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import { Typography } from '@/constants/Typography';
import { storage, useSession } from '@/sync/storage';
import { useTickingNow } from './useTickingNow';
import {
    isLiveStatusFresh,
    summarizeLiveStatus,
    type LiveStatusRow,
} from '@/utils/liveStatus';

/**
 * The strip that says what the session is DOING (DROVE-54).
 *
 * Clay had the terminal on one screen showing six running agents with elapsed
 * times and token counts, a workflow's phase, and the running command with its
 * own timer — and the app for that same session showing a green dot and the
 * word "online". Everything the terminal drew was already on disk; the CLI now
 * reads it and publishes it on session metadata, and this draws it.
 *
 * Collapsed it is one line, because that is what fits above a keyboard: the
 * running tool with its argument and its timer, and the turn's own clock on
 * the right. Tapping it unfolds the tree — every agent, every workflow — and
 * tapping a row opens that tool's card in the transcript. Fold, never drop.
 *
 * It renders nothing at all when the session is idle. `metadata.liveStatus`
 * being absent IS idle: the CLI publishes nothing while nothing is running and
 * writes an explicit null the moment a turn ends.
 */

/**
 * The transcript message a tool_use id belongs to.
 *
 * The reducer already keeps this map — it is how a permission prompt finds the
 * tool call it is about — so a row can open the real card instead of this
 * component keeping a second index of the message list.
 */
function useMessageIdForTool(sessionId: string, toolId: string | undefined): string | null {
    return storage(useShallow((state) => {
        if (!toolId) return null;
        const reducer = state.sessionMessages[sessionId]?.reducerState;
        return reducer?.toolIdToMessageId.get(toolId) ?? null;
    }));
}

const rowIcon: Record<LiveStatusRow['kind'], React.ComponentProps<typeof Octicons>['name']> = {
    tool: 'terminal',
    agent: 'dependabot',
    workflow: 'workflow',
};

function LiveStatusTreeRow(props: { sessionId: string, row: LiveStatusRow }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const messageId = useMessageIdForTool(props.sessionId, props.row.toolId);
    const { row } = props;

    const body = (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 5,
            paddingHorizontal: 18,
        }}>
            <Octicons name={rowIcon[row.kind]} size={12} color={theme.colors.textSecondary} />
            <Text
                numberOfLines={1}
                style={{ fontSize: 12, color: theme.colors.text, flexShrink: 1, ...Typography.default() }}
            >
                {row.title}
            </Text>
            {row.detail ? (
                <Text
                    numberOfLines={1}
                    style={{ fontSize: 11, color: theme.colors.textSecondary, flexShrink: 1, ...Typography.mono() }}
                >
                    {row.detail}
                </Text>
            ) : null}
            <View style={{ flex: 1 }} />
            {row.progress ? (
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {row.progress}
                </Text>
            ) : null}
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.mono() }}>
                {row.elapsed}
            </Text>
            {row.tokens ? (
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.mono() }}>
                    {row.tokens}
                </Text>
            ) : null}
        </View>
    );

    // Only rows whose tool has actually reached the transcript are tappable. A
    // row with nowhere to go must not look like a button.
    if (!messageId) return body;
    return (
        <Pressable
            onPress={() => router.push(`/session/${props.sessionId}/message/${messageId}`)}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
            {body}
        </Pressable>
    );
}

export const SessionLiveStatus = React.memo(function SessionLiveStatus(props: { sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const [expanded, setExpanded] = React.useState(false);

    const live = session?.metadata?.liveStatus ?? null;
    const now = useTickingNow(!!live);
    const fresh = isLiveStatusFresh(live, now);
    const summary = React.useMemo(
        () => (live && fresh ? summarizeLiveStatus(live, now) : null),
        [live, fresh, now],
    );

    // Nothing is running: the strip is gone, not empty. An idle session looks
    // exactly as it did before this existed.
    if (!summary) return null;

    const canExpand = summary.rows.length > 0;

    return (
        <View style={{
            borderTopWidth: 0.5,
            borderTopColor: theme.colors.divider,
            backgroundColor: theme.colors.surface,
        }}>
            <Pressable
                onPress={canExpand ? () => setExpanded((open) => !open) : undefined}
                style={({ pressed }) => ({ opacity: pressed && canExpand ? 0.6 : 1 })}
                accessibilityRole={canExpand ? 'button' : undefined}
                accessibilityLabel={`Working: ${summary.headline}`}
            >
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 18,
                    paddingVertical: 7,
                }}>
                    <View style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: '#007AFF',
                    }} />
                    <Text
                        numberOfLines={1}
                        style={{ fontSize: 12, color: theme.colors.text, flexShrink: 1, ...Typography.default() }}
                    >
                        {summary.headline}
                    </Text>
                    <View style={{ flex: 1 }} />
                    {summary.subtitle && !expanded ? (
                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {summary.subtitle}
                        </Text>
                    ) : null}
                    {summary.turnElapsed ? (
                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.mono() }}>
                            {summary.turnElapsed}
                        </Text>
                    ) : null}
                    {canExpand ? (
                        <Ionicons
                            name={expanded ? 'chevron-down' : 'chevron-up'}
                            size={12}
                            color={theme.colors.textSecondary}
                        />
                    ) : null}
                </View>
            </Pressable>
            {expanded && canExpand ? (
                <ScrollView
                    // Capped rather than unbounded: Clay runs 4-12 agents at a
                    // time and an unfolded tree that eats the whole screen is
                    // worse than one that scrolls.
                    style={{ maxHeight: 180 }}
                    // The strip lives above the composer, so a nested scroll
                    // that steals the chat's gestures on web is worse than no
                    // scroll at all.
                    scrollEnabled={Platform.OS !== 'web'}
                >
                    <View style={{ paddingBottom: 4 }}>
                        {summary.rows.map((row) => (
                            <LiveStatusTreeRow key={row.key} sessionId={props.sessionId} row={row} />
                        ))}
                    </View>
                </ScrollView>
            ) : null}
        </View>
    );
});
