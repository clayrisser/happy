import * as React from 'react';
import { Text, View, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { getToolViewComponent } from './views/_all';
import { GenericToolView } from './views/GenericToolView';
import { hulyToolTitle, isHulyTool } from '@/utils/hulyTool';
import { Message, ToolCall } from '@/sync/typesMessage';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { ToolError } from './ToolError';
import { knownTools } from '@/components/tools/knownTools';
import { Metadata } from '@/sync/storageTypes';
import { useRouter } from 'expo-router';
import { PermissionFooter } from './PermissionFooter';
import { parseToolUseError } from '@/utils/toolErrorParser';
import {
    formatMCPTitle,
    getToolActivityLabel,
    getTerminalToolCommand,
    shouldRenderToolCardHeader,
    shouldUseCompactToolRow,
} from '@/utils/toolDisplay';
import { useSetting } from '@/sync/storage';
import { InlineImage } from '@/components/InlineImage';
import { toolResultImage } from '@/utils/imageResult';
import { getToolRowRoute } from '@/utils/toolRowRoute';
import { useSubagentScope } from '@/sync/subagentMessages';

interface ToolViewProps {
    metadata: Metadata | null;
    tool: ToolCall;
    messages?: Message[];
    onPress?: () => void;
    sessionId?: string;
    messageId?: string;
}

export const ToolView = React.memo<ToolViewProps>((props) => {
    const { tool, onPress, sessionId, messageId } = props;
    const router = useRouter();
    const { theme } = useUnistyles();
    const compactToolCalls = useSetting('compactToolCalls');
    // Null in the session's own transcript, the agent's id on an agent screen
    // (DROVE-166).
    const agentId = useSubagentScope();

    // A card and a row inside a consolidated group open the same detail, so
    // both ask the same function where that is (DROVE-152). That function also
    // owns the file-editing special case this used to inline.
    const route = getToolRowRoute({ sessionId, agentId, messageId, tool });

    // When a tool reads an image the image IS the result, so it belongs in the
    // transcript rather than two taps inside the detail screen (DROVE-151).
    const resultImage = React.useMemo(
        () => (tool.state === 'completed' ? toolResultImage(tool.result) : null),
        [tool.state, tool.result],
    );

    const handlePress = React.useCallback(() => {
        if (onPress) {
            onPress();
            return;
        }
        if (route) {
            router.push(route);
        }
    }, [onPress, route, router]);

    const isPressable = !!(onPress || route);

    let knownTool = knownTools[tool.name as keyof typeof knownTools] as any;

    // Internal Claude Code tools (e.g. ToolSearch) are completely hidden from the UI
    if (knownTool?.hidden) {
        return null;
    }

    let description: string | null = null;
    let status: string | null = null;
    let minimal = false;
    let icon = <Ionicons name="construct-outline" size={18} color={theme.colors.textSecondary} />;
    let noStatus = false;
    let hideDefaultError = false;
    
    // For Gemini: unknown tools should be rendered as minimal (hidden)
    // This prevents showing raw INPUT/OUTPUT for internal Gemini tools
    // that we haven't explicitly added to knownTools
    const isGemini = props.metadata?.flavor === 'gemini';
    if (!knownTool && isGemini) {
        minimal = true;
    }

    // Extract status first to potentially use as title
    if (knownTool && typeof knownTool.extractStatus === 'function') {
        const state = knownTool.extractStatus({ tool, metadata: props.metadata });
        if (typeof state === 'string' && state) {
            status = state;
        }
    }

    // Handle optional title and function type
    let toolTitle = tool.name;
    
    // Special handling for MCP tools
    if (tool.name.startsWith('mcp__')) {
        // `MCP: Huly Huly Update` is what formatMCPTitle makes of the raw name;
        // the ticket ops say who they are much better than that (DROVE-51).
        toolTitle = isHulyTool(tool.name) ? hulyToolTitle(tool.name, tool.input) : formatMCPTitle(tool.name);
        icon = <Ionicons name="extension-puzzle-outline" size={18} color={theme.colors.textSecondary} />;
        // Every MCP tool used to collapse to a one-line row with its payload
        // out of reach. One that has a card earns the card (DROVE-51).
        minimal = !getToolViewComponent(tool.name);
    } else if (knownTool?.title) {
        if (typeof knownTool.title === 'function') {
            toolTitle = knownTool.title({ tool, metadata: props.metadata });
        } else {
            toolTitle = knownTool.title;
        }
    }

    if (knownTool && typeof knownTool.extractSubtitle === 'function') {
        const subtitle = knownTool.extractSubtitle({ tool, metadata: props.metadata });
        if (typeof subtitle === 'string' && subtitle) {
            description = subtitle;
        }
    }
    if (knownTool && knownTool.minimal !== undefined) {
        if (typeof knownTool.minimal === 'function') {
            minimal = knownTool.minimal({ tool, metadata: props.metadata, messages: props.messages });
        } else {
            minimal = knownTool.minimal;
        }
    }
    
    // Special handling for CodexBash to determine icon based on parsed_cmd
    if (tool.name === 'CodexBash' && tool.input?.parsed_cmd && Array.isArray(tool.input.parsed_cmd) && tool.input.parsed_cmd.length > 0) {
        const parsedCmd = tool.input.parsed_cmd[0];
        if (parsedCmd.type === 'read') {
            icon = <Octicons name="eye" size={18} color={theme.colors.text} />;
        } else if (parsedCmd.type === 'write') {
            icon = <Octicons name="file-diff" size={18} color={theme.colors.text} />;
        } else {
            icon = <Octicons name="terminal" size={18} color={theme.colors.text} />;
        }
    } else if (knownTool && typeof knownTool.icon === 'function') {
        icon = knownTool.icon(18, theme.colors.text);
    }
    
    if (knownTool && typeof knownTool.noStatus === 'boolean') {
        noStatus = knownTool.noStatus;
    }
    if (knownTool && typeof knownTool.hideDefaultError === 'boolean') {
        hideDefaultError = knownTool.hideDefaultError;
    }

    let statusIcon = null;

    let isToolUseError = false;
    if (tool.state === 'error' && tool.result && parseToolUseError(tool.result).isToolUseError) {
        isToolUseError = true;
        console.log('isToolUseError', tool.result);
    }

    // Check permission status first for denied/canceled states
    if (tool.permission && (tool.permission.status === 'denied' || tool.permission.status === 'canceled')) {
        statusIcon = <Ionicons name="remove-circle-outline" size={20} color={theme.colors.textSecondary} />;
    } else if (isToolUseError) {
        statusIcon = <Ionicons name="remove-circle-outline" size={20} color={theme.colors.textSecondary} />;
        hideDefaultError = true;
        minimal = true;
    } else {
        switch (tool.state) {
            case 'running':
                if (!noStatus) {
                    statusIcon = <ActivityIndicator size="small" color={theme.colors.text} style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }} />;
                }
                break;
            case 'completed':
                // if (!noStatus) {
                //     statusIcon = <Ionicons name="checkmark-circle" size={20} color="#34C759" />;
                // }
                break;
            case 'error':
                statusIcon = <Ionicons name="alert-circle-outline" size={20} color={theme.colors.warning} />;
                break;
        }
    }

    const terminalCommand = getTerminalToolCommand(tool);
    const isCompactTerminalTool = terminalCommand !== null;
    const isCompactActivityTool = shouldUseCompactToolRow(tool, compactToolCalls)
        || minimal
        || isCompactTerminalTool;
    const activityLabel = getToolActivityLabel(tool);
    const isInlineCodexPatch = Platform.OS === 'web' && tool.name === 'CodexPatch';
    const renderCardHeader = isCompactActivityTool || shouldRenderToolCardHeader(tool.name, Platform.OS);
    const renderPermissionFooter = () => (
        tool.permission && sessionId && tool.name !== 'AskUserQuestion'
            ? <PermissionFooter permission={tool.permission} sessionId={sessionId} toolName={tool.name} toolInput={tool.input} metadata={props.metadata} />
            : null
    );

    const renderHeaderContent = () => {
        if (isCompactActivityTool) {
            return (
                <View style={styles.compactHeaderLeft}>
                    <View style={styles.compactIconContainer}>
                        {icon}
                    </View>
                    <Text style={styles.compactActivityText} numberOfLines={1}>
                        {activityLabel}
                    </Text>
                    {tool.state === 'running' && (
                        <View style={styles.elapsedContainer}>
                            <ElapsedView from={tool.createdAt} />
                        </View>
                    )}
                    {statusIcon}
                </View>
            );
        }

        return (
            <View style={styles.headerLeft}>
                <View style={styles.iconContainer}>
                    {icon}
                </View>
                <View style={styles.titleContainer}>
                    <Text style={styles.toolName} numberOfLines={1}>{toolTitle}{status ? <Text style={styles.status}>{` ${status}`}</Text> : null}</Text>
                    {description && (
                        <Text style={styles.toolDescription} numberOfLines={1}>
                            {description}
                        </Text>
                    )}
                </View>
                {tool.state === 'running' && (
                    <View style={styles.elapsedContainer}>
                        <ElapsedView from={tool.createdAt} />
                    </View>
                )}
                {statusIcon}
            </View>
        );
    };

    return (
        <View style={isCompactActivityTool ? styles.compactContainer : isInlineCodexPatch ? styles.inlineContainer : styles.container}>
            {renderCardHeader ? (
                isPressable ? (
                    <TouchableOpacity style={isCompactActivityTool ? styles.compactHeader : styles.header} onPress={handlePress} activeOpacity={0.8}>
                        {renderHeaderContent()}
                    </TouchableOpacity>
                ) : (
                    <View style={isCompactActivityTool ? styles.compactHeader : styles.header}>
                        {renderHeaderContent()}
                    </View>
                )
            ) : null}

            {/* Content area - either custom children or tool-specific view */}
            {(() => {
                // Check if minimal first - minimal tools don't show content,
                // except a picture, which is the whole point of the call.
                if (isCompactActivityTool) {
                    return resultImage ? (
                        <View style={styles.compactImage}>
                            <InlineImage
                                uri={resultImage.uri}
                                width={resultImage.width}
                                height={resultImage.height}
                            />
                        </View>
                    ) : null;
                }

                // Try to use a specific tool view component first
                const SpecificToolView = getToolViewComponent(tool.name);
                if (SpecificToolView) {
                    return (
                        <View style={styles.content}>
                            <SpecificToolView
                                tool={tool}
                                metadata={props.metadata}
                                messages={props.messages ?? []}
                                sessionId={sessionId}
                                permissionFooter={isInlineCodexPatch ? renderPermissionFooter() : undefined}
                            />
                            {tool.state === 'error' && tool.result &&
                                !(tool.permission && (tool.permission.status === 'denied' || tool.permission.status === 'canceled')) &&
                                !hideDefaultError && (
                                    <ToolError message={String(tool.result)} />
                                )}
                        </View>
                    );
                }

                // Show error state if present (but not for denied/canceled permissions and not when hideDefaultError is true)
                if (tool.state === 'error' && tool.result &&
                    !(tool.permission && (tool.permission.status === 'denied' || tool.permission.status === 'canceled')) &&
                    !isToolUseError) {
                    return (
                        <View style={styles.content}>
                            <ToolError message={String(tool.result)} />
                        </View>
                    );
                }

                // Fall back to the generic structured card. A tool input is a
                // JSON-schema'd object, so it lays out as labelled rows without
                // anyone hand-writing a view for this tool (DROVE-51). The raw
                // JSON is still one tap away.
                return (
                    <View style={styles.content}>
                        <GenericToolView
                            input={tool.input}
                            result={tool.state === 'completed' ? tool.result : undefined}
                        />
                    </View>
                );
            })()}

            {/* Permission footer - always renders when permission exists to maintain consistent height */}
            {/* AskUserQuestion has its own Submit button UI - no permission footer needed */}
            {!isInlineCodexPatch ? renderPermissionFooter() : null}
        </View>
    );
});

function ElapsedView(props: { from: number }) {
    const { from } = props;
    const elapsed = useElapsedTime(from);
    return <Text style={styles.elapsedText}>{elapsed.toFixed(1)}s</Text>;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        marginVertical: 8,
        overflow: 'hidden'
    },
    compactContainer: {
        backgroundColor: 'transparent',
        marginVertical: 2,
        overflow: 'visible',
    },
    inlineContainer: {
        backgroundColor: 'transparent',
        marginVertical: 1,
        overflow: 'visible',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    compactHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 28,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 4,
        backgroundColor: 'transparent',
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    iconContainer: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    compactHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flex: 1,
        minWidth: 0,
    },
    compactIconContainer: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    titleContainer: {
        flex: 1,
    },
    elapsedContainer: {
        marginLeft: 8,
    },
    elapsedText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    toolName: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    compactActivityText: {
        flex: 1,
        minWidth: 0,
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    status: {
        fontWeight: '400',
        opacity: 0.3,
        fontSize: 15,
    },
    toolDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    content: {
        paddingHorizontal: 12,
        paddingTop: 8,
        overflow: 'visible'
    },
    // Lines up under the compact row's label rather than its icon gutter.
    compactImage: {
        paddingLeft: 38,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 2,
    },
}));
