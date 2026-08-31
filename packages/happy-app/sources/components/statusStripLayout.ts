/**
 * THE STATUS STRIP IS THREE ZONES, NOT A ROW OF SEGMENTS (DROVE-231).
 *
 * Clay, giving the whole line at once because pieces of it kept being
 * re-derived one ticket at a time: "Token count is centered. ... The number of
 * workers is next to the green dot. Account is right aligned with the
 * percentage and changes color as it fills up."
 *
 * Today it draws `● 17.8k 👥4 ^ · main 1% ^`, every segment packed against the
 * left edge and the right half of the line empty. That is what a row of
 * segments does: it lays them out in order and the last one lands wherever the
 * ones before it left it. Centring the token count by pushing it with a margin
 * would be the same mistake in a different place, so:
 *
 *   left   the dot and the worker count, hard against the row's inset
 *   centre the token count, on the line's true centre
 *   right  the account and its percentage, hard against the far inset
 *
 * AND IT IS THE LAYOUT SYSTEM THAT HOLDS IT, NOT ARITHMETIC. Clay, after the
 * composer shipped visibly broken three times over a green suite: "why don't
 * you use layout system for these things?" DROVE-214 answered that for the
 * composer and left `flexFrames.ts` behind, a resolver that lays a style tree
 * out the way Yoga does, so a spec can measure real geometry instead of
 * restating the sums that produced it. This builds the strip as that tree.
 *
 * The centring falls out of flexbox rather than being computed: the two side
 * zones are `flex: 1` and the centre takes its content width, so the sides get
 * equal halves of whatever is left and the centre lands on the middle at every
 * width, with no offset anywhere. A spacer inside each side zone pushes its
 * content to the outer edge, which is the same `{ flex: 1 }` spacer the
 * composer's action row uses.
 *
 * WHAT EACH SIDE MAY TAKE IS THEREFORE HALF OF WHAT THE CENTRE LEAVES, and
 * that is the budget the give-way order spends. It is smaller than the old
 * row's, which had the whole line to pack into, so more folds fire; that is
 * the cost of the centre being a real centre and it is paid in the order
 * written down in statusRowLayout.ts rather than by whatever happened to be
 * last.
 *
 * DROVE-223's budget survives whole. `statusRowUsableWidth` is still what the
 * row has to draw in, AgentInput's 8pt gutter and the row's 19pt inset both
 * counted, and no zone carries a percentage cap the layout cannot see. That
 * `maxWidth: '45%'` is exactly the class of thing this module exists to
 * prevent, so every width here is either a measured estimate or a flex.
 *
 * AND NOTHING KEPT THE ZONES APART (DROVE-250).
 *
 * Clay, on a strip reading `● Bash 15m 23s ˄  17.1M  jam@codejam.ninja 78% ˄`:
 * "Do u see the issue here? They overlap".
 *
 * Measured, they were not overlapping. At 393 the tally and the account were
 * 10pt apart and the other seam was 52pt wide, and that asymmetry is what the
 * eye reads as a collision: one boundary five times the other, on a line whose
 * whole premise is three even zones. Calling it an overlap is the right report
 * of it. The layout had no opinion about either seam, because the question it
 * asked was `left <= share`, and a zone that is EXACTLY its share ends where
 * the next one begins. A three-column layout whose fit test is satisfied by
 * two columns touching has no rule that they must not.
 *
 * THE FLOOR IS 16pt, `statusRowMetrics.separator`, which is the strip's own
 * number rather than a new one. That is the separation the row already spends
 * to say two things are different: two tappable clusters inside ONE zone are
 * held apart by the middot and its 6pt margins, 16pt in all. Two ZONES are
 * more different than two clusters in one zone, so the boundary between them
 * cannot be tighter than the boundary inside them. Below that the eye groups
 * across the seam and the three zones read as one run, which is what the
 * photograph shows. Between zones the 16 is all whitespace rather than
 * 6 + glyph + 6, so it reads at least as separated as the same number does
 * inside a zone.
 *
 * It also has to survive the ESTIMATE. `glyphWidth` is an average advance and
 * the note on it says it runs about 3% lean against Plex; on a 150pt zone that
 * is ~5pt, and the error lands on the boundary. 16 absorbs it and still leaves
 * ~11pt clear, comfortably more than the 6pt middot margin that is the widest
 * clear run inside any zone. 8 would leave 3, which is the gap between two
 * items in one cluster, and would not be a floor at all.
 *
 * A CENTRE FOLD RELIEVES BOTH SIDES, which the zone-aware loop used to refuse.
 * A step was only taken while the zone it lives in was over, and the centre is
 * never over: `formatTokens` bounds it at six characters (DROVE-241). But each
 * side's share is HALF OF WHAT THE CENTRE LEAVES, so 6pt off the centre hands
 * 3pt to each side. Refusing the centre's steps while a side was over was the
 * second way the order could stop short of the floor.
 *
 * AND THE WORD IN THE LABEL SLOT IS GONE AGAIN (DROVE-250, correcting
 * DROVE-244). Clay, striking it out in red: "I told you NOT to put this word
 * thinking here. The dot covers it. We have precious space here." DROVE-231
 * took `working` off on that instruction and DROVE-244 put `thinking` back,
 * reading the objection as being about which word. It was about the SLOT. The
 * blinking blue dot already says the main thread is going, and 44pt of a 146pt
 * share is not a price this line can pay to restate it.
 *
 * So the slot holds a TOOL's name and nothing else. A tool name is a fact the
 * dot cannot carry — it says WHICH thing, not that something. With no tool in
 * flight the slot is empty and the clock, the thinking count and the workers
 * stand on their own. The word survives where it costs nothing: the sheet's
 * headline, the wrist's line, and the strip's accessibility label, which still
 * reads `Main thread: thinking 4m 20s`.
 *
 * That hands 44pt back to the exact line that was overlapping, so the floor is
 * mostly paid for before it is spent: in the thinking state the count and the
 * tally now survive at 320, which DROVE-244 could not manage at any width
 * below 375.
 *
 * Pure. Nothing renders; AgentInputStatusRow.tsx draws what this resolves.
 */
import {
    findFrame,
    measureFlexWidth,
    resolveFlexFrames,
    type FlexFrame,
    type FlexNode,
} from './flexFrames';
import {
    estimateStatusRowTextWidth,
    statusRowMetrics,
    statusRowUsableWidth,
    type StatusRowGiveWay,
} from './statusRowLayout';

/**
 * Everything on the strip that is not text.
 *
 * Derived from `statusRowMetrics` wherever the same object already exists, so
 * the two budgets cannot drift. The row's `chevron`, `agentsGlyph` and `gauge`
 * each bundle a glyph WITH the gap before it; here the zone's own `gap`
 * supplies that, so the glyph is taken on its own and the gap is added once.
 */
export const statusStripMetrics = {
    /** Between items inside a zone. The `gap: 3` every cluster already uses. */
    gap: 3,
    /** The dot, and its optical margin before whatever follows. */
    dot: statusRowMetrics.dot,
    dotGap: statusRowMetrics.dotMarginRight,
    /** Between two tappable clusters in one zone: the middot and its margins. */
    clusterGap: statusRowMetrics.separator,
    /** The fold chevron on its own, `size={10}`. */
    chevron: statusRowMetrics.chevron - 3,
    /** The people glyph on its own, `size={11}`. */
    workersGlyph: statusRowMetrics.agentsGlyph - 3,
    /** The context ring on its own: ContextGaugeIcon's `size`. */
    gauge: statusRowMetrics.gauge - 5,
    /**
     * THE FLOOR BETWEEN TWO ADJACENT ZONES (DROVE-250), in points.
     *
     * The row's own separator, which is the widest separation the strip
     * already spends: two tappable clusters inside one zone are held apart by
     * the middot and its 6pt margins. Two zones cannot be closer together than
     * two clusters inside one of them, or the seam stops reading as a seam.
     * Derived rather than written down again, so the thing it argues against
     * and the floor it sets cannot drift apart.
     */
    zoneGap: statusRowMetrics.separator,
} as const;

/** What the strip has to say, before anything folds. */
export interface StatusStripContent {
    /** The dot is drawn. It is the only thing on the strip that never folds. */
    dot?: boolean;
    /**
     * The TOOL the main thread is blocked on, and never a state word
     * (DROVE-250, correcting DROVE-244).
     *
     * Clay has now refused a word in this slot twice: "Don't show text
     * working" for DROVE-231, then "I told you NOT to put this word thinking
     * here. The dot covers it. We have precious space here." for this. The
     * objection is to the slot, not to the word in it. A tool name earns the
     * room because the dot cannot say WHICH thing is running; a state word
     * only repeats the blinking blue dot beside it.
     *
     * With no tool in flight this is null and the slot is not drawn. What the
     * main thread is doing is still said in the accessibility label, on the
     * sheet's headline and on the wrist, where it costs no width.
     */
    toolName?: string | null;
    /**
     * `3.4k` — what THIS thinking has cost (DROVE-244, and the half of it Clay
     * asked for by name: "when it's thinking instead of bashing on the main
     * thread show the thinking token count").
     *
     * A number, not a word. It appears only while no tool is running, which is
     * the same condition that empties `toolName`, so the two are never on the
     * line together.
     */
    thinkingTokens?: string | null;
    /** The turn's clock, `4m 20s`. */
    elapsed?: string | null;
    /** The centre zone's number: the tally, main plus every subagent. */
    tokens?: string | null;
    /**
     * Agents plus workflows, and nothing else: `summarizeLiveStatus`'s
     * `sideCount`, the same field the Morse heartbeat reads (DROVE-185,
     * DROVE-209). There is no second count anywhere and there must not be one.
     */
    workers?: number;
    /** The live cluster opens the agent tree, so it carries a chevron. */
    liveExpands?: boolean;
    /** `1/3 tasks` (DROVE-167). */
    tasks?: string | null;
    /** The account, right-aligned (DROVE-138). */
    account?: string | null;
    /** `8%`, coloured by the quota ramp (DROVE-230, DROVE-231). */
    quotaPercent?: string | null;
    /** With no account to head it the quota keeps the window's name. */
    quotaWindow?: string | null;
    quotaExpands?: boolean;
    /** The context ring, which fills toward the next compaction. */
    contextGauge?: boolean;
    /** The context percent, when the line has room for the text. */
    contextPercent?: string | null;
    /**
     * That percent is the PRECISE reading, put there by a tap on the ring
     * (DROVE-155, DROVE-231, exempted in DROVE-250).
     *
     * The give-way order decides what to drop when nobody has asked. Here
     * somebody has, so the `contextPercent` step does not fire: folding it
     * would make the tap do nothing, which is the one outcome a tap must not
     * have. `84.0k of 200.0k context, compacts near 184.0k` is 44 characters
     * and no phone has a zone that wide, so for as long as it is up the sides
     * give way around it and the floor is not claimed. It is one more tap from
     * being put back, which is what makes that acceptable.
     */
    contextPrecise?: boolean;
}

/** Which zone each fact lives in, so a fold can be asked whether it helps. */
export const statusStripZoneOf: Record<StatusRowGiveWay, StatusStripZone> = {
    contextPercent: 'centre',
    quotaWindow: 'right',
    toolName: 'left',
    elapsed: 'left',
    tasks: 'left',
    thinkingTokens: 'left',
    account: 'right',
    tokens: 'centre',
};

export type StatusStripZone = 'left' | 'centre' | 'right';

/** Everything the give-way order can take off the strip. `account` truncates. */
export interface StatusStripFolds {
    contextPercent: boolean;
    quotaWindow: boolean;
    toolName: boolean;
    elapsed: boolean;
    tasks: boolean;
    thinkingTokens: boolean;
    tokens: boolean;
}

export const noStatusStripFolds: StatusStripFolds = {
    contextPercent: false,
    quotaWindow: false,
    toolName: false,
    elapsed: false,
    tasks: false,
    thinkingTokens: false,
    tokens: false,
};

/**
 * The content as a comparable SHAPE: what is on the strip, and nothing about
 * how it got there.
 *
 * A fact that was never supplied and a fact a fold has just taken are the same
 * strip, so `undefined` and `null` have to compare equal here. They did not
 * while this was a bare `JSON.stringify` — `{}` against `{"a":null}` — so a
 * fold on an absent fact reported itself as having changed something and was
 * taken. It cost nothing while zone-awareness kept the centre's steps from
 * firing at all; once DROVE-250 let them fire, every crowded row came back
 * claiming it had folded a context percent that was never on it.
 */
function shapeOf(content: StatusStripContent): string {
    return JSON.stringify(
        Object.entries(content)
            .filter(([, value]) => value !== null && value !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
    );
}

/** The content with a set of folds applied; what actually gets drawn. */
export function statusStripDrawn(
    content: StatusStripContent,
    folds: StatusStripFolds,
): StatusStripContent {
    return {
        ...content,
        ...(folds.toolName ? { toolName: null } : null),
        ...(folds.thinkingTokens ? { thinkingTokens: null } : null),
        ...(folds.elapsed ? { elapsed: null } : null),
        ...(folds.tasks ? { tasks: null } : null),
        ...(folds.tokens ? { tokens: null } : null),
        ...(folds.contextPercent ? { contextPercent: null } : null),
        ...(folds.quotaWindow ? { quotaWindow: null } : null),
    };
}

function text(value: string | null | undefined): number {
    return value ? estimateStatusRowTextWidth(value) : 0;
}

function row(name: string, gap: number, children: FlexNode[]): FlexNode {
    return {
        name,
        style: { flexDirection: 'row', alignItems: 'center', gap },
        children,
    };
}

function leaf(name: string, width: number): FlexNode {
    return { name, style: { width, height: statusRowMetrics.fontSize } };
}

/**
 * The LIVE cluster: which tool is running, what it is costing, and how much is
 * out.
 *
 * The label slot holds a TOOL's name or nothing (DROVE-250). No state word has
 * survived here: `working` went in DROVE-231 and `thinking` went in DROVE-250,
 * both because the dot beside them already blinks blue and the line is too
 * tight to say it twice.
 */
function liveCluster(content: StatusStripContent): FlexNode | null {
    const m = statusStripMetrics;
    const children: FlexNode[] = [];
    if (content.toolName) children.push(leaf('toolName', text(content.toolName)));
    if (content.elapsed) children.push(leaf('elapsed', text(content.elapsed)));
    // LAST OF THE THREE, because that is the shape Clay already reads
    // (DROVE-244). Claude Code's own status line prints
    // `✳ Actualizing… (20s · ↓ 424 tokens)` — a verb, the clock, then the
    // tokens — and the strip's tool state is already `Bash 2m 58s`, name then
    // clock. Putting the count third agrees with both instead of inventing a
    // third ordering for the same three facts. It never appears beside a tool
    // name; the caller only supplies it in the thinking state.
    if (content.thinkingTokens) children.push(leaf('thinkingTokens', text(content.thinkingTokens)));
    if (content.workers && content.workers > 0) {
        children.push(leaf('workersGlyph', m.workersGlyph));
        children.push(leaf('workersCount', text(String(content.workers))));
    }
    if (children.length === 0) return null;
    if (content.liveExpands) children.push(leaf('liveChevron', m.chevron));
    return row('live', m.gap, children);
}

function tasksCluster(content: StatusStripContent): FlexNode | null {
    const m = statusStripMetrics;
    if (!content.tasks) return null;
    return row('tasks', m.gap, [
        leaf('tasksText', text(content.tasks)),
        leaf('tasksChevron', m.chevron),
    ]);
}

function centreCluster(content: StatusStripContent): FlexNode | null {
    const m = statusStripMetrics;
    const children: FlexNode[] = [];
    if (content.tokens) children.push(leaf('tokens', text(content.tokens)));
    if (content.contextPercent) children.push(leaf('contextPercent', text(content.contextPercent)));
    if (content.contextGauge) children.push(leaf('contextGauge', m.gauge));
    if (children.length === 0) return null;
    return row('centre', m.gap, children);
}

/**
 * The quota's number as drawn.
 *
 * With an account heading it, the bare percent: `jamrizzi 8%` is one fact
 * about one account and the sheet behind the tap spells the window out
 * (DROVE-138). With no account there is nothing to head it, so the window
 * keeps its name, and THAT is what the `quotaWindow` fold takes, leaving the
 * percent behind. Folding it must never leave the segment empty; a percent
 * with no name is still a percent, a name with no percent is not a quota.
 */
export function statusStripQuotaText(content: StatusStripContent): string | null {
    if (content.account) return content.quotaPercent ?? null;
    return content.quotaWindow ?? content.quotaPercent ?? null;
}

/**
 * The right zone, with the account already held to its cap (DROVE-250).
 *
 * The cap is a `maxWidth` in the renderer, so the model has to carry it too or
 * it measures a name that is never drawn at that width and reports a zone
 * overflowing when the screen shows it fitting. That disagreement is what let
 * the geometry claim a collision the folds could do nothing about: the account
 * is the one thing here that truncates rather than dropping, so a zone width
 * that ignores the truncation can never come back under budget.
 */
function rightCluster(content: StatusStripContent, screenWidth: number): FlexNode | null {
    const m = statusStripMetrics;
    const children: FlexNode[] = [];
    if (content.account) {
        const cap = statusStripAccountCap(content, screenWidth);
        children.push(leaf('account', Math.min(text(content.account), cap ?? Infinity)));
    }
    const quota = statusStripQuotaText(content);
    if (quota) children.push(leaf('quota', text(quota)));
    if (children.length === 0) return null;
    if (content.quotaExpands) children.push(leaf('quotaChevron', m.chevron));
    return row('quota', m.gap, children);
}

/**
 * The style tree for the strip, ready to resolve.
 *
 * `left` and `right` are `flex: 1` so they split whatever the centre leaves,
 * which is what puts the centre on the true middle. Each holds a spacer on its
 * INNER side, so the left zone's content sits against the left inset and the
 * right zone's against the right one. Nothing is positioned; every edge here
 * comes out of the flex pass.
 */
export function statusStripNode(content: StatusStripContent, screenWidth: number): FlexNode {
    const m = statusStripMetrics;
    const left: FlexNode[] = [];
    if (content.dot) left.push(leaf('dot', m.dot));
    const live = liveCluster(content);
    const tasks = tasksCluster(content);
    const clusters = [live, tasks].filter((node): node is FlexNode => node !== null);
    if (clusters.length > 0) {
        left.push(row('leftClusters', m.clusterGap, clusters));
    }
    const centre = centreCluster(content);
    const right = rightCluster(content, screenWidth);
    return {
        name: 'strip',
        style: {
            flexDirection: 'row',
            alignItems: 'center',
            width: statusRowUsableWidth(screenWidth),
        },
        children: [
            {
                name: 'leftZone',
                style: { flexDirection: 'row', alignItems: 'center', flex: 1 },
                children: [
                    row('leftContent', m.dotGap, left),
                    { name: 'leftSpacer', style: { flex: 1 } },
                ],
            },
            ...(centre ? [centre] : []),
            {
                name: 'rightZone',
                style: { flexDirection: 'row', alignItems: 'center', flex: 1 },
                children: [
                    { name: 'rightSpacer', style: { flex: 1 } },
                    ...(right ? [right] : []),
                ],
            },
        ],
    };
}

/**
 * What the line gives each side, and what each side may actually SPEND
 * (DROVE-250).
 *
 * `share` is the geometry: half of what the centre leaves, which is where the
 * flex pass puts the boundary. `budget` is the share less the clear space the
 * zone owes on its inner edge, and it is what the give-way order spends. The
 * two were the same number until DROVE-250, which is why a zone could be
 * exactly its share, pass the fit test, and touch the zone beside it.
 *
 * Measured off the CENTRE alone, never off the whole strip, so the account's
 * cap can be derived from it without the strip having to resolve a tree that
 * the cap is an input to.
 */
function zoneBudget(content: StatusStripContent, screenWidth: number): {
    usable: number;
    centre: number;
    share: number;
    gap: number;
    budget: number;
} {
    const m = statusStripMetrics;
    const usable = statusRowUsableWidth(screenWidth);
    const centreNode = centreCluster(content);
    const centre = centreNode ? measureFlexWidth(centreNode, usable) : 0;
    const share = (usable - centre) / 2;
    // ONE BOUNDARY COSTS `zoneGap`. With a centre on the line there are two of
    // them and the centre pays for neither, because the centre does not shrink
    // — it is its content, on the middle — so each side owes a whole gap. With
    // no centre the two sides face each other across a single boundary and
    // split it.
    const gap = centre > 0 ? m.zoneGap : m.zoneGap / 2;
    return { usable, centre, share, gap, budget: share - gap };
}

/** The natural width of each zone's content, before anything is given away. */
export function statusStripZoneWidths(content: StatusStripContent, screenWidth: number): {
    left: number;
    centre: number;
    right: number;
    /** What each SIDE zone may take: half of what the centre leaves. */
    share: number;
    /** The clear space a side zone owes on its inner edge (DROVE-250). */
    gap: number;
    /** `share` less that gap: what the give-way order actually spends. */
    budget: number;
    usable: number;
} {
    const frame = resolveFlexFrames(statusStripNode(content, screenWidth), statusRowUsableWidth(screenWidth));
    const leftContent = findFrame(frame, 'leftContent');
    const right = findFrame(frame, 'quota');
    const { usable, centre, share, gap, budget } = zoneBudget(content, screenWidth);
    return {
        left: leftContent ? leftContent.width : 0,
        centre,
        right: right ? right.width : 0,
        share,
        gap,
        budget,
        usable,
    };
}

/**
 * WHICH FOLDS THIS STRIP NEEDS, taken in `STATUS_ROW_GIVE_WAY`'s order.
 *
 * ZONE-AWARE, which the old row's loop had no reason to be. A SIDE zone's step
 * only fires while that zone is over: folding the account cannot make the left
 * zone fit, and taking it anyway would cut a name to relieve a pressure it is
 * nowhere near. That is how the order survives the three-zone layout intact
 * rather than being re-derived per zone.
 *
 * A CENTRE step is the exception, and it is not a loophole (DROVE-250). Each
 * side's share is half of what the centre leaves, so 6pt off the centre hands
 * 3pt to each side: a centre fold relieves every zone on the line, not only
 * its own. The old test asked whether the CENTRE was over, and the centre is
 * never over — `formatTokens` bounds it at six characters (DROVE-241) — so the
 * one step that can widen a starved side was the one step that could never
 * fire. It is still last on the order, so it only ever runs when everything
 * cheaper has already gone.
 *
 * IT RUNS UNTIL THE GAP IS SATISFIED, not until the zones merely fit
 * (DROVE-250). `budget` is the share less the 16pt floor, and that is what
 * each side is measured against. Stopping at the share is what let the tally
 * and the account meet on Clay's line with the order still holding folds in
 * reserve.
 *
 * `account` is on the order but is not a step here. It truncates at the tail
 * rather than dropping, which is a flex weight and a measured `maxWidth` in
 * the renderer (`statusRowShrink.account`, `statusStripAccountCap`), and it
 * stays the first thing on the strip to give way as TEXT.
 */
export function statusStripFolds(
    content: StatusStripContent,
    screenWidth: number,
    order: readonly StatusRowGiveWay[],
): StatusStripFolds {
    const folds: StatusStripFolds = { ...noStatusStripFolds };
    const fits = () => {
        const widths = statusStripZoneWidths(statusStripDrawn(content, folds), screenWidth);
        return {
            left: widths.left <= widths.budget,
            right: widths.right <= widths.budget,
            centre: widths.centre <= widths.usable,
        };
    };
    let state = fits();
    if (state.left && state.right && state.centre) return folds;
    for (const what of order) {
        if (what === 'account') continue;
        // A reveal the reader asked for is not the layout's to take back.
        if (what === 'contextPercent' && content.contextPrecise) continue;
        const zone = statusStripZoneOf[what];
        // A centre step is worth taking whatever is over, because the centre
        // funds both sides. A side step is worth taking only for its own zone.
        if (zone !== 'centre' && state[zone]) continue;
        const key = what as keyof StatusStripFolds;
        if (folds[key]) continue;
        const next = { ...folds, [key]: true };
        const drawn = statusStripDrawn(content, next);
        // A fold that changes nothing is not taken: it would report a fact as
        // dropped when it was never on the strip.
        if (shapeOf(drawn) === shapeOf(statusStripDrawn(content, folds))) continue;
        folds[key] = true;
        state = fits();
        if (state.left && state.right && state.centre) return folds;
    }
    return folds;
}

/** The strip as it is actually laid out: folds applied, frames resolved. */
export function resolveStatusStrip(
    content: StatusStripContent,
    screenWidth: number,
    order: readonly StatusRowGiveWay[],
): { folds: StatusStripFolds; drawn: StatusStripContent; frame: FlexFrame } {
    const folds = statusStripFolds(content, screenWidth, order);
    const drawn = statusStripDrawn(content, folds);
    return {
        folds,
        drawn,
        frame: resolveFlexFrames(
            statusStripNode(drawn, screenWidth),
            statusRowUsableWidth(screenWidth),
        ),
    };
}

/**
 * The most the ACCOUNT may take before it truncates, in points.
 *
 * What the right zone's BUDGET leaves once the percentage and the chevron have
 * theirs. A number rather than a fraction, for DROVE-223's reason: `45%` of
 * the whole row was a cap no layout function could see, and it cut the most
 * important word on the line while a third of the row sat empty.
 *
 * The budget and not the share (DROVE-250). A cap that spends the whole share
 * is a cap that lets the name end exactly where the tally begins, which is the
 * photograph. Spending the budget instead leaves the 16pt floor standing, and
 * the account is the right thing to take it out of: DROVE-223 ranks it above
 * the tally and the clock, it is the longest term on the line, and the sheet
 * one tap behind it names the account in full.
 *
 * It cuts at the TAIL, so an email keeps its head: `jam@codejam.ninja` becomes
 * `jam@code…` and not `…jam.ninja`. The local part and the `@` are what say
 * which account this is; the domain is the same on every account Clay owns.
 */
export function statusStripAccountCap(content: StatusStripContent, screenWidth: number): number | null {
    if (!content.account) return null;
    const m = statusStripMetrics;
    const { budget } = zoneBudget(content, screenWidth);
    const quota = statusStripQuotaText(content);
    const others = text(quota) + (quota ? m.gap : 0)
        + (content.quotaExpands ? m.chevron + m.gap : 0);
    return Math.max(0, budget - others);
}
