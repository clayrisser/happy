import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import {
    AgentWorkGroupItem,
    ToolGroupItem,
    ToolDisplayItem,
    formatWorkDuration,
    generateGroupSummary,
    groupToolCallsForDisplay,
} from '@/hooks/useGroupedMessages';
import { MessageView } from './MessageView';
import { Metadata } from '@/sync/storageTypes';
import { layout } from './layout';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { t } from '@/text';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { getToolActivityLabel, getToolSummaryCategory, ToolSummaryCategory } from '@/utils/toolDisplay';
import { toolRunLabel } from '@/utils/toolRunGroups';
import { getToolRowRoute } from '@/utils/toolRowRoute';
import { useSubagentScope } from '@/sync/subagentMessages';
import { useRouter } from 'expo-router';
import { DisclosureFooter } from './DisclosureFooter';
import { footerCollapseAnchorY } from './inlineDisclosure';
import { edgeClearance, tapSlopFor } from './scrollIndicatorInset';

interface ToolGroupViewProps {
    group: ToolGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    onToggle: () => void;
    onAnchorLayoutChange?: (anchor: ToolGroupLayoutAnchor) => void;
    nested?: boolean;
    hideSingleToolChildren?: boolean;
    forceCompleted?: boolean;
}

export type ToolGroupLayoutAnchor = {
    node: View;
    y: number;
};

export const ToolGroupView = React.memo<ToolGroupViewProps>((props) => {
    const {
        group,
        metadata,
        sessionId,
        expanded,
        onToggle,
        onAnchorLayoutChange,
        nested,
        hideSingleToolChildren,
        forceCompleted,
    } = props;
    const router = useRouter();
    // Null in the session's own transcript, the agent's id on an agent screen
    // (DROVE-166).
    const agentId = useSubagentScope();
    // A same-tool run reads `Ran 4 shell commands` and opens onto the full
    // per-call rows, exactly as they draw on their own (DROVE-84).
    const runCategory = group.runCategory ?? null;
    const summary = React.useMemo(
        () => runCategory ? toolRunLabel(runCategory, group.messages.length) : generateGroupSummary(group.messages),
        [group.messages, runCategory],
    );
    const summaryCategory = React.useMemo(
        () => runCategory ?? getGroupSummaryCategory(group.messages),
        [group.messages, runCategory],
    );
    const hasRunning = !forceCompleted && group.hasRunning;
    const suppressChildren = hideSingleToolChildren && group.messages.length === 1 && group.messages[0]?.kind === 'tool-call';
    const singleToolMessage = suppressChildren && group.messages[0]?.kind === 'tool-call'
        ? group.messages[0]
        : null;
    const handleSingleToolPress = React.useCallback(() => {
        if (!singleToolMessage) {
            onToggle();
            return;
        }
        const route = getToolRowRoute({
            sessionId,
            agentId,
            messageId: singleToolMessage.id,
            tool: singleToolMessage.tool,
        });
        if (route) {
            router.push(route);
        }
    }, [agentId, onToggle, router, sessionId, singleToolMessage]);
    const handleAnchoredToggle = useAnchoredToggle(expanded, onToggle, onAnchorLayoutChange);
    // Every consolidated group draws the same openable row, a same-tool run
    // included. Folding a run saved vertical space; it never meant the command
    // and its output stopped being reachable (DROVE-152).
    const groupHeaderRef = React.useRef<View>(null);
    const { footerRef, collapse } = useGroupFooterCollapse(groupHeaderRef, handleAnchoredToggle);
    const renderGroupMessage = React.useCallback((msg: Message) => (
        <ToolGroupMessageRow
            key={msg.id}
            message={msg}
            metadata={metadata}
            sessionId={sessionId}
        />
    ), [metadata, sessionId]);

    const body = (
        <View style={nested ? styles.nestedInnerContainer : styles.innerContainer}>
            <CollapseHeader
                expanded={expanded}
                hasRunning={hasRunning}
                hasError={group.hasError}
                label={summary}
                onPress={singleToolMessage ? handleSingleToolPress : handleAnchoredToggle}
                category={summaryCategory}
                showChevron
                nodeRef={groupHeaderRef}
            />
            {expanded && !suppressChildren && (
                <View style={runCategory ? styles.runContent : styles.content}>
                    {group.messages.map(renderGroupMessage)}
                    <DisclosureFooter
                        label={summary}
                        onPress={collapse}
                        innerRef={footerRef}
                        textStyle={styles.summaryText}
                        style={styles.groupFooter}
                    />
                </View>
            )}
        </View>
    );

    if (nested) {
        return (
            <View style={styles.nestedOuterContainer}>
                {body}
            </View>
        );
    }

    return (
        <View style={styles.outerContainer}>
            {body}
        </View>
    );
});

interface AgentWorkGroupViewProps {
    group: AgentWorkGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    onToggle: () => void;
    onAnchorLayoutChange?: (anchor: ToolGroupLayoutAnchor) => void;
}

export const AgentWorkGroupView = React.memo<AgentWorkGroupViewProps>((props) => {
    const { group, metadata, sessionId, expanded, onToggle, onAnchorLayoutChange } = props;
    const isCompleted = group.completedAt !== null;
    const runningElapsedSeconds = useElapsedTime(group.completedAt === null ? group.startedAt : null);
    const durationMs = group.completedAt === null
        ? runningElapsedSeconds * 1000
        : group.completedAt - group.startedAt;
    const label = t('toolGroup.workedFor', { duration: formatWorkDuration(durationMs) });
    const handleAnchoredToggle = useAnchoredToggle(expanded, onToggle, onAnchorLayoutChange);
    const workHeaderRef = React.useRef<View>(null);
    const { footerRef, collapse } = useGroupFooterCollapse(workHeaderRef, handleAnchoredToggle);
    const nestedItemsNewestFirst = React.useMemo(
        () => groupToolCallsForDisplay(group.messages, true, { groupSingleToolCalls: true }),
        [group.messages],
    );
    const nestedItems = React.useMemo(
        () => [...nestedItemsNewestFirst].reverse(),
        [nestedItemsNewestFirst],
    );

    const [collapsedToolGroups, setCollapsedToolGroups] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        for (const item of nestedItemsNewestFirst) {
            if (item.type === 'tool-group' && !item.hasPendingPermission) {
                initial.add(item.id);
            }
        }
        return initial;
    });
    const manuallyCollapsedToolGroupsRef = React.useRef<Set<string>>(new Set());

    React.useEffect(() => {
        setCollapsedToolGroups((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const item of nestedItemsNewestFirst) {
                if (item.type !== 'tool-group') {
                    continue;
                }
                if (item.hasPendingPermission && next.has(item.id) && !manuallyCollapsedToolGroupsRef.current.has(item.id)) {
                    next.delete(item.id);
                    changed = true;
                    continue;
                }
                if (!item.hasPendingPermission && !next.has(item.id)) {
                    next.add(item.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [nestedItemsNewestFirst]);

    const handleToggleNestedGroup = React.useCallback((groupId: string) => {
        setCollapsedToolGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
                manuallyCollapsedToolGroupsRef.current.delete(groupId);
            } else {
                next.add(groupId);
                manuallyCollapsedToolGroupsRef.current.add(groupId);
            }
            return next;
        });
    }, []);

    const renderNestedItem = React.useCallback((item: ToolDisplayItem) => {
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    key={item.id}
                    group={item}
                    metadata={metadata}
                    sessionId={sessionId}
                    expanded={!collapsedToolGroups.has(item.id)}
                    onToggle={() => handleToggleNestedGroup(item.id)}
                    onAnchorLayoutChange={onAnchorLayoutChange}
                    nested
                    hideSingleToolChildren
                    forceCompleted={isCompleted}
                />
            );
        }
        return (
            <MessageView
                key={item.id}
                message={item.message}
                metadata={metadata}
                sessionId={sessionId}
            />
        );
    }, [collapsedToolGroups, handleToggleNestedGroup, isCompleted, metadata, onAnchorLayoutChange, sessionId]);

    return (
        <View style={styles.outerContainer}>
            <View style={styles.innerContainer}>
                <CollapseHeader
                    expanded={expanded}
                    hasRunning={!isCompleted && group.hasRunning}
                    label={label}
                    onPress={handleAnchoredToggle}
                    nodeRef={workHeaderRef}
                />
                {expanded && (
                    <View style={styles.content}>
                        {nestedItems.map(renderNestedItem)}
                        <DisclosureFooter
                            label={label}
                            onPress={collapse}
                            innerRef={footerRef}
                            textStyle={styles.summaryText}
                            style={styles.groupFooter}
                        />
                    </View>
                )}
            </View>
        </View>
    );
});

function CollapseHeader(props: {
    expanded: boolean;
    hasRunning: boolean;
    hasError?: boolean;
    label: string;
    onPress: (anchor?: ToolGroupLayoutAnchor) => void;
    category?: ToolSummaryCategory | null;
    showChevron?: boolean;
    disabled?: boolean;
    /** Handed out so the group's footer can put the list back on the header. */
    nodeRef?: React.RefObject<View | null>;
}) {
    const { theme } = useUnistyles();
    const showChevron = props.showChevron ?? true;
    const ownRef = React.useRef<View>(null);
    const headerRef = props.nodeRef ?? ownRef;
    const handlePress = React.useCallback(() => {
        const node = headerRef.current;
        if (!node) {
            props.onPress();
            return;
        }
        node.measureInWindow((_x, y, _width, height) => {
            if (!Number.isFinite(y) || height <= 0) {
                props.onPress();
                return;
            }
            props.onPress({ node, y });
        });
    }, [props.onPress]);
    const content = (
        <>
            {props.category ? (
                <View style={styles.headerIcon}>
                    <ToolSummaryIcon category={props.category} color={theme.colors.textSecondary} />
                </View>
            ) : null}
            <Text style={styles.summaryText} numberOfLines={1}>
                {props.label}
            </Text>
            {props.hasRunning && (
                <ActivityIndicator
                    size="small"
                    color={theme.colors.textSecondary}
                    style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
                />
            )}
            {props.hasError ? (
                <Ionicons name="alert-circle-outline" size={15} color={theme.colors.warning} />
            ) : null}
            {showChevron ? (
                <Ionicons
                    name={props.expanded ? 'chevron-down' : 'chevron-forward'}
                    size={13}
                    color={theme.colors.textSecondary}
                />
            ) : null}
        </>
    );

    if (props.disabled) {
        return (
            <View style={styles.header}>
                {content}
            </View>
        );
    }

    return (
        <Pressable
            ref={headerRef}
            collapsable={false}
            onPress={handlePress}
            hitSlop={tapSlopFor(groupHeaderHeight)}
            style={({ pressed }) => [
                styles.header,
                pressed && styles.headerPressed,
            ]}
        >
            {content}
        </Pressable>
    );
}

/**
 * The collapse row an expanded group wears at its end (DROVE-150). It measures
 * both rows before closing so the header lands where the finger already is,
 * then goes through the same anchored toggle the header uses.
 */
function useGroupFooterCollapse(
    headerRef: React.RefObject<View | null>,
    onPress: (anchor?: ToolGroupLayoutAnchor) => void,
): { footerRef: React.RefObject<View | null>; collapse: () => void } {
    const footerRef = React.useRef<View>(null);
    const collapse = React.useCallback(() => {
        const footer = footerRef.current;
        const header = headerRef.current;
        if (!footer || !header) {
            onPress();
            return;
        }
        footer.measureInWindow((_fx, footerY) => {
            header.measureInWindow((_hx, headerY) => {
                const y = footerCollapseAnchorY(headerY, footerY);
                onPress(y === null ? undefined : { node: header, y });
            });
        });
    }, [headerRef, onPress]);
    return { footerRef, collapse };
}

function useAnchoredToggle(
    expanded: boolean,
    onToggle: () => void,
    onAnchorLayoutChange?: (anchor: ToolGroupLayoutAnchor) => void,
): (anchor?: ToolGroupLayoutAnchor) => void {
    const pendingAnchorRef = React.useRef<ToolGroupLayoutAnchor | null>(null);

    React.useLayoutEffect(() => {
        const anchor = pendingAnchorRef.current;
        if (!anchor) {
            return;
        }
        pendingAnchorRef.current = null;
        onAnchorLayoutChange?.(anchor);
    }, [expanded, onAnchorLayoutChange]);

    return React.useCallback((anchor?: ToolGroupLayoutAnchor) => {
        pendingAnchorRef.current = anchor ?? null;
        onToggle();
    }, [onToggle]);
}

function ToolGroupMessageRow(props: {
    message: Message;
    metadata: Metadata | null;
    sessionId: string;
}) {
    if (props.message.kind !== 'tool-call') {
        return (
            <MessageView
                message={props.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
            />
        );
    }

    const shouldRenderFullTool = props.message.tool.permission?.status === 'pending'
        || props.message.tool.name === 'AskUserQuestion'
        || props.message.tool.name === 'request_user_input';
    if (shouldRenderFullTool) {
        return (
            <MessageView
                message={props.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
            />
        );
    }

    return (
        <ToolSummaryRow
            message={props.message}
            sessionId={props.sessionId}
        />
    );
}

function ToolSummaryRow(props: {
    message: ToolCallMessage;
    sessionId: string;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const agentId = useSubagentScope();
    const { tool } = props.message;
    const category = getToolSummaryCategory(tool.name);
    const label = getToolActivityLabel(tool);
    const route = getToolRowRoute({
        sessionId: props.sessionId,
        agentId,
        messageId: props.message.id,
        tool,
    });
    const isRunning = tool.state === 'running';
    const isError = tool.state === 'error'
        && tool.permission?.status !== 'denied'
        && tool.permission?.status !== 'canceled';
    const handlePress = React.useCallback(() => {
        if (route) {
            router.push(route);
        }
    }, [route, router]);

    const content = (
        <>
            <View style={styles.toolSummaryIcon}>
                <ToolSummaryIcon
                    category={category}
                    color={theme.colors.textSecondary}
                    size={18}
                    toolName={tool.name}
                />
            </View>
            <Text style={styles.toolSummaryLabel} numberOfLines={1}>
                {label}
            </Text>
            {isRunning ? (
                <ActivityIndicator
                    size="small"
                    color={theme.colors.textSecondary}
                    style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
                />
            ) : null}
            {isError ? (
                <Ionicons name="alert-circle-outline" size={15} color={theme.colors.warning} />
            ) : null}
            {route ? (
                <Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} />
            ) : null}
        </>
    );

    if (!route) {
        return (
            <View style={styles.toolSummaryRow}>
                {content}
            </View>
        );
    }

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={handlePress}
            style={({ pressed }) => [
                styles.toolSummaryRow,
                pressed && styles.toolSummaryRowPressed,
            ]}
        >
            {content}
        </Pressable>
    );
}

function ToolSummaryIcon(props: {
    category: ToolSummaryCategory;
    color: string;
    size?: number;
    toolName?: string;
}) {
    const size = props.size ?? 12;
    if (props.toolName === 'WebSearch') {
        return <Ionicons name="globe-outline" size={size + 1} color={props.color} />;
    }
    switch (props.category) {
        case 'terminal':
            return <Octicons name="terminal" size={size} color={props.color} />;
        case 'edit':
            return <Octicons name="file-diff" size={size} color={props.color} />;
        case 'read':
            return <Octicons name="eye" size={size} color={props.color} />;
        case 'search':
            return <Octicons name="search" size={size} color={props.color} />;
        case 'web':
            return <Ionicons name="globe-outline" size={size + 1} color={props.color} />;
        case 'task':
            return <Octicons name="rocket" size={size} color={props.color} />;
        default:
            return <Ionicons name="construct-outline" size={size + 1} color={props.color} />;
    }
}

function getGroupSummaryCategory(messages: Message[]): ToolSummaryCategory | null {
    const categories = new Set<ToolSummaryCategory>();
    for (const message of messages) {
        if (message.kind === 'tool-call') {
            categories.add(getToolSummaryCategory(message.tool.name));
        }
    }
    if (categories.size === 1) {
        return categories.values().next().value ?? null;
    }
    return categories.size > 1 ? 'other' : null;
}

// isFileEditTool moved to utils/toolRowRoute.ts with DROVE-152, so the card,
// the folded child and the group row all ask one function where a row opens.

const groupHeaderMargin = 16;
const groupHeaderHeight = 28;

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    innerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        maxWidth: layout.maxWidth,
        marginVertical: 8,
        overflow: 'hidden',
    },
    nestedOuterContainer: {
        overflow: 'hidden',
    },
    nestedInnerContainer: {
        minWidth: 0,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'stretch',
        marginHorizontal: groupHeaderMargin,
        minHeight: groupHeaderHeight,
        paddingVertical: 4,
        borderRadius: 4,
        // The 16pt margin already clears the scroll indicator (DROVE-156).
        paddingRight: edgeClearance(groupHeaderMargin),
    },
    headerPressed: {
        opacity: 0.6,
    },
    headerIcon: {
        width: 14,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    summaryText: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    content: {
        marginTop: 6,
        gap: 4,
    },
    // Sits level with the header it mirrors, so the two chevrons line up.
    groupFooter: {
        marginTop: 2,
        marginHorizontal: groupHeaderMargin,
        paddingRight: edgeClearance(groupHeaderMargin),
    },
    // The per-call rows of a same-tool run sit a step in from the header so
    // the list reads as one folded item, not four loose ones.
    runContent: {
        marginTop: 2,
        paddingLeft: 12,
    },
    toolSummaryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 32,
        marginHorizontal: 16,
        paddingVertical: 5,
        borderRadius: 4,
        overflow: 'hidden',
    },
    // The row is a way in, not a label, so it dims and tints under a finger.
    toolSummaryRowPressed: {
        opacity: 0.65,
        backgroundColor: theme.colors.surfaceHigh,
    },
    toolSummaryIcon: {
        width: 20,
        height: 22,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    toolSummaryLabel: {
        flex: 1,
        minWidth: 0,
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.textSecondary,
    },
}));
