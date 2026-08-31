import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import { Typography } from '@/constants/Typography';
import { storage } from '@/sync/storage';
import type { LiveStatusRow } from '@/utils/liveStatus';

/**
 * The unfolded task tree: what the session is DOING, one row per running
 * thing (DROVE-54).
 *
 * Clay had the terminal on one screen showing six running agents with elapsed
 * times and token counts, a workflow's phase, and the running command with its
 * own timer, and the app for that same session showing a green dot and the
 * word "online". Everything the terminal drew was already on disk; the CLI now
 * reads it and publishes it on session metadata, and this draws it.
 *
 * This used to be its own strip above the composer with a one-line headline
 * folded over the tree. The headline now lives in the composer's status row
 * (AgentInputStatusRow, DROVE-82) so the chat gets the height back; the row
 * unfolds this tree under itself. Tapping a row opens that tool's card in the
 * transcript. Fold, never drop.
 */

/**
 * The transcript message a tool_use id belongs to.
 *
 * The reducer already keeps this map, it is how a permission prompt finds the
 * tool call it is about, so a row can open the real card instead of this
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

    // An agent row opens the agent's own transcript (DROVE-93): its prompt,
    // its tool calls, its result. Not the Task card, which for a background
    // agent holds the name and a check mark and nothing else.
    if (row.agentId) {
        const agentId = row.agentId;
        return (
            <Pressable
                onPress={() => router.push({
                    pathname: `/session/${props.sessionId}/agent/${agentId}`,
                    params: { label: row.title },
                })}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
                {body}
            </Pressable>
        );
    }

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

export const SessionLiveStatusTree = React.memo(function SessionLiveStatusTree(props: {
    sessionId: string;
    rows: LiveStatusRow[];
}) {
    return (
        <ScrollView
            // Capped rather than unbounded: Clay runs 4-12 agents at a time
            // and an unfolded tree that eats the whole screen is worse than
            // one that scrolls.
            style={{ maxHeight: 180 }}
            // The tree sits against the composer, so a nested scroll that
            // steals the chat's gestures on web is worse than no scroll at
            // all.
            scrollEnabled={Platform.OS !== 'web'}
        >
            <View style={{ paddingBottom: 4 }}>
                {props.rows.map((row) => (
                    <LiveStatusTreeRow key={row.key} sessionId={props.sessionId} row={row} />
                ))}
            </View>
        </ScrollView>
    );
});
