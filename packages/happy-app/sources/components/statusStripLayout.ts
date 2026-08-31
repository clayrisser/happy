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
 * Pure. Nothing renders; AgentInputStatusRow.tsx draws what this resolves.
 */
import { findFrame, resolveFlexFrames, type FlexFrame, type FlexNode } from './flexFrames';
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
} as const;

/** What the strip has to say, before anything folds. */
export interface StatusStripContent {
    /** The dot is drawn. It is the only thing on the strip that never folds. */
    dot?: boolean;
    /**
     * The tool the main thread is blocked on. NEVER the working word: the dot
     * says the session is working now, so the word is not drawn at all
     * (DROVE-231) and the caller passes null for it.
     */
    toolName?: string | null;
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
}

/** Which zone each fact lives in, so a fold can be asked whether it helps. */
export const statusStripZoneOf: Record<StatusRowGiveWay, StatusStripZone> = {
    contextPercent: 'centre',
    quotaWindow: 'right',
    toolName: 'left',
    elapsed: 'left',
    tasks: 'left',
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
    tokens: boolean;
}

export const noStatusStripFolds: StatusStripFolds = {
    contextPercent: false,
    quotaWindow: false,
    toolName: false,
    elapsed: false,
    tasks: false,
    tokens: false,
};

/** The content with a set of folds applied; what actually gets drawn. */
export function statusStripDrawn(
    content: StatusStripContent,
    folds: StatusStripFolds,
): StatusStripContent {
    return {
        ...content,
        ...(folds.toolName ? { toolName: null } : null),
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
 * The LIVE cluster: what the main thread is doing and how much is out.
 *
 * The working word is not here and cannot be. Clay: "Don't show text working."
 * The dot beside it blinks blue instead, which is the whole point of
 * DROVE-231's dot table, so the label slot only ever holds a TOOL's name.
 */
function liveCluster(content: StatusStripContent): FlexNode | null {
    const m = statusStripMetrics;
    const children: FlexNode[] = [];
    if (content.toolName) children.push(leaf('toolName', text(content.toolName)));
    if (content.elapsed) children.push(leaf('elapsed', text(content.elapsed)));
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

function rightCluster(content: StatusStripContent): FlexNode | null {
    const m = statusStripMetrics;
    const children: FlexNode[] = [];
    if (content.account) children.push(leaf('account', text(content.account)));
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
    const right = rightCluster(content);
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

/** The natural width of each zone's content, before anything is given away. */
export function statusStripZoneWidths(content: StatusStripContent, screenWidth: number): {
    left: number;
    centre: number;
    right: number;
    /** What each SIDE zone may take: half of what the centre leaves. */
    share: number;
    usable: number;
} {
    const frame = resolveFlexFrames(statusStripNode(content, screenWidth), statusRowUsableWidth(screenWidth));
    const usable = statusRowUsableWidth(screenWidth);
    const leftContent = findFrame(frame, 'leftContent');
    const centre = findFrame(frame, 'centre');
    const right = findFrame(frame, 'quota');
    const centreWidth = centre ? centre.width : 0;
    return {
        left: leftContent ? leftContent.width : 0,
        centre: centreWidth,
        right: right ? right.width : 0,
        share: (usable - centreWidth) / 2,
        usable,
    };
}

/**
 * WHICH FOLDS THIS STRIP NEEDS, taken in `STATUS_ROW_GIVE_WAY`'s order.
 *
 * ZONE-AWARE, which the old row's loop had no reason to be. A step only fires
 * if the zone it lives in is over its share: folding the account cannot make
 * the left zone fit, and taking it anyway would cut a name to relieve a
 * pressure it is nowhere near. That is how the order survives the three-zone
 * layout intact rather than being re-derived per zone.
 *
 * `account` is on the order but is not a step here. It truncates at the tail
 * rather than dropping, which is a flex weight in the renderer
 * (`statusRowShrink.account`), and it stays the first thing on the strip to
 * give way as TEXT.
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
            left: widths.left <= widths.share,
            right: widths.right <= widths.share,
            centre: widths.centre <= widths.usable,
        };
    };
    let state = fits();
    if (state.left && state.right && state.centre) return folds;
    for (const what of order) {
        if (what === 'account') continue;
        const zone = statusStripZoneOf[what];
        if (state[zone]) continue;
        const key = what as keyof StatusStripFolds;
        if (folds[key]) continue;
        const next = { ...folds, [key]: true };
        const drawn = statusStripDrawn(content, next);
        // A fold that changes nothing is not taken: it would report a fact as
        // dropped when it was never on the strip.
        if (JSON.stringify(drawn) === JSON.stringify(statusStripDrawn(content, folds))) continue;
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
 * What the right zone's share leaves once the percentage and the chevron have
 * theirs. A number rather than a fraction, for DROVE-223's reason: `45%` of
 * the whole row was a cap no layout function could see, and it cut the most
 * important word on the line while a third of the row sat empty.
 */
export function statusStripAccountCap(content: StatusStripContent, screenWidth: number): number | null {
    if (!content.account) return null;
    const m = statusStripMetrics;
    const widths = statusStripZoneWidths(content, screenWidth);
    const quota = statusStripQuotaText(content);
    const others = text(quota) + (quota ? m.gap : 0)
        + (content.quotaExpands ? m.chevron + m.gap : 0);
    return Math.max(0, widths.share - others);
}
