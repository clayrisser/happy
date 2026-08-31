/**
 * What fits on the one status line under the composer, and what folds when it
 * does not (DROVE-138, DROVE-178).
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
 * AND ONE MORE FOLD, WHICH IS DROVE-155's. Its main-thread readout costs 62pt
 * more than the segment it replaced, which is more than the slack the folds
 * above leave at 375, so the tool NAME gives way. That fold used to fire under
 * a 360pt constant; with a model and an account on the row the width it should
 * fire at depends on how long this tool, this model and this account happen to
 * be, so the row asks `statusRowFolds` with its real content instead. A
 * constant could only ever have been right for one row.
 *
 * THE TASKS SEGMENT COUNTS TOO. DROVE-167 put `1/3 tasks ˄` on the row, 83pt
 * with its separator, and the estimate did not know it was there: a working
 * session with a list came out at 353 against 355 usable on a 393pt phone, so
 * the tool name stayed while the row really needed 436, and the account and
 * the model were cut to `jam…` and `Opus…` instead. Two folds pay for it, in
 * this order, and only as far as the width needs:
 *
 *   1. The tool name, DROVE-155's own fold, worth 30pt for `Bash`.
 *   2. The MODEL, whole. With a model still on the row a working session with
 *      a list is 51pt over at 393 even without the name, and the model is the
 *      one segment that can go whole and come back.
 *
 * AND DROVE-178 TOOK THE MODEL OFF THE ROW. It went back to the composer's
 * session capsule, into the gap DROVE-153 opened, so the second fold has
 * nothing left to fire on: `statusRowFolds` returns `model: false` for a row
 * with no model and nothing else moves. Re-measured, the widest realistic row
 * is 366 rather than 436, the working row is 70pt shorter, and a working
 * session with a task list needs only the tool-name fold at 393 and 375. The
 * model branch and `statusRowShrink.model` stay for a caller that passes one;
 * the phone no longer does. The numbers are pinned in the spec.
 *
 * Pure, so the budget can be pinned at 393, 375 and 320 without a renderer.
 * AgentInputStatusRow.tsx draws it.
 */
import { MOBILE_COMPOSER_LAYOUT } from './agentInputLayout';

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
    /**
     * The row's own inset: the composer's GLYPH COLUMN, read off the composer
     * rather than written down again, so the row and this estimate cannot
     * disagree about where the row's edges are (DROVE-153).
     *
     * It reads `textInset` since DROVE-206 rather than reassembling the shell
     * inset and a button's glyph offset. Both spelled 19 while the `+` was a
     * 44pt button; the `+` is a 36pt disc inside the field now and only
     * `textInset` still tracks where its ink actually starts. Same number,
     * and now it stays the same number when the `+` is next redrawn.
     */
    paddingHorizontal: MOBILE_COMPOSER_LAYOUT.textInset,
    dot: 7,
    dotMarginRight: 5,
    separator: 16,
    chevron: 13,
    gauge: 19,
    /** The people glyph and the gap before the agent count (DROVE-155). */
    agentsGlyph: 14,
} as const;

/**
 * How the model's name truncated on this row, while it was on it.
 *
 * DROVE-83 cut it in the middle because it sat between a mode word and an
 * effort word and both ends carried meaning. Here it was one segment on its
 * own, so the front of the name was the half worth keeping. Kept for a caller
 * that still passes a model; the phone's row does not (DROVE-178), and in the
 * capsule the name scales rather than truncating at all.
 */
export const STATUS_ROW_MODEL_TRUNCATION = {
    segment: 'model',
    ellipsizeMode: 'tail',
} as const;

/**
 * Which segment gives way first when the row is over budget. `model` is dead
 * on the phone since DROVE-178 and kept for a caller that passes one.
 */
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
     * The live segment with its tool name folded away, `1m 2s 251.2k` for
     * `Bash 1m 2s 251.2k` (DROVE-155). Only `statusRowFolds` reads it, to
     * ask whether the name alone saves the row.
     */
    liveWithoutName?: string | null;
    /**
     * The task badge, `1/3 tasks` (DROVE-167). Always carries a chevron,
     * because the segment is the way to the list.
     */
    tasks?: string | null;
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
 * Folded while the main thread works, because the live token count beside it
 * is the cost readout at that moment (DROVE-155), and equally once the account
 * is on the row (DROVE-138). Either way the ring carries the same number and a
 * tap prints the exact tokens, so the text is the cheapest thing on a full row
 * to lose.
 */
export function showsContextPercent(
    account: string | null | undefined,
    precise: boolean,
    mainWorking: boolean,
): boolean {
    if (precise) return true;
    if (mainWorking) return false;
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
    if (parts.tasks) segments.push(estimateStatusRowTextWidth(parts.tasks) + m.chevron);
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

export interface StatusRowFolds {
    /** The tool name goes and the numbers beside it stay (DROVE-155). */
    toolName: boolean;
    /** The model goes whole, because the name alone did not save the row. */
    model: boolean;
}

/**
 * Which folds the row needs at this width, in the order they fire.
 *
 * Nothing folds on a row that fits. Over budget, the tool name goes first;
 * if the row is still over with the name gone, the model goes too. Neither
 * fold fires on a part that is not on the row, so a row with no model (the
 * row DROVE-178 leaves) can only ever lose the name. Below the width both
 * folds hold, the row shrinks in `statusRowShrink`'s order instead.
 */
export function statusRowFolds(parts: StatusRowParts, screenWidth: number): StatusRowFolds {
    if (statusRowFits(parts, screenWidth)) return { toolName: false, model: false };
    const canFoldName = !!parts.live && parts.liveWithoutName != null && parts.liveWithoutName !== parts.live;
    const nameless = canFoldName ? { ...parts, live: parts.liveWithoutName } : parts;
    if (statusRowFits(nameless, screenWidth)) return { toolName: true, model: false };
    return { toolName: canFoldName, model: !!parts.model };
}
