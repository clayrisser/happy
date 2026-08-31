import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { isLiveStatusFresh, summarizeLiveStatus, type LiveStatusSummary } from '@/utils/liveStatus';
import { AnimatedFade } from './AnimatedOverlay';
import { NativeSettingsMenu, type NativeSettingsMenuGroup } from './NativeSettingsMenu';
import { SessionLiveStatusTree } from './SessionLiveStatus';
import { StatusDot } from './StatusDot';
import { useTickingNow } from './useTickingNow';

/**
 * The one status line under the composer (DROVE-82).
 *
 * Clay, from the phone: "Can all these status things be consolidated below
 * the chatbox so that there's more space." The session screen had three rows
 * of chrome around the composer: the live "working · 1m 1s" strip above it
 * (DROVE-54), an online + branch row between that and the input, and the
 * week quota on its own line below (DROVE-47). Forty characters spread over
 * three lines of a phone screen. This is all of it on one line:
 *
 *     ● Bash 1m 1s ˄ · online · 65% week
 *
 * Left to right: what the session is doing and for how long, then the
 * connection, then the quota and the context gauge. The branch was here
 * too until DROVE-90 moved it under the session title, where tapping it
 * lists the repo's worktrees; Clay found the row too full. Nothing was
 * dropped, only folded: the working segment unfolds the agent tree under the
 * row, the connection opens session info, the quota opens the usage popup,
 * the gauge swaps to exact tokens.
 *
 * Renders nothing at all when there is nothing to say, so an empty session
 * does not gain a blank strip. Its own module so a test can mount it without
 * the composer around it.
 */

/** The working colour, the same blue the thinking dot and the old strip used. */
const workingColor = '#007AFF';

// Grayscale ring that fills and darkens with context usage. Reads at a
// glance without colour, sized to sit beside the 11pt status text.
function ContextGaugeIcon(props: { percent: number }) {
    const { theme } = useUnistyles();
    const size = 14;
    const strokeWidth = 2.5;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = Math.min(100, Math.max(0, props.percent));
    const intensity = 0.35 + 0.65 * (progress / 100);
    const color = theme.dark
        ? `rgba(255, 255, 255, ${intensity})`
        : `rgba(0, 0, 0, ${intensity})`;
    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <Circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={theme.colors.divider}
                strokeWidth={strokeWidth}
                fill="none"
            />
            <Circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                fill="none"
                strokeDasharray={`${circumference} ${circumference}`}
                strokeDashoffset={circumference * (1 - progress / 100)}
                rotation="-90"
                originX={size / 2}
                originY={size / 2}
            />
        </Svg>
    );
}

export type StatusRowConnection = {
    text: string;
    color: string;
    dotColor: string;
    isPulsing?: boolean;
    cliStatus?: {
        claude: boolean | null;
        codex: boolean | null;
        gemini?: boolean | null;
    };
};

export type StatusRowProps = {
    /** Absent on a preview with no session behind it; the working segment needs one. */
    sessionId?: string;
    connectionStatus?: StatusRowConnection;
    contextStatus: { percent: number; detailText: string; color: string } | null;
    weekPercent: number | null;
    /**
     * Prebuilt "Session · 32% · resets 6 PM" rows for the week popup, then a
     * second group with every other drover account folded under it (DROVE-47).
     */
    usageMenuGroups: NativeSettingsMenuGroup[];
    /** Opens the session info screen; the connection segment taps into it. */
    onSessionInfoPress?: () => void;
    /**
     * The composer fades its detail rows while the chat is scrolled off the
     * bottom. A working session stays visible through that: the timer is
     * what Clay scrolled up to keep an eye on.
     */
    showDetails: boolean;
};

/**
 * The live tree for a session, ticking once a second while there is one.
 *
 * Subscribes to the session here, not in AgentInput: the CLI republishes the
 * snapshot up to once a second while working and the composer must not
 * reconcile its whole tree on every tick.
 */
function useLiveStatusSummary(sessionId: string | undefined): LiveStatusSummary | null {
    const session = useSession(sessionId ?? '');
    const live = sessionId ? session?.metadata?.liveStatus ?? null : null;
    const now = useTickingNow(!!live);
    const fresh = isLiveStatusFresh(live, now);
    return React.useMemo(
        () => (live && fresh ? summarizeLiveStatus(live, now) : null),
        [live, fresh, now],
    );
}

function Separator() {
    const { theme } = useUnistyles();
    return (
        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginHorizontal: 6, ...Typography.default() }}>
            ·
        </Text>
    );
}

function CliCheck(props: { name: string; ok: boolean | null }) {
    const { theme } = useUnistyles();
    const color = props.ok ? theme.colors.success : theme.colors.textDestructive;
    return (
        <Text style={{ fontSize: 11, color, marginLeft: 6, ...Typography.default() }}>
            {props.ok ? '✓' : '✗'} {props.name}
        </Text>
    );
}

export const AgentInputStatusRow = React.memo(function AgentInputStatusRow(p: StatusRowProps) {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const [showPreciseContext, setShowPreciseContext] = React.useState(false);
    const summary = useLiveStatusSummary(p.sessionId);

    const hasUsage = p.weekPercent != null || p.contextStatus != null;
    if (!summary && !p.connectionStatus && !hasUsage) {
        return null;
    }

    const canExpand = !!summary && summary.rows.length > 0;
    const segments: React.ReactNode[] = [];

    if (summary) {
        segments.push(
            <Pressable
                key="live"
                onPress={canExpand ? () => setExpanded((open) => !open) : undefined}
                hitSlop={{ top: 12, bottom: 14, left: 6, right: 6 }}
                accessibilityRole={canExpand ? 'button' : undefined}
                accessibilityLabel={`Working: ${summary.headline}`}
                style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 3,
                    // Shrinks after the branch does: a long tool name must
                    // not push the quota off the line, but the branch is
                    // the segment with a tail worth keeping.
                    flexShrink: 1,
                    maxWidth: '45%',
                    opacity: pressed && canExpand ? 0.6 : 1,
                })}
            >
                <Text
                    numberOfLines={1}
                    style={{ fontSize: 11, color: theme.colors.text, flexShrink: 1, ...Typography.default() }}
                >
                    {summary.compact.elapsed
                        ? `${summary.compact.label} ${summary.compact.elapsed}`
                        : summary.compact.label}
                </Text>
                {canExpand ? (
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-up'}
                        size={10}
                        color={theme.colors.textSecondary}
                    />
                ) : null}
            </Pressable>,
        );
    }

    if (p.connectionStatus) {
        const connection = p.connectionStatus;
        segments.push(
            <Pressable
                key="connection"
                onPress={p.onSessionInfoPress}
                disabled={!p.onSessionInfoPress}
                hitSlop={{ top: 12, bottom: 14, left: 6, right: 6 }}
                style={{ flexDirection: 'row', alignItems: 'center' }}
            >
                <Text style={{ fontSize: 11, color: connection.color, ...Typography.default() }}>
                    {connection.text}
                </Text>
                {connection.cliStatus ? (
                    <>
                        <CliCheck name="claude" ok={connection.cliStatus.claude} />
                        <CliCheck name="codex" ok={connection.cliStatus.codex} />
                        {connection.cliStatus.gemini !== undefined ? (
                            <CliCheck name="gemini" ok={connection.cliStatus.gemini} />
                        ) : null}
                    </>
                ) : null}
            </Pressable>,
        );
    }

    if (p.weekPercent != null) {
        const weekText = (
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                {t('agentInput.context.percentWeek', { percent: Math.round(p.weekPercent) })}
            </Text>
        );
        segments.push(
            p.usageMenuGroups.length > 0 ? (
                <NativeSettingsMenu key="week" anchor="bottom" groups={p.usageMenuGroups}>
                    {/* Native menu triggers hit only their own bounds, so
                        pad the target out and pull the layout back in. */}
                    <View style={{ padding: 10, margin: -10 }}>
                        {weekText}
                    </View>
                </NativeSettingsMenu>
            ) : <React.Fragment key="week">{weekText}</React.Fragment>,
        );
    }

    if (p.contextStatus) {
        const context = p.contextStatus;
        segments.push(
            <Pressable
                key="context"
                onPress={() => setShowPreciseContext((current) => !current)}
                hitSlop={{ top: 12, bottom: 14, left: 6, right: 14 }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
            >
                <Text style={{ fontSize: 11, color: context.color, ...Typography.default() }}>
                    {showPreciseContext
                        ? context.detailText
                        : t('agentInput.context.percentContext', { percent: context.percent })}
                </Text>
                <ContextGaugeIcon percent={context.percent} />
            </Pressable>,
        );
    }

    // One dot, and its colour is the state: the working blue while the CLI
    // reports a live turn, otherwise whatever the connection says (green
    // online, grey gone, orange waiting on you).
    const dotColor = summary ? workingColor : p.connectionStatus?.dotColor;

    return (
        <AnimatedFade visible={p.showDetails || summary !== null}>
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                // 18 = 10pt shell inset + 8pt action inset: lines the row up
                // with the composer card's controls.
                paddingHorizontal: 18,
                paddingTop: 6,
                minHeight: 18,
            }}>
                {dotColor ? (
                    <StatusDot
                        color={dotColor}
                        isPulsing={summary ? true : p.connectionStatus?.isPulsing}
                        size={6}
                        // Optically centres the dot against the 11pt text baseline.
                        style={{ marginTop: 1, marginRight: 5 }}
                    />
                ) : null}
                {segments.map((segment, index) => (
                    <React.Fragment key={(segment as React.ReactElement).key ?? index}>
                        {index > 0 ? <Separator /> : null}
                        {segment}
                    </React.Fragment>
                ))}
            </View>
            {expanded && canExpand && p.sessionId ? (
                <SessionLiveStatusTree sessionId={p.sessionId} rows={summary!.rows} />
            ) : null}
        </AnimatedFade>
    );
});
