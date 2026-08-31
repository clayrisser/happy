/**
 * A subagent as a card (DROVE-32, DROVE-54, DROVE-51).
 *
 * The header row (from knownTools) is the task's description. The card body
 * opens with a status row: the subagent type as a chip, then running /
 * finished / failed with the run's numbers, live while it runs (the CLI
 * publishes the agent's clock and tokens on session metadata, joined by the
 * tool_use id) and from the agent's own report once it has finished. Under
 * it the tail of the steps the agent took, as before.
 *
 * Tapping the status row unfolds the rest: the prompt as text, every step,
 * the agent's final report as markdown, and the raw JSON. Fold, never drop.
 *
 * The state itself comes from utils/agentCard.ts, which errs to running: a
 * background agent's tool call ends at launch and used to draw a red Failed
 * over an agent that was working (DROVE-110). A run nothing has heard from for
 * a while is called quiet here in the same words as the agent screen.
 *
 * A background agent that has FINISHED then sat on "Running, quiet for 40m"
 * forever, because the launch receipt was the only result its call would ever
 * get. The CLI now sends the real one on the same call when the agent's
 * task-notification lands (DROVE-115), so nothing here changed: the same
 * agentRunState reads it, the clock stops because the agent is no longer
 * running, and the numbers come off the report rather than the ticking now.
 */
import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { t } from '@/text';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { agentOutcome, agentOwnKeys, agentPrompt, agentQuietFor, agentRunState, agentSubagentType } from '@/utils/agentCard';
import { formatElapsed, formatTokens, isLiveStatusFresh } from '@/utils/liveStatus';
import { structuredRowsOmitting } from '@/utils/structuredFields';
import { knownTools } from '../../tools/knownTools';
import { useTickingNow } from '../../useTickingNow';
import { RawDisclosure, RowsView } from '../StructuredFieldsView';
import { ToolViewProps } from './_all';

interface FilteredTool {
    tool: ToolCall;
    title: string;
    state: 'running' | 'completed' | 'error';
}

/** Collapsed shows this many of the newest steps: what the agent is doing NOW. */
const collapsedSteps = 3;

interface LiveAgent {
    /** The phone's clock, ticking while the agent runs. */
    now: number;
    /** Elapsed and tokens off session metadata, null when the CLI is not reporting it. */
    numbers: string[] | null;
    /** The last sign of life we have, epoch ms. */
    movedAt: number | undefined;
}

/**
 * A running agent's own clock and token count (DROVE-54), read off session
 * metadata, plus when it last showed a sign of life (DROVE-110).
 *
 * `running` is the agent's state, not the tool call's: an async agent's call
 * ends at launch and the agent keeps working, so gating this on the call being
 * open left every background agent with no clock at all. A fresh liveStatus
 * that still lists the agent IS the sign of life: the CLI tails the agent's
 * transcript and drops it from the list once the file stops moving.
 */
function useLiveAgent(tool: ToolCall, metadata: Metadata | null, running: boolean, lastStepAt: number): LiveAgent {
    const live = metadata?.liveStatus ?? null;
    const callId = tool.callId;
    const now = useTickingNow(running);
    const launchedAt = tool.completedAt ?? tool.startedAt ?? tool.createdAt;
    const fallback = Math.max(lastStepAt, launchedAt || 0) || undefined;
    if (!callId || !running || !isLiveStatusFresh(live, now)) {
        return { now, numbers: null, movedAt: fallback };
    }
    const agent = live!.agents?.find((candidate) => candidate.toolId === callId);
    if (!agent) return { now, numbers: null, movedAt: fallback };
    const numbers = [formatElapsed(now - agent.startedAt)];
    if (typeof agent.tokens === 'number' && agent.tokens > 0) {
        numbers.push(`${formatTokens(agent.tokens)} tokens`);
    }
    return { now, numbers, movedAt: Math.max(live!.at, fallback ?? 0) };
}

function stepTitle(step: ToolCall, metadata: Metadata | null): string {
    const knownTool = knownTools[step.name as keyof typeof knownTools] as any;
    if (!knownTool) return step.name;
    if (typeof knownTool.extractDescription === 'function') {
        return knownTool.extractDescription({ tool: step, metadata });
    }
    if (typeof knownTool.title === 'function') {
        return knownTool.title({ tool: step, metadata });
    }
    return knownTool.title ?? step.name;
}

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata, messages, sessionId }) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);

    const subagentType = agentSubagentType(tool.input);
    const prompt = agentPrompt(tool.input);
    const outcome = React.useMemo(() => agentOutcome(tool.result), [tool.result]);
    const runState = agentRunState(tool);
    const running = runState === 'running';
    const rest = React.useMemo(() => structuredRowsOmitting(tool.input, agentOwnKeys), [tool.input]);

    // Every step the subagent took stays reachable, not just the last three
    // (DROVE-32): the bridge forwards the sidechain tool calls as children.
    const steps: FilteredTool[] = [];
    let lastStepAt = 0;
    for (const m of messages) {
        if (m.kind !== 'tool-call') continue;
        if (m.tool.state === 'running' || m.tool.state === 'completed' || m.tool.state === 'error') {
            steps.push({ tool: m.tool, title: stepTitle(m.tool, metadata), state: m.tool.state });
            lastStepAt = Math.max(lastStepAt, m.tool.completedAt ?? m.tool.startedAt ?? m.tool.createdAt);
        }
    }
    const hiddenSteps = expanded ? 0 : Math.max(0, steps.length - collapsedSteps);
    const visibleSteps = hiddenSteps > 0 ? steps.slice(hiddenSteps) : steps;

    const live = useLiveAgent(tool, metadata, running, lastStepAt);
    const quietMs = agentQuietFor(running, live.movedAt, live.now);

    const stateLabel = runState === 'running'
        ? t('tools.agent.running')
        : runState === 'finished' ? t('tools.agent.finished') : t('tools.agent.failed');
    const numbers: string[] = live.numbers ? [...live.numbers] : [];
    if (!live.numbers && outcome) {
        if (typeof outcome.durationMs === 'number') numbers.push(formatElapsed(outcome.durationMs));
        if (typeof outcome.tokens === 'number' && outcome.tokens > 0) numbers.push(`${formatTokens(outcome.tokens)} tokens`);
        if (typeof outcome.toolUses === 'number' && outcome.toolUses > 0) numbers.push(t('tools.agent.toolUses', { count: outcome.toolUses }));
    }
    // A background agent the CLI is not reporting on still gets a clock, off
    // the launch or its newest step, so the card reads like the agent screen.
    if (numbers.length === 0 && running && live.movedAt) {
        const launchedAt = tool.completedAt ?? tool.startedAt ?? tool.createdAt;
        if (launchedAt) numbers.push(formatElapsed(live.now - launchedAt));
    }
    // Same words and same threshold as DROVE-93's agent screen: nothing on
    // disk tells a dead agent from a silent one, so neither surface guesses.
    if (quietMs !== undefined) {
        numbers.push(t('subagent.quiet', { duration: formatElapsed(quietMs) }));
    }

    const stateIcon = runState === 'running'
        ? <ActivityIndicator size={Platform.OS === 'ios' ? 'small' : 14 as any} color={theme.colors.warning} />
        : runState === 'finished'
            ? <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
            : <Ionicons name="close-circle" size={16} color={theme.colors.textDestructive} />;

    return (
        <View style={styles.container}>
            <Pressable
                onPress={() => setExpanded((value) => !value)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('tools.agent.details')}
                style={({ pressed }) => [styles.statusRow, pressed && styles.pressed]}
            >
                {subagentType ? <Text style={styles.chip} numberOfLines={1}>{subagentType}</Text> : null}
                {stateIcon}
                <Text style={styles.stateText} numberOfLines={1}>
                    {[stateLabel, ...numbers].join(' · ')}
                </Text>
                <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
            </Pressable>

            {expanded && prompt ? (
                <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('tools.agent.prompt')}</Text>
                    <View style={styles.block}>
                        <Text style={styles.blockText} selectable>{prompt}</Text>
                    </View>
                </View>
            ) : null}

            {visibleSteps.length > 0 ? (
                <View style={styles.steps}>
                    {visibleSteps.map((item, index) => (
                        <View key={`${item.tool.name}-${index}`} style={styles.step}>
                            <Text style={styles.stepTitle} numberOfLines={expanded ? 2 : 1}>{item.title}</Text>
                            <View style={styles.stepStatus}>
                                {item.state === 'running' && (
                                    <ActivityIndicator size={Platform.OS === 'ios' ? 'small' : 14 as any} color={theme.colors.warning} />
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
                    {hiddenSteps > 0 ? (
                        <Pressable
                            style={styles.moreSteps}
                            onPress={() => setExpanded(true)}
                            hitSlop={8}
                            accessibilityRole="button"
                        >
                            <Text style={styles.moreStepsText}>
                                {t('tools.taskView.showAll', { count: steps.length })}
                            </Text>
                            <Ionicons name="chevron-down" size={14} color={theme.colors.textLink ?? theme.colors.textSecondary} />
                        </Pressable>
                    ) : null}
                </View>
            ) : null}

            {expanded && outcome?.text ? (
                <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('tools.agent.result')}</Text>
                    <View style={styles.block}>
                        <MarkdownView markdown={outcome.text} sessionId={sessionId} />
                    </View>
                </View>
            ) : null}

            {expanded && rest.length > 0 ? <RowsView rows={rest} /> : null}
            {expanded ? <RawDisclosure value={tool.input} /> : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 4,
        paddingBottom: 12,
        gap: 8,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 24,
    },
    pressed: {
        opacity: 0.6,
    },
    chip: {
        fontSize: 11,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 4,
        paddingHorizontal: 6,
        overflow: 'hidden',
        maxWidth: 140,
    },
    stateText: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    section: {
        gap: 4,
    },
    sectionLabel: {
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    block: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    blockText: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.text,
    },
    steps: {
        gap: 0,
    },
    step: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 4,
        paddingLeft: 4,
        paddingRight: 2,
    },
    stepTitle: {
        flex: 1,
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    stepStatus: {
        marginLeft: 'auto',
        paddingLeft: 8,
    },
    moreSteps: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6,
        paddingHorizontal: 4,
        gap: 4,
    },
    moreStepsText: {
        fontSize: 14,
        color: theme.colors.textLink ?? theme.colors.textSecondary,
        fontWeight: '500',
    },
}));
