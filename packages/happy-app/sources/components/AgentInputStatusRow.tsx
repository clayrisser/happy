import * as React from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { confirmDroverSwitch } from '@/utils/droverAccountSwitch';
import {
    isLiveStatusFresh,
    summarizeLiveStatus,
    type LiveStatusMain,
    type LiveStatusSummary,
} from '@/utils/liveStatus';
import { STATUS_ROW_TAP_SLOP_BOTTOM, STATUS_ROW_TAP_SLOP_TOP } from './agentDockLayout';
import { MOBILE_COMPOSER_LAYOUT, MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import { COMPOSER_STRIP_MIN_HEIGHT, COMPOSER_STRIP_PADDING_TOP } from './composerStripLayout';
import { AnimatedFade } from './AnimatedOverlay';
import { UsageAccountBarsSheet } from './UsageAccountBarsSheet';
import type { UsageBarGroup } from './agentInputUsage';
import { NativeSettingsMenu, type NativeSettingsMenuGroup } from './NativeSettingsMenu';
import { SessionAgentsSheet } from './SessionAgentsSheet';
import { SessionTasksSheet } from './SessionTasksSheet';
import { useSessionTasks } from './SessionTasksList';
import { sessionTasksBadge } from '@/utils/sessionTasks';
import { StatusDot } from './StatusDot';
import {
    showsContextPercent,
    statusRowFolds,
    statusRowMetrics,
    statusRowQuotaText,
    statusRowShrink,
    STATUS_ROW_MODEL_TRUNCATION,
} from './statusRowLayout';
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
 *     ● Bash 1m 2s 251.2k ⚇3 ˄ · Opus 5 1M · jamrizzi 23% ˄ · ◔
 *
 * Left to right: what the MAIN thread is doing, for how long, and what it has
 * spent (DROVE-155); how many background agents are out; then the model it is
 * doing it on, the account it is spending, and the context gauge (DROVE-138).
 * The branch was here too until DROVE-90 moved it under the session title,
 * where tapping it lists the repo's worktrees; Clay found the row too full.
 * Nothing was dropped, only folded: the working segment opens the agent tree,
 * the DOT opens session info, the model opens the model picker, the quota
 * opens a bar per account and per window (DROVE-107), the gauge swaps to exact
 * tokens.
 *
 * THE DOT IS THE CONNECTION, AND THE WORD IS GONE (DROVE-138). Clay: "where it
 * says online that should just be a little dot." The dot's colour already WAS
 * the state, so the word beside it repeated it and cost the width the account
 * needed. The dot inherits the word's tap target and its accessibility label,
 * so session info is still one tap from here and a screen reader still hears
 * "online".
 *
 * THE MODEL AND THE ACCOUNT MOVED IN (DROVE-138). The model came down off the
 * button row, where a name among six buttons was showing `Opus 5 1M` as
 * `Opus 5...`; here it has the room to be read. The account was invisible
 * everywhere except the switch menu, and it heads the quota because the quota
 * is that account's and the sheet behind that tap is the list of accounts to
 * switch to (DROVE-160). It is read off `usageBarGroups`, the same list the
 * sheet draws and the same value a switch sends as its `from`, so the row and
 * the sheet cannot call one account by two names (DROVE-129).
 *
 * Every fold that EXPANDS opens its own list on the first tap, never an
 * intermediate menu (DROVE-111). Clay, twice: "it shouldn't be opening a menu
 * that then opens the list of options." The two sheets (DROVE-117 for the
 * quota, DROVE-111 for the tree) share one piece of state, so opening one
 * closes the other rather than stacking them.
 *
 * THE DOT IS THE MAIN THREAD (DROVE-155). Clay: "Is the pulsing blue dot next
 * to the agent blinking when the agents are running or when we're actually
 * thinking in the main chat". It used to be neither on purpose: it went blue
 * whenever a live snapshot existed, which included a session whose only
 * activity was a background fan-out. The rule now, and do not let it drift
 * back:
 *
 *   the DOT says whether the MAIN thread is working, in the working blue.
 *   the COUNT beside the fold says how many agents are out.
 *   nothing else on the row speaks for either.
 *
 * The main thread's numbers and the agents' count never share a segment or a
 * clock, because "3 agents 29s" reading as the agents' time is the confusion
 * this replaced.
 *
 * Five things are FOLDED to keep one line on the narrowest phone with a model,
 * an account and a quota on it too, and nothing is truncated:
 *
 *   - the word "agents" is a glyph and a count; the tree spells it out.
 *   - the word "online" is gone entirely; the dot's colour is the state.
 *   - the word "week" goes when an account heads the quota, because
 *     `jamrizzi 23%` is one fact about one account and the sheet spells the
 *     window out. With no account to head it the window keeps its name.
 *   - the context gauge drops its percent text while the main thread works, or
 *     whenever the account is on the row: the ring beside it fills with the
 *     same number and a tap still opens the exact figure.
 *   - the tool NAME goes and the numbers stay whenever the row would not
 *     otherwise fit. That was a 360pt constant before the model and the
 *     account were here; it is now asked of statusRowLayout's estimator with
 *     the row's real content, because the width it fires at depends on how
 *     long the tool, the model and the account happen to be.
 *   - the MODEL goes whole when the name alone did not save the row, which is
 *     a working session with a task list (DROVE-167) on a 393pt phone. The
 *     estimator counts the tasks segment, so it says so; before it did, the
 *     account and the model were being cut to `jam…` and `Opus…` around a
 *     badge that held its width. Idle, the model is back.
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
 *
 * The box is 30pt tall, not 44, and DROVE-153 works out why in
 * agentDockLayout's note on STATUS_ROW_TAP_SLOP_TOP: with the home indicator
 * below and the composer's own 44pt buttons above, there are 30 points between
 * them and the last 14 cost chat height whichever end they are taken from.
 * These segments are status TEXT rather than chrome buttons, and every chrome
 * button on the screen is drawn at 44 or larger now, so the trade went to the
 * space Clay asked for three times.
 *
 * The horizontal reach goes up instead, since it is free. A segment is 60 to
 * 110pt wide, so widening it 4pt a side buys more real hittability than the two
 * vertical points that were available.
 */
const segmentHitSlop = {
    top: STATUS_ROW_TAP_SLOP_TOP,
    bottom: STATUS_ROW_TAP_SLOP_BOTTOM,
    left: 10,
    right: 10,
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
    /** The zone and the model the sheet's numbers are for (DROVE-173). */
    usageBarFooter?: string;
    /**
     * The model's short name, spelled in full here rather than truncated on
     * the button row (DROVE-138).
     */
    modelName?: string | null;
    /** Opens the model picker directly, with no menu in between (DROVE-111). */
    onModelPress?: () => void;
    /**
     * iOS anchors the model picker as a native menu on the label itself rather
     * than opening an overlay, so this replaces the press. Either way the
     * first tap is the list of models.
     */
    modelGroup?: NativeSettingsMenuGroup | null;
    nativeMenus?: boolean;
    /** Whether the model picker is the one currently open. */
    modelPickerOpen?: boolean;
    /**
     * Zen mode hides everything non-essential, and the account's NAME is one
     * of those: the quota reads `23% week` instead of `jamrizzi 23%`, and the
     * context percent stays printed, since the account is not taking its
     * width. A flag rather than a second account value, because the account
     * itself is still derived once, from `usageBarGroups`: the sheet still
     * lists it and a switch still sends it as `from` (DROVE-129, DROVE-160).
     * The name only stops being printed on the strip.
     */
    hideAccount?: boolean;
    /** Opens the session info screen; the DOT taps into it (DROVE-138). */
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

/**
 * What a screen reader hears for the live segment.
 *
 * Spelled out, because the row itself is a glyph and a number: the main
 * thread's state and numbers first, then the agents as a count with the word
 * the row folded away.
 */
function accessibilityLabelFor(main: LiveStatusMain | null, sideCount: number): string {
    const parts: string[] = [];
    if (main) {
        parts.push(`Main thread: ${main.label} ${main.elapsed}`);
        if (main.tokens) parts.push(`${main.tokens} tokens`);
    }
    if (sideCount > 0) parts.push(`${sideCount} ${sideCount === 1 ? 'agent' : 'agents'}`);
    return parts.join(', ');
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
    const { width } = useWindowDimensions();
    // One value, not two flags: what makes opening the quota close the tree.
    const [openSheet, setOpenSheet] = React.useState<'agents' | 'tasks' | 'usage' | null>(null);
    const [showPreciseContext, setShowPreciseContext] = React.useState(false);
    const summary = useLiveStatusSummary(p.sessionId);
    // The session's task list (DROVE-167). Free: the store already holds it,
    // written by the reducer on every TodoWrite that lands.
    const tasks = useSessionTasks(p.sessionId);
    const tasksBadge = sessionTasksBadge(tasks);
    const closeSheet = React.useCallback(() => setOpenSheet(null), []);

    // Tapping an account block in the quota sheet moves the session onto it
    // (DROVE-160). The sheet is closed first and the confirm is raised on the
    // next tick, so the alert is not presented into a sheet still tearing down.
    // Nothing new is sent: confirmDroverSwitch is the `/flip` message every
    // other surface already sends.
    const sessionId = p.sessionId;
    const currentAccount = p.usageBarGroups.find((group) => group.active)?.account ?? null;
    // What the strip prints. In zen mode that is nothing, while the switch
    // above still knows which account it is leaving.
    const shownAccount = p.hideAccount ? null : currentAccount;
    const onSwitchAccount = React.useCallback((account: string) => {
        if (!sessionId) return;
        setOpenSheet(null);
        confirmDroverSwitch({ sessionId, account, from: currentAccount, always: true });
    }, [currentAccount, sessionId]);

    const hasUsage = p.weekPercent != null || p.contextStatus != null;
    if (!summary && !p.connectionStatus && !hasUsage && !tasksBadge && !p.modelName) {
        return null;
    }

    const canExpand = !!summary && summary.rows.length > 0;
    const canOpenUsage = p.usageBarGroups.length > 0;
    const segments: React.ReactNode[] = [];

    const main = summary?.main ?? null;
    const sideCount = summary?.sideCount ?? 0;

    // The quota's text, and the account that heads it. Both are read off the
    // same `usageBarGroups` the sheet draws, so the row's name, the sheet's
    // heading and the `from` a switch sends are one value (DROVE-129,
    // DROVE-160).
    const quotaText = statusRowQuotaText(
        shownAccount,
        p.weekPercent,
        p.weekPercent == null
            ? ''
            : t('agentInput.context.percentWeek', { percent: Math.round(p.weekPercent) }),
    );

    // Which folds the row needs, asked of its real content rather than taken
    // from a width constant (DROVE-155, DROVE-138). The width the tool name
    // folds at depends on how long this tool, this model, this account and
    // the task badge happen to be, so a constant could only ever be right for
    // one of them. The model folds whole after the name, when the name alone
    // was not enough (statusRowLayout says when, and why the model).
    const liveNumbers = main ? (main.tokens ? `${main.elapsed} ${main.tokens}` : main.elapsed) : null;
    const folds = statusRowFolds({
        live: main ? `${main.label} ${liveNumbers}` : null,
        liveWithoutName: liveNumbers,
        agentCount: sideCount,
        liveExpands: canExpand,
        tasks: p.sessionId ? tasksBadge : null,
        model: p.modelName,
        quota: quotaText,
        quotaExpands: canOpenUsage,
        contextGauge: !!p.contextStatus,
    }, width);
    const showLabel = !folds.toolName;
    if (summary && (main || sideCount > 0)) {
        segments.push(
            <Pressable
                key="live"
                onPress={canExpand
                    ? () => setOpenSheet((open) => (open === 'agents' ? null : 'agents'))
                    : undefined}
                hitSlop={segmentHitSlop}
                accessibilityRole={canExpand ? 'button' : undefined}
                accessibilityState={canExpand ? { expanded: openSheet === 'agents' } : undefined}
                accessibilityLabel={accessibilityLabelFor(main, sideCount)}
                style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 3,
                    // The last of the three that shrink, after the account and
                    // the model: a long tool name must not push the quota off
                    // the line, but the numbers beside it are what Clay is
                    // watching (statusRowShrink). The cap is what keeps a
                    // 30-character MCP name from squeezing the model and the
                    // account before it has given way itself.
                    flexShrink: statusRowShrink.live,
                    maxWidth: '45%',
                    opacity: pressed && canExpand ? 0.6 : 1,
                })}
            >
                {main ? (
                    <>
                        {/* The only text on the row allowed to shrink, and the
                            first thing to fold on a narrow phone. A
                            30-character MCP tool name gives way; the clock and
                            the token count never do, because they are what
                            Clay is watching. */}
                        {showLabel ? (
                            <Text
                                numberOfLines={1}
                                style={{ fontSize: 11, color: theme.colors.text, flexShrink: 1, ...Typography.default() }}
                            >
                                {main.label}
                            </Text>
                        ) : null}
                        <Text style={{ fontSize: 11, color: theme.colors.text, ...Typography.default() }}>
                            {main.tokens ? `${main.elapsed} ${main.tokens}` : main.elapsed}
                        </Text>
                    </>
                ) : null}
                {sideCount > 0 ? (
                    <>
                        {/* The agents, and the whole of what the row says
                            about them: a glyph and a number, in the secondary
                            colour so they never read as the main thread's own.
                            The word and every name are behind the fold. */}
                        <Ionicons name="people" size={11} color={theme.colors.textSecondary} />
                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {sideCount}
                        </Text>
                    </>
                ) : null}
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

    // What the session is working THROUGH, one tap from the strip (DROVE-167).
    // Clay, three times: "why does this not let me see my fucking tasks". The
    // list was already in the store the whole time, drawn once in the
    // transcript and then scrolled away by the next twenty tool calls. Absent
    // when the session never kept a list, because `0/0 tasks` is furniture.
    if (tasksBadge && p.sessionId) {
        segments.push(
            <Pressable
                key="tasks"
                onPress={() => setOpenSheet((open) => (open === 'tasks' ? null : 'tasks'))}
                accessibilityRole="button"
                accessibilityLabel={tasks.headline}
                accessibilityState={{ expanded: openSheet === 'tasks' }}
                hitSlop={segmentHitSlop}
                style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 3,
                    opacity: pressed ? 0.6 : 1,
                })}
            >
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {tasksBadge}
                </Text>
                <Ionicons
                    name={openSheet === 'tasks' ? 'chevron-down' : 'chevron-up'}
                    size={10}
                    color={theme.colors.textSecondary}
                />
            </Pressable>,
        );
    }

    // The model, in full, off the button row where a name among six buttons was
    // being cut to `Opus 5...` (DROVE-138). One tap opens the model list, on
    // iOS as the native menu anchored here and everywhere else as the picker:
    // never a menu that then lists the controls (DROVE-111). Folded whole
    // while a working row with a task list would not otherwise fit; back the
    // moment the main thread is idle.
    if (p.modelName && !folds.model) {
        const modelText = (
            <Text
                numberOfLines={1}
                ellipsizeMode={STATUS_ROW_MODEL_TRUNCATION.ellipsizeMode}
                style={{
                    fontSize: statusRowMetrics.fontSize,
                    color: theme.colors.text,
                    flexShrink: 1,
                    ...Typography.default(),
                }}
            >
                {p.modelName}
            </Text>
        );
        const modelStyle = {
            flexDirection: 'row',
            alignItems: 'center',
            flexShrink: statusRowShrink.model,
            minWidth: 0,
        } as const;
        segments.push(
            p.nativeMenus && p.modelGroup ? (
                <NativeSettingsMenu
                    key="model"
                    accessibilityLabel={`Model, ${p.modelName}`}
                    groups={[p.modelGroup]}
                    style={modelStyle}
                >
                    {modelText}
                </NativeSettingsMenu>
            ) : p.onModelPress ? (
                <Pressable
                    key="model"
                    onPress={p.onModelPress}
                    hitSlop={segmentHitSlop}
                    accessibilityRole="button"
                    accessibilityLabel="Model"
                    accessibilityValue={{ text: p.modelName }}
                    accessibilityState={{ expanded: !!p.modelPickerOpen }}
                    style={({ pressed }) => ({ ...modelStyle, opacity: pressed ? 0.6 : 1 })}
                >
                    {modelText}
                </Pressable>
            ) : <View key="model" style={modelStyle}>{modelText}</View>,
        );
    }

    // The account heads the quota, because the quota IS this account's and the
    // sheet behind the tap is the list of accounts to switch to (DROVE-160).
    // The word `week` folds away when it does: `jamrizzi 23%` is one fact
    // about one account and the sheet spells the window out. With no account
    // there is nothing to head it, so the window keeps its name.
    if (quotaText != null) {
        const quotaBody = shownAccount ? (
            <>
                {/* The account is the only thing in this segment allowed to
                    give way, and it gives way first of everything on the row:
                    a cut name is still recognisable, a cut number is not. */}
                <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{
                        fontSize: statusRowMetrics.fontSize,
                        color: theme.colors.textSecondary,
                        flexShrink: statusRowShrink.account,
                        minWidth: 0,
                        ...Typography.default(),
                    }}
                >
                    {shownAccount}
                </Text>
                <Text style={{
                    fontSize: statusRowMetrics.fontSize,
                    color: theme.colors.textSecondary,
                    flexShrink: statusRowShrink.quota,
                    ...Typography.default(),
                }}>
                    {`${Math.round(p.weekPercent!)}%`}
                </Text>
            </>
        ) : (
            <Text style={{
                fontSize: statusRowMetrics.fontSize,
                color: theme.colors.textSecondary,
                ...Typography.default(),
            }}>
                {quotaText}
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
                    accessibilityLabel={shownAccount ? `Quota, ${quotaText}` : undefined}
                    accessibilityState={{ expanded: openSheet === 'usage' }}
                    hitSlop={segmentHitSlop}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 3,
                        flexShrink: shownAccount ? 1 : 0,
                        minWidth: 0,
                        opacity: pressed ? 0.6 : 1,
                    })}
                >
                    {quotaBody}
                    <Ionicons
                        name={openSheet === 'usage' ? 'chevron-down' : 'chevron-up'}
                        size={10}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            ) : (
                <View key="week" style={{ flexDirection: 'row', alignItems: 'center', gap: 3, minWidth: 0 }}>
                    {quotaBody}
                </View>
            ),
        );
    }

    if (p.contextStatus) {
        const context = p.contextStatus;
        // The ring alone while the main thread works (DROVE-155: the live token
        // count is the cost readout at that moment) and equally once the
        // account is on the row (DROVE-138). Either way the ring fills with the
        // same number the text was printing, and the tap still opens the exact
        // figure, so it is the cheapest thing on a full row to lose.
        const showPercent = showsContextPercent(shownAccount, showPreciseContext, main !== null);
        segments.push(
            <Pressable
                key="context"
                onPress={() => setShowPreciseContext((current) => !current)}
                hitSlop={{ ...segmentHitSlop, right: 14 }}
                accessibilityRole="button"
                accessibilityLabel="Context"
                accessibilityValue={{ text: context.detailText }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
            >
                {showPercent ? (
                    <Text style={{ fontSize: 11, color: context.color, ...Typography.default() }}>
                        {showPreciseContext
                            ? context.detailText
                            : t('agentInput.context.percentContext', { percent: context.percent })}
                    </Text>
                ) : null}
                <ContextGaugeIcon percent={context.percent} />
            </Pressable>,
        );
    }

    // THE DOT IS THE MAIN THREAD (DROVE-155). See the rule at the top of this
    // file. Blue and pulsing exactly while the MAIN thread is working;
    // otherwise whatever the connection says (green online, grey gone, orange
    // waiting on you). It was `summary ? ...` — any live snapshot at all — and
    // that is what made it blue for a session whose only activity was a
    // background fan-out.
    const mainWorking = main !== null;
    const dotColor = mainWorking ? workingColor : p.connectionStatus?.dotColor;
    // The word `online` is gone, so the dot inherits everything it carried:
    // the tap into session info, and the state IN WORDS for a screen reader
    // (DROVE-138). The screen says it in colour; this says it out loud. The
    // two states never contradict: the blue is the MAIN thread (DROVE-155) and
    // the colour under it is the connection, so both are named.
    const dotLabel = [
        mainWorking ? 'Working' : null,
        p.connectionStatus?.text,
    ].filter((part): part is string => !!part).join(', ');

    return (
        <AnimatedFade visible={p.showDetails || summary !== null}>
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                // 19 = 10pt shell inset + 9pt action inset: lines the row up
                // with the composer card's controls. The action inset moved
                // from 8 to 9 when the row's buttons went 42 -> 44 (DROVE-153),
                // because it is half the difference between the button and its
                // 26pt glyph.
                paddingHorizontal: MOBILE_COMPOSER_METRICS.shellInset
                    + MOBILE_COMPOSER_LAYOUT.addGlyphOffset,
                // The strip's box, shared with the recording banner that sits
                // over it (DROVE-157), so the two cannot drift and a mic
                // cannot resize the dock.
                paddingTop: COMPOSER_STRIP_PADDING_TOP,
                minHeight: COMPOSER_STRIP_MIN_HEIGHT,
            }}>
                {dotColor ? (
                    <Pressable
                        onPress={p.onSessionInfoPress}
                        disabled={!p.onSessionInfoPress}
                        // Wider on the left than a segment, because the dot is
                        // 7pt of target at the very start of the row. The
                        // vertical stays the strip's, which is the one target
                        // under the 44pt floor and is argued for in
                        // agentDockLayout and glassChrome.test.ts.
                        hitSlop={{ ...segmentHitSlop, left: 16, right: 10 }}
                        accessibilityRole={p.onSessionInfoPress ? 'button' : undefined}
                        accessibilityLabel={dotLabel || undefined}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            opacity: pressed && p.onSessionInfoPress ? 0.6 : 1,
                        })}
                    >
                        <StatusDot
                            color={dotColor}
                            isPulsing={mainWorking ? true : p.connectionStatus?.isPulsing}
                            // A point bigger than DROVE-82's 6, now that it is
                            // the only thing saying which state the connection
                            // is in: grey and orange have to be told apart at
                            // this size with no word beside them.
                            size={statusRowMetrics.dot}
                            // Optically centres the dot against the 11pt text baseline.
                            style={{ marginTop: 1, marginRight: statusRowMetrics.dotMarginRight }}
                        />
                        {p.connectionStatus?.cliStatus ? (
                            <>
                                <CliCheck name="claude" ok={p.connectionStatus.cliStatus.claude} />
                                <CliCheck name="codex" ok={p.connectionStatus.cliStatus.codex} />
                                {p.connectionStatus.cliStatus.gemini !== undefined ? (
                                    <CliCheck name="gemini" ok={p.connectionStatus.cliStatus.gemini} />
                                ) : null}
                            </>
                        ) : null}
                    </Pressable>
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
                    footer={p.usageBarFooter}
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
            {p.sessionId ? (
                <SessionTasksSheet
                    sessionId={p.sessionId}
                    open={openSheet === 'tasks'}
                    onClose={closeSheet}
                />
            ) : null}
        </AnimatedFade>
    );
});
