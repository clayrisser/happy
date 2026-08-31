import * as React from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { router } from 'expo-router';
import { useMachine, useSession } from '@/sync/storage';
import { addAccountEntry } from '@/sync/machineAccountsFlow';
import { confirmDroverSwitch } from '@/utils/droverAccountSwitch';
import {
    isLiveStatusFresh,
    summarizeLiveStatus,
    type LiveStatusMain,
    type LiveStatusSummary,
} from '@/utils/liveStatus';
import { STATUS_ROW_TAP_SLOP_BOTTOM, STATUS_ROW_TAP_SLOP_TOP } from './agentDockLayout';
import { MOBILE_COMPOSER_LAYOUT, MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import { COMPOSER_STRIP_BOX } from './composerStripLayout';
import { AnimatedFade } from './AnimatedOverlay';
import { UsageAccountBarsSheet } from './UsageAccountBarsSheet';
import type { UsageBarGroup } from './agentInputUsage';
import { SessionAgentsSheet } from './SessionAgentsSheet';
import { SessionTasksSheet } from './SessionTasksSheet';
import { useSessionTasks } from './SessionTasksList';
import { sessionTasksBadge } from '@/utils/sessionTasks';
import { StatusDot } from './StatusDot';
import {
    showsContextPercent,
    STATUS_ROW_GIVE_WAY,
    statusRowMetrics,
    statusRowQuotaText,
    statusRowShrink,
} from './statusRowLayout';
import {
    resolveStatusStrip,
    statusStripAccountCap,
    statusStripMetrics,
    statusStripQuotaText,
    type StatusStripContent,
} from './statusStripLayout';
import {
    statusDotBlinks,
    statusDotColors,
    statusDotLabels,
    statusDotState,
} from './statusDotState';
import { contextCompactionPercent, contextReading } from './contextCompaction';
import { usageToneColor } from './usageTone';
import type { UsageBarTone } from './agentInputUsage';
import { useTickingNow } from './useTickingNow';
import type { SessionState } from '@/sync/sessionState';

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
 *     ● Bash 1m 2s 251.2k ⚇3 ˄ · jamrizzi 23% ˄ · ◔
 *
 * Left to right: what the MAIN thread is doing, for how long, and what it has
 * spent (DROVE-155); how many background agents are out; then the account it
 * is spending, and the context gauge (DROVE-138).
 * The branch was here too until DROVE-90 moved it under the session title,
 * where tapping it lists the repo's worktrees; Clay found the row too full.
 * Nothing was dropped, only folded: the working segment opens the agent tree,
 * the DOT opens session info, the quota opens a bar per account and per window
 * (DROVE-107), the gauge swaps to exact tokens.
 *
 * THE DOT IS THE CONNECTION, AND THE WORD IS GONE (DROVE-138). Clay: "where it
 * says online that should just be a little dot." The dot's colour already WAS
 * the state, so the word beside it repeated it and cost the width the account
 * needed. The dot inherits the word's tap target and its accessibility label,
 * so session info is still one tap from here and a screen reader still hears
 * "online".
 *
 * THE ACCOUNT MOVED IN (DROVE-138), AND THE MODEL MOVED BACK OUT (DROVE-178).
 * The model came down here because a name among six buttons was showing
 * `Opus 5 1M` as `Opus 5...`; DROVE-153 then collapsed that row to three
 * objects and freed the gap it needed, and Clay drew an arrow from the name
 * here up into it. So the model is the session capsule's third segment again
 * and this row is one segment shorter, which is what it needed: it was
 * carrying the main thread's clock, the agent count, the model AND the
 * account. The account stays. It was invisible
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
 * Four things are FOLDED to keep one line on the narrowest phone with an
 * account and a quota on it, and nothing is truncated:
 *
 *   - the word "agents" is a glyph and a count; the tree spells it out.
 *   - the word "online" is gone entirely; the dot's colour is the state.
 *   - the word "week" goes when an account heads the quota, because
 *     `jamrizzi 23%` is one fact about one account and the sheet spells the
 *     window out. With no account to head it the window keeps its name.
 *   - the context gauge drops its percent text while the main thread works, or
 *     whenever the account is on the row: the ring beside it fills with the
 *     same number and a tap still opens the exact figure.
 *   - a TOOL's name goes and the numbers stay whenever the row would not
 *     otherwise fit. That was a 360pt constant before the account was here; it
 *     is now asked of statusRowLayout's estimator with the row's real content,
 *     because the width it fires at depends on how long this tool and this
 *     account happen to be. NEVER the working word (DROVE-223): it is the same
 *     string slot and it folds last of anything on the row, not third.
 *
 * AND THE ORDER THEY GIVE WAY IN IS WRITTEN DOWN NOW (DROVE-223). Clay
 * photographed `● wor… 4m 20s 51.6k ⛄6 ˄ · main 8% ˄`: the working word, the
 * leftmost and most important fact on the line, cut to three letters while the
 * account beside it drew whole and a hundred points of row sat empty. Nothing
 * was over budget. The live segment carried `maxWidth: '45%'` here, a share of
 * the WHOLE row that no budget in statusRowLayout could see, and the only
 * child under it that can shrink is the label. With no tool running the label
 * IS the working word.
 *
 * So the cap is measured off the rest of the line now, and it is dropped
 * entirely while the label is the working word, because that word is LAST in
 * `STATUS_ROW_GIVE_WAY`, the order this row now gives way in and the rule the
 * next fact added to the line inherits. Ahead of it, in order: the context
 * percent, the word `week`, a TOOL's name, the account truncating, the token
 * count, the clock. Clay's own reading: "the working word goes last, because
 * it answers what is happening, and the token count or the elapsed timer can
 * shorten or drop before it."
 *
 * Renders nothing at all when there is nothing to say, and the test for that
 * is the ROW rather than the props it was handed (DROVE-194): the segments are
 * built first and a row with no segments and no dot is the one that collapses.
 * The props-shaped version of that question could not fire on a session screen,
 * because `connectionStatus` is always an object there, so the strip kept its
 * 24pt for a row that drew nothing. Its own module so a test can mount it
 * without the composer around it.
 */

/**
 * AND DROVE-231 MADE IT THREE ZONES AND GAVE THE DOT THE WHOLE STATE.
 *
 * Clay, handing over the entire strip at once because pieces of it kept being
 * re-derived one ticket at a time: "Token count is centered. The dot is green
 * for connected, blinking blue when working and yellow when recently
 * disconnected and red if disconnected for a while. Don't show text working.
 * The number of workers is next to the green dot. Account is right aligned
 * with the percentage and changes color as it fills up. Also should show
 * something for context or something so we know when compaction happens next.
 * Also when compacting the dot turns purple and blinks."
 *
 * Four changes, and the first is the shape of the line:
 *
 *   1. THREE ZONES. Left the dot and the workers, centre the tally, right the
 *      account and its percentage. Built as a flexbox tree in
 *      statusStripLayout.ts and resolved by DROVE-214's `flexFrames`, so the
 *      centre is centred by the layout system and not by an offset anybody
 *      computed. Clay, about the composer and now about this: "why don't you
 *      use layout system for these things?"
 *   2. THE WORD `working` IS GONE, and the dot carries every state instead:
 *      green idle, blinking blue working, amber waiting on you, yellow just
 *      dropped, red gone a while, blinking purple compacting. The thresholds
 *      and the blink period are named constants in statusDotState.ts with the
 *      reasoning next to them. The blink means BUSY and nothing else, so the
 *      two blinking states are told apart by hue, which is the only thing that
 *      can tell them apart.
 *   3. THE PERCENTAGE COLOURS BY THE QUOTA SHEET'S OWN RAMP. `usageBarTone` on
 *      the same window the sheet reads, carried out of `resolveUsageStrip` as
 *      `weekTone` and painted by usageTone.ts, which the bars now call too.
 *      One rule, two surfaces (DROVE-230).
 *   4. THE CONTEXT RING IS A COUNTDOWN TO THE NEXT COMPACTION. It fills toward
 *      the compaction point rather than the raw window, so full means compact
 *      now; contextCompaction.ts says what it is measured from and what it
 *      refuses to claim.
 *
 * The give-way order moved with the layout and is still one list
 * (`STATUS_ROW_GIVE_WAY`). The working word left it because it left the strip;
 * the tally and the clock swapped, because Clay has just put the tally on the
 * centre of the line and the clock is not one of the three zones.
 */

/**
 * AND DROVE-244 PUT A WORD BACK IN THE SLOT, BUT NOT THAT WORD.
 *
 * Clay: "When it's thinking instead of bashing on the main thread show the
 * thinking token count." His screenshot reads `● Bash 2m 58s 👥6 ^` — the
 * label naming the running tool, which is DROVE-223's `toolName` working
 * exactly as intended. What that slot could not say is the other state: the
 * main thread thinking with no tool in flight. It went blank there and the
 * line held the last thing it knew, through the one state where he most wants
 * to know something is happening and what it is costing.
 *
 * So the slot now holds a tool's name OR the word `thinking`, and nothing
 * else. That is not `working` coming back. `working` said what the blinking
 * blue dot already said, which is why 231 took it off; `thinking` says WHAT,
 * which is the job the slot has always had. No term was added to the line —
 * the strip is the same three zones with the same slot filled in one more
 * state.
 *
 * The count sits next to the word, in the left zone, because it describes the
 * CURRENT ACTIVITY. The centre keeps meaning the session's spend and only that
 * (DROVE-241 is moving it from the turn to the session total); a figure that
 * changed meaning whenever the model started reasoning would be worse than no
 * figure. Two numbers, two zones, two scopes, and the one on the left is a
 * SHARE of the one in the centre rather than an addition to it, because
 * extended thinking is billed inside output tokens.
 *
 * The number needs a CLI that publishes `tokens.turnThinking`; the WORD does
 * not, because "the main thread is working and no tool is in flight" is
 * already on the wire. That split is deliberate — DROVE-220 means a session
 * running right now will never pick up a new CLI, so the half that could work
 * today does.
 */

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

/**
 * The ring, filling toward the NEXT COMPACTION (DROVE-231).
 *
 * `fraction` is used against the compaction point, not against the raw window,
 * so a full ring means the compaction pass is about to run rather than "the
 * window is full", which is a state that never occurs because the agent
 * compacts first. contextCompaction.ts derives it and says what from.
 *
 * Grayscale on purpose: it reads at a glance without colour, and colour on
 * this strip belongs to the dot and to the quota percentage.
 */
function ContextGaugeIcon(props: { fraction: number }) {
    const { theme } = useUnistyles();
    const size = statusStripMetrics.gauge;
    const strokeWidth = 2.5;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = Math.min(100, Math.max(0, props.fraction * 100));
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
    /**
     * The colour the CONNECTION would paint on its own.
     *
     * The dot no longer takes it (DROVE-231): `statusDotState` decides the
     * state and `statusDotColors` paints it, so that one table is the whole
     * answer instead of a colour arriving from one place and a pulse from
     * another. Kept because the field is what tells the row a connection
     * exists at all, which is the guard that decides whether a dot is drawn.
     */
    dotColor: string;
    isPulsing?: boolean;
    /**
     * The session's state, so the dot can tell "just dropped" from "gone a
     * while" and "waiting on you" from "idle" (DROVE-231). Absent on a caller
     * that has no session behind it; the row then falls back to the session
     * store, and to `connected` when there is neither.
     */
    state?: SessionState;
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
    /**
     * The two numbers the context reading is made of, raw (DROVE-231).
     *
     * It used to arrive pre-derived as `{ percent, detailText, color }`, built
     * by `getContextStatus` in AgentInput, which also decided the gauge was
     * only worth drawing within 10% of the window. That rule was written when
     * the row had no width to spare; the centre zone does, and a gauge that
     * appears at 90% cannot answer "when does compaction happen next". So the
     * row takes the numbers and contextCompaction.ts does the deriving.
     */
    contextUsage: { contextSize: number; contextWindow?: number } | null;
    /** The setting that prints the context figure as text, not just the ring. */
    alwaysShowContext?: boolean;
    weekPercent: number | null;
    /**
     * The quota's colour band, from the sheet's own `usageBarTone` (DROVE-230,
     * DROVE-231). Carried from `resolveUsageStrip` rather than recomputed, so
     * the strip and the bars cannot disagree about whether an account is warm.
     */
    weekTone?: UsageBarTone;
    /**
     * The week popup's bar rows: this account's session, week and family
     * windows, then every other drover account folded under a second heading
     * (DROVE-47). One thin row each, name and track and number on one line
     * (DROVE-107).
     */
    usageBarGroups: UsageBarGroup[];
    /** The zone and the model the sheet's numbers are for (DROVE-173). */
    usageBarFooter?: string;
    /** When the snapshot was taken, so the sheet can say how old it is (DROVE-230). */
    usageBarCapturedAt?: number | null;
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
function accessibilityLabelFor(
    main: LiveStatusMain | null,
    sideCount: number,
    sideTokens: string | null,
): string {
    const parts: string[] = [];
    if (main) {
        parts.push(`Main thread: ${main.label} ${main.elapsed}`);
        // Spelled out as a total, because the glance version is a bare number
        // and DROVE-184 changed what that number MEANS. A screen reader saying
        // "251.2k tokens" beside "Main thread" would still describe the old,
        // main-only reading.
        if (main.tokens) parts.push(`${main.tokens} tokens across main and agents`);
        // Named as a SHARE, because it is one (DROVE-244): extended thinking
        // is billed inside output tokens, so a reader hearing the two numbers
        // in a row must not be left to add them.
        if (main.thinkingTokens) {
            parts.push(`${main.thinkingTokens} of them thinking this turn`);
        }
    }
    if (sideCount > 0) parts.push(`${sideCount} ${sideCount === 1 ? 'agent' : 'agents'}`);
    if (!main && sideTokens) parts.push(`${sideTokens} tokens across main and agents`);
    return parts.join(', ');
}

// The middot separator is gone (DROVE-231). Three zones separate the facts
// spatially, and inside a zone two tappable clusters are held apart by
// `statusStripMetrics.clusterGap`, the same 16pt the middot and its margins
// cost, spent as space the layout can see rather than as a glyph it cannot.

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
    // (DROVE-160). The block routes this through the sheet's own exit
    // (DROVE-183), so by the time it arrives the Modal is off the screen and
    // the system alert has somewhere to present; the close here is the
    // belt-and-braces for any path that did not. Nothing new is sent:
    // confirmDroverSwitch is the `/flip` message every other surface sends.
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

    // The add row at the end of the sheet (DROVE-208). This is the only place
    // that knows the session, so it is the only place that can name the
    // machine: an account is a login on one machine, and a session runs on
    // exactly one, so the row targets that machine and does not ask. The tap
    // goes to Settings -> Accounts with the machine already chosen, which is
    // DROVE-165's flow reached from here rather than a second copy of it,
    // and it is also the answer for wanting a DIFFERENT machine, since that
    // screen lists them all. No credential passes through any of this: the
    // machine runs `claude auth login` and Clay finishes it in a browser.
    const session = useSession(sessionId ?? '');
    const machineId = sessionId ? session?.metadata?.machineId ?? null : null;
    const machine = useMachine(machineId ?? '');
    const machineLabel = machine?.metadata?.displayName || machine?.metadata?.host || null;
    const addAccount = React.useMemo(() => {
        const entry = addAccountEntry({ machineId, machineName: machineLabel });
        if (!entry) return null;
        return {
            machineName: entry.machineName,
            onPress: () => router.push(entry.href as never),
        };
    }, [machineId, machineLabel]);

    const canExpand = !!summary && summary.rows.length > 0;
    const canOpenUsage = p.usageBarGroups.length > 0;

    const main = summary?.main ?? null;
    /**
     * Agents plus workflows, and there is no second count anywhere (DROVE-155,
     * DROVE-185, DROVE-209). Clay asked for "the number of workers next to the
     * green dot" and this is that number; the Morse heartbeat reads the same
     * field, which is what stopped the wrist saying two while the screen said
     * three whenever a workflow was running.
     */
    const sideCount = summary?.sideCount ?? 0;
    const sideTokens = summary?.sideTokens ?? null;
    // The main thread is working, and whether it is blocked on a TOOL. The two
    // are different facts now: the dot says working, so the label slot only
    // ever holds a tool's name (DROVE-231).
    const mainWorking = main !== null;
    const toolRunning = !!main && !main.working;

    // How much room until the next compaction, from the transcript's own
    // context against the model's window. Null until the session reports a
    // window, because a percentage against a guess corrects itself upward
    // later and a gauge that goes DOWN reads as the context refilling.
    const context = contextReading(p.contextUsage?.contextSize, p.contextUsage?.contextWindow);

    // A connection with no state on it is a CONNECTION, not a missing one.
    // SessionView always sends the state; a preview or a harness that only
    // hands over a colour must not read as disconnected because of what it
    // left out. `presence` is `'online'` or the timestamp it was last seen at,
    // so a NUMBER there is the offline case and also the answer to when.
    const lastSeenAt = typeof session?.presence === 'number'
        ? session.presence
        : session?.activeAt ?? null;
    const offline = p.connectionStatus?.state
        ? p.connectionStatus.state === 'disconnected'
        : typeof session?.presence === 'number';
    // A clock only while the session is OFFLINE, and a slow one. The dot's
    // yellow turns red on a threshold rather than on an event, so something
    // has to re-read the time. Five seconds is far finer than the two-minute
    // window needs and costs a live session nothing, since the interval is not
    // started at all while it is up.
    const now = useTickingNow(offline, 5000);

    const dotState = statusDotState({
        online: !offline,
        lastSeenAt,
        mainWorking,
        toolRunning,
        atCompaction: context?.atCompaction ?? false,
        waiting: p.connectionStatus?.state === 'permission_required'
            || p.connectionStatus?.state === 'input_required',
        now,
    });
    // A dot is drawn whenever there is a connection to speak for. The COLOUR
    // is `statusDotColors`', never the one the connection carried: one table
    // decides the state and paints it, so a colour and a pulse can no longer
    // arrive from two places and disagree (DROVE-231).
    const hasDot = !!p.connectionStatus?.dotColor;
    const dotColor: string | null = hasDot ? statusDotColors[dotState] : null;

    // The quota's two halves. The account heads it because the quota IS this
    // account's and the sheet behind the tap is the list to switch to
    // (DROVE-160); both are read off `usageBarGroups`, so the row's name, the
    // sheet's heading and the `from` a switch sends are one value (DROVE-129).
    const quotaPercentText = p.weekPercent == null ? null : `${Math.round(p.weekPercent)}%`;
    const quotaWindowText = shownAccount
        ? null
        : statusRowQuotaText(
            null,
            p.weekPercent,
            p.weekPercent == null
                ? ''
                : t('agentInput.context.percentWeek', { percent: Math.round(p.weekPercent) }),
        );
    // The percentage's colour, from the quota sheet's own ramp on the same
    // window (DROVE-230). Never a second ramp: Clay asked for one behaviour
    // and two surfaces have to answer it the same way.
    const quotaColor = p.weekTone
        ? usageToneColor(p.weekTone, theme)
        : theme.colors.textSecondary;

    const showContextPercentText = !!context
        && showsContextPercent(shownAccount, showPreciseContext, mainWorking);
    const contextPercentText = context
        ? (showPreciseContext
            ? context.detail
            : t('agentInput.context.percentContext', { percent: contextCompactionPercent(context) }))
        : null;

    /**
     * WHAT THE STRIP WANTS TO SAY, before the line decides what it can afford.
     *
     * The label slot names the running TOOL, or says `thinking` when the main
     * thread is working with none in flight (DROVE-244). Clay: "When it's
     * thinking instead of bashing on the main thread show the thinking token
     * count." The old `working` word is still gone and stays gone — the dot is
     * blinking blue at that moment and a word repeating it earned nothing —
     * but a blank slot was not the answer either: it held the last thing it
     * knew through the one state where Clay most wants to know something is
     * happening.
     *
     * TWO TOKEN FIGURES, AND THEY NEVER TRADE PLACES (DROVE-241). The centre
     * is the session's spend and means the same thing at every moment; the
     * left one is what THIS thinking has cost and exists only while the word
     * beside it does. Different zones, different scopes, and the centre is
     * untouched by any of this.
     */
    const content: StatusStripContent = {
        dot: hasDot,
        toolName: mainWorking ? main!.label : null,
        stateWord: mainWorking && main!.working,
        thinkingTokens: main?.thinkingTokens ?? null,
        elapsed: main?.elapsed ?? null,
        tokens: main?.tokens ?? sideTokens,
        workers: sideCount,
        liveExpands: canExpand,
        tasks: p.sessionId ? tasksBadge : null,
        account: shownAccount,
        quotaPercent: quotaPercentText,
        quotaWindow: quotaWindowText,
        quotaExpands: canOpenUsage,
        contextGauge: !!context,
        contextPercent: showContextPercentText ? contextPercentText : null,
    };
    // The zones, the folds and the geometry, all from the one flexbox tree
    // (DROVE-214's resolver, DROVE-231's zones). Nothing here is an offset.
    const { drawn } = resolveStatusStrip(content, width, STATUS_ROW_GIVE_WAY);
    // What the ACCOUNT may take before it truncates: what the right zone's
    // share leaves once the percentage and the chevron have theirs. A number,
    // measured off this row, and never a fraction of the whole line. That was
    // DROVE-223's `45%`, and it cut the most important word on the strip.
    const accountCap = statusStripAccountCap(drawn, width);
    const quotaText = statusStripQuotaText(drawn);

    const dotNode = dotColor ? (
        <Pressable
            key="dot"
            onPress={p.onSessionInfoPress}
            disabled={!p.onSessionInfoPress}
            // Wider on the left than a segment, because the dot is 7pt of
            // target at the very start of the row.
            hitSlop={{ ...segmentHitSlop, left: 16, right: 10 }}
            accessibilityRole={p.onSessionInfoPress ? 'button' : undefined}
            // The word beside the dot is gone, so this is the only place the
            // state is said in words (DROVE-138, DROVE-231).
            accessibilityLabel={statusDotLabels[dotState]}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                opacity: pressed && p.onSessionInfoPress ? 0.6 : 1,
            })}
        >
            <StatusDot
                color={dotColor}
                // Exactly the two states that are burning tokens, at one
                // shared period, so the blink says BUSY and the hue says which
                // kind of busy (statusDotState.ts).
                isPulsing={statusDotBlinks(dotState)}
                size={statusRowMetrics.dot}
                style={{ marginTop: 1 }}
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
    ) : null;

    const hasLive = !!(drawn.toolName || drawn.thinkingTokens || drawn.elapsed || sideCount > 0);
    const liveNode = hasLive ? (
        <Pressable
            key="live"
            onPress={canExpand
                ? () => setOpenSheet((open) => (open === 'agents' ? null : 'agents'))
                : undefined}
            hitSlop={segmentHitSlop}
            accessibilityRole={canExpand ? 'button' : undefined}
            accessibilityState={canExpand ? { expanded: openSheet === 'agents' } : undefined}
            accessibilityLabel={accessibilityLabelFor(main, sideCount, sideTokens)}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: statusStripMetrics.gap,
                minWidth: 0,
                flexShrink: statusRowShrink.live,
                opacity: pressed && canExpand ? 0.6 : 1,
            })}
        >
            {drawn.toolName ? (
                /* A TOOL's name may be cut mid-string; the STATE WORD may not
                   (DROVE-223, DROVE-244). `mcp__chrome_devtools__take_scr…` is
                   still recognisable and `think…` is not, and the word does
                   not need cutting anyway: it folds whole, last of anything on
                   the strip, and the layout has already found a line it fits
                   on by the time this draws. */
                <Text
                    numberOfLines={drawn.stateWord ? undefined : 1}
                    style={{
                        fontSize: 11,
                        color: theme.colors.text,
                        flexShrink: drawn.stateWord ? 0 : 1,
                        ...Typography.default(),
                    }}
                >
                    {drawn.toolName}
                </Text>
            ) : null}
            {drawn.elapsed ? (
                <Text style={{ fontSize: 11, color: theme.colors.text, ...Typography.default() }}>
                    {drawn.elapsed}
                </Text>
            ) : null}
            {drawn.thinkingTokens ? (
                /* What this thinking has cost, third of the three and in the
                   SECONDARY colour like the worker count beside it
                   (DROVE-244). Third because Claude Code's own status line is
                   `Actualizing… (20s · ↓ 424 tokens)` and the strip's tool
                   state is `Bash 2m 58s`: verb, clock, tokens, in both. The
                   secondary weight is what keeps it from reading as a second
                   copy of the centre's figure, which is the session and a
                   different number entirely (DROVE-241). */
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {drawn.thinkingTokens}
                </Text>
            ) : null}
            {sideCount > 0 ? (
                <>
                    {/* The workers, beside the dot exactly as Clay asked, and
                        the whole of what the strip says about them: a glyph
                        and a number, in the secondary colour so they never
                        read as the main thread's own. */}
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
        </Pressable>
    ) : null;

    // What the session is working THROUGH, one tap from the strip (DROVE-167).
    const tasksNode = drawn.tasks && p.sessionId ? (
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
                gap: statusStripMetrics.gap,
                opacity: pressed ? 0.6 : 1,
            })}
        >
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                {drawn.tasks}
            </Text>
            <Ionicons
                name={openSheet === 'tasks' ? 'chevron-down' : 'chevron-up'}
                size={10}
                color={theme.colors.textSecondary}
            />
        </Pressable>
    ) : null;

    // THE CENTRE: the tally, on the line's true centre, and the ring counting
    // down to the next compaction beside it. The tap opens the tree, where
    // DROVE-184's breakdown of main against fan-out lives.
    const centreNode = drawn.tokens || context ? (
        <View
            key="centre"
            style={{ flexDirection: 'row', alignItems: 'center', gap: statusStripMetrics.gap }}
        >
            {drawn.tokens ? (
                <Pressable
                    onPress={canExpand
                        ? () => setOpenSheet((open) => (open === 'agents' ? null : 'agents'))
                        : undefined}
                    hitSlop={segmentHitSlop}
                    accessibilityRole={canExpand ? 'button' : undefined}
                    accessibilityLabel={accessibilityLabelFor(main, sideCount, sideTokens)}
                    style={({ pressed }) => ({ opacity: pressed && canExpand ? 0.6 : 1 })}
                >
                    <Text style={{ fontSize: 11, color: theme.colors.text, ...Typography.default() }}>
                        {drawn.tokens}
                    </Text>
                </Pressable>
            ) : null}
            {context ? (
                <Pressable
                    onPress={() => setShowPreciseContext((current) => !current)}
                    hitSlop={segmentHitSlop}
                    accessibilityRole="button"
                    accessibilityLabel="Context"
                    // The sentence with its source in it, so a screen reader
                    // hears what the ring is measured against (DROVE-231).
                    accessibilityValue={{ text: context.detail }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: statusStripMetrics.gap }}
                >
                    {drawn.contextPercent ? (
                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {drawn.contextPercent}
                        </Text>
                    ) : null}
                    <ContextGaugeIcon fraction={context.fraction} />
                </Pressable>
            ) : null}
        </View>
    ) : null;

    // THE RIGHT: the account, hard against the far inset, with the percentage
    // it colours by. The quota opens a sheet that slides up (DROVE-117): a
    // native menu row is a string, so it can hold a sentence but never a bar.
    const quotaBody = (
        <>
            {drawn.account ? (
                <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{
                        fontSize: statusRowMetrics.fontSize,
                        color: theme.colors.textSecondary,
                        flexShrink: statusRowShrink.account,
                        minWidth: 0,
                        ...(accountCap == null ? null : { maxWidth: accountCap }),
                        ...Typography.default(),
                    }}
                >
                    {drawn.account}
                </Text>
            ) : null}
            {quotaText ? (
                <Text style={{
                    fontSize: statusRowMetrics.fontSize,
                    // The one coloured number on the strip, and it warms by
                    // the sheet's ramp (DROVE-230).
                    color: quotaColor,
                    flexShrink: statusRowShrink.quota,
                    ...Typography.default(),
                }}>
                    {quotaText}
                </Text>
            ) : null}
        </>
    );
    const hasQuota = !!(drawn.account || quotaText);
    const rightNode = hasQuota ? (
        canOpenUsage ? (
            <Pressable
                key="week"
                onPress={() => setOpenSheet((open) => (open === 'usage' ? null : 'usage'))}
                accessibilityRole="button"
                accessibilityLabel={drawn.account ? `Quota, ${drawn.account} ${quotaText ?? ''}`.trim() : undefined}
                accessibilityState={{ expanded: openSheet === 'usage' }}
                hitSlop={{ ...segmentHitSlop, right: 16 }}
                style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: statusStripMetrics.gap,
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
            <View key="week" style={{ flexDirection: 'row', alignItems: 'center', gap: statusStripMetrics.gap, minWidth: 0 }}>
                {quotaBody}
            </View>
        )
    ) : null;

    // THE GUARD IS ASKED OF THE ROW, NOT OF THE PROPS (DROVE-194). Counting
    // what was built cannot drift from what is painted; asking whether
    // anything COULD be on the row could never fire, because
    // `connectionStatus` is an object SessionView rebuilds every render.
    const drawsSomething = !!(liveNode || tasksNode || centreNode || rightNode);
    if (!drawsSomething && !dotColor) {
        return null;
    }

    return (
        <AnimatedFade visible={p.showDetails || summary !== null}>
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                // The composer's glyph column, 19 from the screen edge: where
                // the `+`'s ink starts, so the row lines up with it. Read off
                // the composer rather than rebuilt here (DROVE-206).
                paddingHorizontal: MOBILE_COMPOSER_LAYOUT.textInset,
                // The strip's box, shared with the recording banner over it
                // (DROVE-157, DROVE-221), so a mic cannot resize the dock.
                ...COMPOSER_STRIP_BOX,
            }}>
                {/* LEFT ZONE. `flex: 1`, with the spacer on its inner side, so
                    its content sits hard against the inset and it takes half
                    of whatever the centre leaves. That halving is what puts
                    the centre on the true middle. No offset computes it. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: statusStripMetrics.dotGap,
                        minWidth: 0,
                    }}>
                        {dotNode}
                        {liveNode || tasksNode ? (
                            <View style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: statusStripMetrics.clusterGap,
                                minWidth: 0,
                            }}>
                                {liveNode}
                                {tasksNode}
                            </View>
                        ) : null}
                    </View>
                    <View style={{ flex: 1 }} />
                </View>
                {centreNode}
                {/* RIGHT ZONE. The mirror of the left: spacer first, so the
                    account and its percentage end on the far inset. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}>
                    <View style={{ flex: 1 }} />
                    {rightNode}
                </View>
            </View>
            {canOpenUsage ? (
                <UsageAccountBarsSheet
                    groups={p.usageBarGroups}
                    footer={p.usageBarFooter}
                    capturedAt={p.usageBarCapturedAt}
                    open={openSheet === 'usage'}
                    onClose={closeSheet}
                    onSwitchAccount={sessionId ? onSwitchAccount : undefined}
                    addAccount={addAccount}
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
