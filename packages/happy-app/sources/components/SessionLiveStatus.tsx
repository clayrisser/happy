import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import { Typography } from '@/constants/Typography';
import { storage } from '@/sync/storage';
import { visibleRows, type LiveStatusRow } from '@/utils/liveStatus';
import { useComposerSheetNavigate } from './composerSheetNavigation';

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
 * transcript, and closes the sheet on the way (DROVE-183). Fold, never drop.
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

/**
 * Which WORKFLOW groups each session has unfolded, for the life of the app
 * (DROVE-290).
 *
 * Component state alone survives the once-a-second republish but not the
 * sheet closing, so a workflow Clay had opened snapped shut on every reopen.
 * Workflow keys only: an agent parent's fold keeps DROVE-185's per-mount
 * life, which its tests pin. Rows that leave the snapshot simply stop
 * consulting their entry, so a stale key costs bytes, never a wrong fold.
 */
const rememberedWorkflowFolds = new Map<string, ReadonlySet<string>>();

const isWorkflowGroup = (groupKey: string) => groupKey.startsWith('workflow:');

function LiveStatusTreeRow(props: {
    sessionId: string,
    row: LiveStatusRow,
    /** Whether this row's own children are showing, when it has any. */
    expanded?: boolean,
    onToggle?: () => void,
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    // Both rows below go through the sheet, not straight to the router
    // (DROVE-183). This tree IS the agents sheet's content, so a tap used to
    // push the agent screen with the sheet still open under it. Outside a
    // sheet this is the identity and the push is immediate.
    const leave = useComposerSheetNavigate();
    const messageId = useMessageIdForTool(props.sessionId, props.row.toolId);
    const { row } = props;

    const body = (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 5,
            paddingRight: 18,
            // One step per level, off the same 18 the flat list always used,
            // so a session with no nesting is pixel-for-pixel what it was.
            paddingLeft: 18 + row.depth * 14,
        }}>
            <Octicons name={rowIcon[row.kind]} size={12} color={theme.colors.textSecondary} />
            <Text
                numberOfLines={1}
                style={{ fontSize: 12, color: theme.colors.text, flexShrink: 1, ...Typography.default() }}
            >
                {row.title}
            </Text>
            {row.childCount && props.onToggle ? (
                // Its OWN hit target, not the row's (DROVE-185). Tapping the
                // row still opens the agent or the workflow's wave screen,
                // which is the first thing Clay reaches for; unfolding is the
                // second action and gets the second target.
                <Pressable
                    onPress={props.onToggle}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: !!props.expanded }}
                    accessibilityLabel={`${props.expanded ? 'Hide' : 'Show'} ${row.childCount} ${row.kind === 'workflow' ? 'workflow' : 'nested'} ${row.childCount === 1 ? 'agent' : 'agents'}`}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 2,
                        paddingHorizontal: 5,
                        paddingVertical: 1,
                        borderRadius: 8,
                        backgroundColor: theme.colors.surfaceHigh,
                        opacity: pressed ? 0.6 : 1,
                    })}
                >
                    <Octicons
                        name={props.expanded ? 'chevron-down' : 'chevron-right'}
                        size={10}
                        color={theme.colors.textSecondary}
                    />
                    <Text style={{ fontSize: 10, color: theme.colors.textSecondary, ...Typography.mono() }}>
                        {row.childCount}
                    </Text>
                </Pressable>
            ) : null}
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

    // A workflow row opens the run's wave screen (DROVE-290): the phases the
    // terminal's /workflows panel shows, with counts per wave and the failed
    // agents findable inside each.
    if (row.kind === 'workflow' && row.runId) {
        const runId = row.runId;
        return (
            <Pressable
                onPress={() => leave(() => router.push({
                    pathname: '/session/[id]/workflow/[runId]',
                    params: { id: props.sessionId, runId, name: row.title },
                }))}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
                {body}
            </Pressable>
        );
    }

    // An agent row opens the agent's own transcript (DROVE-93): its prompt,
    // its tool calls, its result. Not the Task card, which for a background
    // agent holds the name and a check mark and nothing else.
    if (row.agentId) {
        const agentId = row.agentId;
        return (
            <Pressable
                onPress={() => leave(() => router.push({
                    pathname: '/session/[id]/agent/[agentId]',
                    params: { id: props.sessionId, agentId, label: row.title },
                }))}
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
            onPress={() => leave(() => router.push(`/session/${props.sessionId}/message/${messageId}`))}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
            {body}
        </Pressable>
    );
}

export const SessionLiveStatusTree = React.memo(function SessionLiveStatusTree(props: {
    sessionId: string;
    rows: LiveStatusRow[];
    /**
     * 180 is what the tree got when it unfolded inside the composer's
     * furniture (DROVE-111). `null` means the caller is the cap: the sheet
     * grows to the screen and scrolls itself, so a second scroll view inside
     * it would fight the first (DROVE-201).
     */
    maxHeight?: number | null;
}) {
    const capped = props.maxHeight !== null;
    // Which parents are unfolded. Collapsed is the default (DROVE-185 for
    // agent parents, DROVE-290 for workflow groups): the top level stays the
    // readable list it has always been, and a parent's child count is the
    // thing that opens it. Held in state so it survives the once-a-second
    // republish, and mirrored into the module map so closing and reopening
    // the sheet does not snap every group shut again (DROVE-290).
    const sessionKey = props.sessionId;
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
        () => new Set(rememberedWorkflowFolds.get(sessionKey) ?? []),
    );
    const toggle = React.useCallback((groupKey: string) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(groupKey)) next.add(groupKey);
            rememberedWorkflowFolds.set(
                sessionKey,
                new Set([...next].filter(isWorkflowGroup)),
            );
            return next;
        });
    }, [sessionKey]);
    const drawn = React.useMemo(() => visibleRows(props.rows, expanded), [props.rows, expanded]);
    return (
        <ScrollView
            // Capped rather than unbounded where nothing else bounds it: Clay
            // runs 4-12 agents at a time and a tree that eats the whole screen
            // is worse than one that scrolls.
            style={capped ? { maxHeight: props.maxHeight ?? 180 } : undefined}
            // The tree sits against the composer, so a nested scroll that
            // steals the chat's gestures on web is worse than no scroll at
            // all.
            scrollEnabled={capped && Platform.OS !== 'web'}
        >
            <View style={{ paddingBottom: 4 }}>
                {drawn.map((row) => (
                    <LiveStatusTreeRow
                        key={row.key}
                        sessionId={props.sessionId}
                        row={row}
                        expanded={row.groupKey ? expanded.has(row.groupKey) : false}
                        onToggle={row.groupKey && row.childCount ? () => toggle(row.groupKey!) : undefined}
                    />
                ))}
            </View>
        </ScrollView>
    );
});
