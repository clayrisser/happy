import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { isLiveStatusFresh, summarizeLiveStatus, type LiveStatusSummary } from '@/utils/liveStatus';
import { STATUS_ROW_TAP_SLOP_BOTTOM, STATUS_ROW_TAP_SLOP_TOP } from './agentDockLayout';
import { AnimatedFade } from './AnimatedOverlay';
import { NativeSettingsMenu, type NativeSettingsMenuGroup } from './NativeSettingsMenu';
import { UsageAccountBarsSheet } from './UsageAccountBarsSheet';
import type { UsageBarGroup } from './agentInputUsage';
import { SessionAgentsSheet } from './SessionAgentsSheet';
import { StatusDot } from './StatusDot';
import {
    showsContextPercent,
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
 *     ● Bash 1m 1s ˄ · Opus 5 1M · jamrizzi 23% ˄ · ◔
 *
 * Left to right: what the session is doing and for how long, the model it is
 * doing it on, the account it is spending, and the context gauge. The branch
 * was here too until DROVE-90 moved it under the session title, where tapping
 * it lists the repo's worktrees; Clay found the row too full. Nothing was
 * dropped, only folded: the working segment opens the agent tree, the DOT
 * opens session info, the model opens the model picker, the quota opens a bar
 * per account and per window (DROVE-107), the gauge swaps to exact tokens.
 *
 * THE DOT IS THE CONNECTION, AND THE WORD IS GONE (DROVE-138). Clay: "where it
 * says online that should just be a little dot." The dot's colour already WAS
 * the state (working blue, online green, gone grey, waiting orange), so the
 * word beside it repeated it and cost the width the account needed. The dot
 * inherits the word's tap target and its accessibility label, so session info
 * is still one tap from here and a screen reader still hears "online".
 *
 * THE MODEL AND THE ACCOUNT MOVED IN (DROVE-138). The model came down off the
 * button row, where 63pt between six buttons cut `Opus 5 1M` to `Opus 5...`;
 * here it has the room to be read. The account was invisible everywhere except
 * the flip menu, and it heads the quota because the quota is that account's.
 * Both are named by the derivations the rest of the app already uses, never a
 * second one (DROVE-129): `resolveSessionAccount` for the account, which the
 * session info screen also reads, and `shortModelName` for the model.
 *
 * What was folded to pay for them, and why, is written down in
 * statusRowLayout.ts along with the arithmetic.
 *
 * Every fold that EXPANDS opens its own list on the first tap, never an
 * intermediate menu (DROVE-111). Clay, twice: "it shouldn't be opening a menu
 * that then opens the list of options." The two sheets (DROVE-117 for the
 * quota, DROVE-111 for the tree) share one piece of state, so opening one
 * closes the other rather than stacking them.
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
     * The account this session runs on, from `resolveSessionAccount` and not a
     * second derivation of it (DROVE-129, DROVE-138). Heads the quota, because
     * the quota is this account's.
     */
    accountName?: string | null;
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

    const hasUsage = p.weekPercent != null || p.contextStatus != null;
    if (!summary && !p.connectionStatus && !hasUsage && !p.modelName) {
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
                    // The last of the three that shrink, after the account and
                    // the model: a long tool name must not push the quota off
                    // the line, but the numbers beside it are what Clay is
                    // watching (statusRowShrink).
                    flexShrink: statusRowShrink.live,
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

    // The model, in full, off the button row where it was being cut to
    // `Opus 5...` (DROVE-138). One tap opens the model list, on iOS as the
    // native menu anchored here and everywhere else as the picker: never a
    // menu that then lists the three controls (DROVE-111).
    if (p.modelName) {
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

    // The account heads the quota, because the quota IS this account's, and
    // the sheet behind the tap is the list of accounts (DROVE-138). The word
    // `week` folds away when it does: `jamrizzi 23%` is one fact about one
    // account and the sheet spells the window out. With no account there is
    // nothing to head it, so the window keeps its name.
    const quotaText = statusRowQuotaText(
        p.accountName,
        p.weekPercent,
        p.weekPercent == null
            ? ''
            : t('agentInput.context.percentWeek', { percent: Math.round(p.weekPercent) }),
    );
    if (quotaText != null) {
        const account = p.accountName?.trim() || null;
        const quotaBody = account ? (
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
                    {account}
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
                    accessibilityLabel={account ? `Quota, ${quotaText}` : undefined}
                    accessibilityState={{ expanded: openSheet === 'usage' }}
                    hitSlop={segmentHitSlop}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 3,
                        flexShrink: account ? 1 : 0,
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
        // The ring alone once the account is on the row: it fills with the
        // same number the text was printing, and the tap still prints the
        // exact tokens. The cheapest thing on a full row to lose.
        const showPercent = showsContextPercent(p.accountName, showPreciseContext);
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

    // One dot, and its colour is the state: the working blue while the CLI
    // reports a live turn, otherwise whatever the connection says (green
    // online, grey gone, orange waiting on you).
    const dotColor = summary ? workingColor : p.connectionStatus?.dotColor;
    // The word `online` is gone, so the dot inherits everything it carried:
    // the tap into session info, and the state IN WORDS for a screen reader
    // (DROVE-138). The screen says it in colour; this says it out loud.
    const dotLabel = [
        summary ? 'Working' : null,
        p.connectionStatus?.text,
    ].filter((part): part is string => !!part).join(', ');

    return (
        <AnimatedFade visible={p.showDetails || summary !== null}>
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                // 18 = 10pt shell inset + 8pt action inset: lines the row up
                // with the composer card's controls.
                paddingHorizontal: statusRowMetrics.paddingHorizontal,
                paddingTop: 6,
                minHeight: 18,
            }}>
                {dotColor ? (
                    <Pressable
                        onPress={p.onSessionInfoPress}
                        disabled={!p.onSessionInfoPress}
                        // Wider on the left than a segment, because the dot is
                        // 7pt of target at the very start of the row.
                        hitSlop={{ ...segmentHitSlop, left: 14, right: 8 }}
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
                            isPulsing={summary ? true : p.connectionStatus?.isPulsing}
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
                    open={openSheet === 'usage'}
                    onClose={closeSheet}
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
