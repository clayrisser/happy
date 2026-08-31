/**
 * What fits on the one status line under the composer, and what folds when it
 * does not (DROVE-138).
 *
 * Clay, about the strip: "shouldn't it show the active account as well, and
 * where it says online that should just be a little dot", and about the model:
 * "keep the full model name and slide it down there, that way it's more
 * compact and fits."
 *
 * That is two things ADDED to the busiest row in the app, so the arithmetic
 * has to be written down rather than eyeballed. The row already carries the
 * live state (DROVE-82, DROVE-155), the quota (DROVE-47) and the context gauge,
 * and DROVE-144 took its bottom inset down to 16pt, so there is no second line
 * to spill onto and no margin to borrow.
 *
 * THREE FOLDS PAY FOR THE TWO ADDITIONS. Nothing is truncated to make room,
 * because a truncated row is a row that lies about what it says:
 *
 *   1. The word `online` goes. The dot's COLOUR already is the connection
 *      (DROVE-82: working blue, online green, gone grey, waiting orange), so
 *      the word repeated what the dot said and cost the width the account
 *      needed. The dot keeps the state in its accessibility label.
 *   2. The word `week` goes, but only when an account heads that segment.
 *      `jamrizzi 23%` is one fact about one account; the sheet behind the tap
 *      spells the window out. With no account to head it the segment is still
 *      `23% week`, because a bare percent there would be nameless.
 *   3. The context gauge's PERCENT TEXT goes whenever the account is on the
 *      row. The grey ring beside it already fills with the same number, and a
 *      tap still prints the exact tokens. This is the same fold DROVE-155 makes
 *      while the main thread works, arrived at from the other direction.
 *
 * WHAT SHRINKS, AND IN WHAT ORDER. Below the width these folds hold, the row
 * gives way in one place at a time, longest tail first: the account, then the
 * model, then the live segment's tool name. The quota number and the gauge
 * never shrink, because a truncated number is useless while a truncated
 * account name is still recognisable.
 *
 * ONE NUMBER FOR THE LANE NEXT DOOR. DROVE-155's main-thread readout costs
 * 62pt more than the segment it replaces, which is more than the slack these
 * folds leave at 375. Its own fold covers that, but the width it fires at has
 * to be 375 rather than the 360 it was measured at before the model and the
 * account were here. statusRowLayout.spec.ts pins it, so the two lanes agree
 * on one number instead of each guessing at a constant.
 *
 * Pure, so the budget can be pinned at 375 and 320 without a renderer.
 * AgentInputStatusRow.tsx draws it.
 */

/**
 * Everything on the row that is not text, in points.
 *
 * The separator is the 4pt middle dot plus its 6pt margins. The chevron is the
 * 10pt glyph plus the 3pt gap before it. The gauge is the 14pt ring plus the
 * 5pt gap. `paddingHorizontal` is the row's own inset, which lines it up with
 * the composer card's controls.
 */
export const statusRowMetrics = {
    fontSize: 11,
    /**
     * A generous average advance for the system font at 11pt. SF Pro Text
     * averages a little under 6 across mixed-case words at this size and
     * Roboto about the same, so a row that fits by this estimate fits on the
     * phone; the estimate only ever errs toward "does not fit".
     */
    glyphWidth: 6,
    paddingHorizontal: 18,
    dot: 7,
    dotMarginRight: 5,
    separator: 16,
    chevron: 13,
    gauge: 19,
    /** The people glyph and the gap before the agent count (DROVE-155). */
    agentsGlyph: 14,
} as const;

/**
 * The model's name truncates at the TAIL, and only after the account has.
 *
 * DROVE-83 cut it in the middle because it sat between a mode word and an
 * effort word and both ends carried meaning. On this row it is one segment on
 * its own, so the front of the name is the half worth keeping. At 375pt with
 * the whole row drawn it does not truncate at all, which was the point of
 * moving it here.
 */
export const STATUS_ROW_MODEL_TRUNCATION = {
    segment: 'model',
    ellipsizeMode: 'tail',
} as const;

/** Which segment gives way first when the row is over budget. */
export const statusRowShrink = {
    /** Longest tail, still recognisable cut: the first to give. */
    account: 3,
    model: 2,
    /** DROVE-155 already lets the tool name go; the numbers beside it do not. */
    live: 1,
    /** A truncated number says nothing, so these never shrink. */
    quota: 0,
    context: 0,
} as const;

export interface StatusRowParts {
    /** The whole live segment's text as drawn, or null when idle. */
    live?: string | null;
    /** The live segment carries the agents glyph and count (DROVE-155). */
    agentCount?: number;
    /** The live segment opens the agent tree, so it carries a chevron. */
    liveExpands?: boolean;
    /**
     * The connection IN WORDS. Nothing passes this any more (DROVE-138 folded
     * it into the dot), and it stays on the model so the spec can put it back
     * and show what it was costing.
     */
    connection?: string | null;
    /** The model name, spelled in full (DROVE-138). */
    model?: string | null;
    /** The account the session runs on, heading the quota. */
    account?: string | null;
    /** The quota segment's text, already folded by `statusRowQuotaText`. */
    quota?: string | null;
    /** The quota opens the per-account bars, so it carries a chevron. */
    quotaExpands?: boolean;
    /** The context percent, when it is not folded away. */
    context?: string | null;
    /** The grey ring, which is drawn whenever there is a context reading. */
    contextGauge?: boolean;
}

export function estimateStatusRowTextWidth(text: string): number {
    return text.length * statusRowMetrics.glyphWidth;
}

/** The row's inset comes off both ends before anything is drawn. */
export function statusRowUsableWidth(screenWidth: number): number {
    return screenWidth - 2 * statusRowMetrics.paddingHorizontal;
}

/**
 * The quota segment's text.
 *
 * With an account it is that account and its number; without one it keeps the
 * window's name, because a percent with nothing in front of it does not say
 * which percent it is.
 */
export function statusRowQuotaText(
    account: string | null | undefined,
    percent: number | null | undefined,
    weekLabel: string,
): string | null {
    if (percent == null) return null;
    const name = account?.trim();
    return name ? `${name} ${Math.round(percent)}%` : weekLabel;
}

/**
 * Whether the context gauge still prints its percent.
 *
 * Folded once the account is on the row: the ring carries the same number and
 * a tap prints the exact tokens, so the text is the cheapest thing on the row
 * to lose.
 */
export function showsContextPercent(account: string | null | undefined, precise: boolean): boolean {
    if (precise) return true;
    return !account?.trim();
}

export function estimateStatusRowWidth(parts: StatusRowParts): number {
    const m = statusRowMetrics;
    const segments: number[] = [];
    if (parts.live) {
        let live = estimateStatusRowTextWidth(parts.live);
        if (parts.agentCount && parts.agentCount > 0) {
            live += m.agentsGlyph + estimateStatusRowTextWidth(String(parts.agentCount));
        }
        if (parts.liveExpands) live += m.chevron;
        segments.push(live);
    }
    if (parts.connection) segments.push(estimateStatusRowTextWidth(parts.connection));
    if (parts.model) segments.push(estimateStatusRowTextWidth(parts.model));
    if (parts.quota) {
        segments.push(estimateStatusRowTextWidth(parts.quota) + (parts.quotaExpands ? m.chevron : 0));
    }
    if (parts.context || parts.contextGauge) {
        segments.push((parts.context ? estimateStatusRowTextWidth(parts.context) : 0)
            + (parts.contextGauge ? m.gauge : 0));
    }
    if (segments.length === 0) return 0;
    const separators = (segments.length - 1) * m.separator;
    return m.dot + m.dotMarginRight + separators + segments.reduce((total, width) => total + width, 0);
}

/** True when the row draws whole at this width, with nothing cut. */
export function statusRowFits(parts: StatusRowParts, screenWidth: number): boolean {
    return estimateStatusRowWidth(parts) <= statusRowUsableWidth(screenWidth);
}
