import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { confirmDroverSwitch } from '@/utils/droverAccountSwitch';
import { isLiveStatusFresh, summarizeLiveStatus, type LiveStatusSummary } from '@/utils/liveStatus';
import { STATUS_ROW_TAP_SLOP_BOTTOM, STATUS_ROW_TAP_SLOP_TOP } from './agentDockLayout';
import { AnimatedFade } from './AnimatedOverlay';
import { UsageAccountBarsSheet } from './UsageAccountBarsSheet';
import type { UsageBarGroup } from './agentInputUsage';
import { SessionAgentsSheet } from './SessionAgentsSheet';
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
 * dropped, only folded: the working segment opens the agent tree, the
 * connection opens session info, the quota opens a bar per account and per
 * window (DROVE-107), the gauge swaps to exact tokens.
 *
 * Both folds that EXPAND open the same slide-up sheet (DROVE-117 for the
 * quota, DROVE-111 for the tree). Clay: "just like agents should show in a
 * sheet, right?" An unfold has to fit the furniture it hangs off, which is
 * what squeezed the tree into 180pt and the account bars into a strip. One
 * piece of state holds which is open, so opening one closes the other rather
 * than stacking them.
 *
 * Renders nothing at all when there is nothing to say, so an empty session
 * does not gain a blank strip. Its own module so a test can mount it without
 * the composer around it.
 */

/** The working colour, the same blue the thinking dot and the old strip used. */
const workingColor = '#007AFF';

/**
 * Touch area around each segment's 11pt text.
 *
 * The bottom number is load-bearing (DROVE-144): the dock now sits 16pt above
 * the screen edge instead of 34, so a segment reaching 14pt below its text
 * would land inside the home indicator, where it is hard to hit and where a
 * drifting touch becomes the system swipe. At 3 the touch area stops exactly
 * on the indicator's top edge. Change it and change
 * STATUS_ROW_TAP_SLOP_BOTTOM with it: the gap under the row is derived from
 * it, and agentDockLayout.test.ts asserts the two agree.
 */
const segmentHitSlop = {
    top: STATUS_ROW_TAP_SLOP_TOP,
    bottom: STATUS_ROW_TAP_SLOP_BOTTOM,
    left: 6,
    right: 6,
} as const;

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
     * The week popup's bar rows: this account's session, week and family
     * windows, then every other drover account folded under a second heading
     * (DROVE-47). One thin row each, name and track and number on one line
     * (DROVE-107).
     */
    usageBarGroups: UsageBarGroup[];
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
    // One value, not two flags: what makes opening the quota close the tree.
    const [openSheet, setOpenSheet] = React.useState<'agents' | 'usage' | null>(null);
    const [showPreciseContext, setShowPreciseContext] = React.useState(false);
    const summary = useLiveStatusSummary(p.sessionId);
    const closeSheet = React.useCallback(() => setOpenSheet(null), []);

    // Tapping an account block in the quota sheet moves the session onto it
    // (DROVE-160). The sheet is closed first and the confirm is raised on the
    // next tick, so the alert is not presented into a sheet still tearing down.
    // Nothing new is sent: confirmDroverSwitch is the `/flip` message every
    // other surface already sends.
    const sessionId = p.sessionId;
    const currentAccount = p.usageBarGroups.find((group) => group.active)?.account ?? null;
    const onSwitchAccount = React.useCallback((account: string) => {
        if (!sessionId) return;
        setOpenSheet(null);
        confirmDroverSwitch({ sessionId, account, from: currentAccount, always: true });
    }, [currentAccount, sessionId]);

    const hasUsage = p.weekPercent != null || p.contextStatus != null;
    if (!summary && !p.connectionStatus && !hasUsage) {
        return null;
    }

    const canExpand = !!summary && summary.rows.length > 0;
    const canOpenUsage = p.usageBarGroups.length > 0;
    const segments: React.ReactNode[] = [];

    if (summary) {
        segments.push(
            <Pressable
                key="live"
                onPress={canExpand
                    ? () => setOpenSheet((open) => (open === 'agents' ? null : 'agents'))
                    : undefined}
                hitSlop={segmentHitSlop}
                accessibilityRole={canExpand ? 'button' : undefined}
                accessibilityState={canExpand ? { expanded: openSheet === 'agents' } : undefined}
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
                        name={openSheet === 'agents' ? 'chevron-down' : 'chevron-up'}
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
                hitSlop={segmentHitSlop}
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
        // The quota opens a sheet that slides up (DROVE-117), not a native
        // menu: a UIMenu row is a string, so it can hold a sentence but never
        // a bar. DROVE-107 unfolded the rows in place instead; a sheet gives
        // the account list room to scroll and a known width to align in.
        segments.push(
            canOpenUsage ? (
                <Pressable
                    key="week"
                    onPress={() => setOpenSheet((open) => (open === 'usage' ? null : 'usage'))}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: openSheet === 'usage' }}
                    hitSlop={segmentHitSlop}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 3,
                        opacity: pressed ? 0.6 : 1,
                    })}
                >
                    {weekText}
                    <Ionicons
                        name={openSheet === 'usage' ? 'chevron-down' : 'chevron-up'}
                        size={10}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            ) : <React.Fragment key="week">{weekText}</React.Fragment>,
        );
    }

    if (p.contextStatus) {
        const context = p.contextStatus;
        segments.push(
            <Pressable
                key="context"
                onPress={() => setShowPreciseContext((current) => !current)}
                hitSlop={{ ...segmentHitSlop, right: 14 }}
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
            {canOpenUsage ? (
                <UsageAccountBarsSheet
                    groups={p.usageBarGroups}
                    open={openSheet === 'usage'}
                    onClose={closeSheet}
                    onSwitchAccount={sessionId ? onSwitchAccount : undefined}
                />
            ) : null}
            {canExpand && p.sessionId ? (
                <SessionAgentsSheet
                    sessionId={p.sessionId}
                    summary={summary}
                    open={openSheet === 'agents'}
                    onClose={closeSheet}
                />
            ) : null}
        </AnimatedFade>
    );
});
