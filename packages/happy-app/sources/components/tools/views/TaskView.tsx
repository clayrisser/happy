import * as React from 'react';
import { ToolViewProps } from './_all';
import { Text, View, ActivityIndicator, StyleSheet, Platform, Pressable } from 'react-native';
import { knownTools } from '../../tools/knownTools';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface FilteredTool {
    tool: ToolCall;
    title: string;
    state: 'running' | 'completed' | 'error';
}

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata, messages }) => {
    const { theme } = useUnistyles();
    // Every step the subagent took stays reachable, not just the last three.
    // Claude Code's own app lets you open a Task and watch the whole run; the
    // drover bridge already forwards the subagent's sidechain tool calls, so
    // the data was here — collapsing it to "+N more tools" with no way to
    // expand is what hid the run. Tap the footer to see all of it, tap again to
    // fold it back. Collapsed by default so a fan-out of tasks stays scannable.
    const [expanded, setExpanded] = React.useState(false);
    const filtered: FilteredTool[] = [];

    for (let m of messages) {
        if (m.kind === 'tool-call') {
            const knownTool = knownTools[m.tool.name as keyof typeof knownTools] as any;
            
            // Extract title using extractDescription if available, otherwise use title
            let title = m.tool.name;
            if (knownTool) {
                if ('extractDescription' in knownTool && typeof knownTool.extractDescription === 'function') {
                    title = knownTool.extractDescription({ tool: m.tool, metadata });
                } else if (knownTool.title) {
                    // Handle optional title and function type
                    if (typeof knownTool.title === 'function') {
                        title = knownTool.title({ tool: m.tool, metadata });
                    } else {
                        title = knownTool.title;
                    }
                }
            }

            if (m.tool.state === 'running' || m.tool.state === 'completed' || m.tool.state === 'error') {
                filtered.push({
                    tool: m.tool,
                    title,
                    state: m.tool.state
                });
            }
        }
    }

    const styles = StyleSheet.create({
        container: {
            paddingVertical: 4,
            paddingBottom: 12
        },
        toolItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 4,
            paddingLeft: 4,
            paddingRight: 2
        },
        toolTitle: {
            fontSize: 14,
            fontWeight: '500',
            color: theme.colors.textSecondary,
            fontFamily: 'monospace',
            flex: 1,
        },
        statusContainer: {
            marginLeft: 'auto',
            paddingLeft: 8,
        },
        loadingItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 8,
            paddingHorizontal: 4,
        },
        loadingText: {
            marginLeft: 8,
            fontSize: 14,
            color: theme.colors.textSecondary,
        },
        moreToolsItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 6,
            paddingHorizontal: 4,
        },
        moreToolsText: {
            fontSize: 14,
            color: theme.colors.textLink ?? theme.colors.textSecondary,
            fontWeight: '500',
        },
        chevron: {
            marginLeft: 4,
        },
    });

    if (filtered.length === 0) {
        return null;
    }

    // Collapsed shows the tail (what it is doing NOW); expanded shows the whole
    // run from the top so the order reads the way it happened.
    const COLLAPSED = 3;
    const canExpand = filtered.length > COLLAPSED;
    const visibleTools = expanded || !canExpand
        ? filtered
        : filtered.slice(filtered.length - COLLAPSED);

    return (
        <View style={styles.container}>
            {visibleTools.map((item, index) => (
                <View key={`${item.tool.name}-${index}`} style={styles.toolItem}>
                    <Text style={styles.toolTitle} numberOfLines={expanded ? 2 : 1}>{item.title}</Text>
                    <View style={styles.statusContainer}>
                        {item.state === 'running' && (
                            <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={theme.colors.warning} />
                        )}
                        {item.state === 'completed' && (
                            <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
                        )}
                        {item.state === 'error' && (
                            <Ionicons name="close-circle" size={16} color={theme.colors.textDestructive} />
                        )}
                    </View>
                </View>
            ))}
            {canExpand && (
                <Pressable
                    style={styles.moreToolsItem}
                    onPress={() => setExpanded((v) => !v)}
                    hitSlop={8}
                    accessibilityRole="button"
                >
                    <Text style={styles.moreToolsText}>
                        {expanded
                            ? t('tools.taskView.showLess')
                            : t('tools.taskView.showAll', { count: filtered.length })}
                    </Text>
                    <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={theme.colors.textLink ?? theme.colors.textSecondary}
                        style={styles.chevron}
                    />
                </Pressable>
            )}
        </View>
    );
});
