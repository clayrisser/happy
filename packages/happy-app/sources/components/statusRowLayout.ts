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
 * AND DROVE-223 FOUND THE BUDGET SHORT BY 16pt, AND A SECOND BUDGET NOBODY
 * HAD WRITTEN DOWN. Clay photographed `● wor… 4m 20s 51.6k ⛄6 ˄ · main 8% ˄`:
 * the WORKING WORD cut, on a row with 176pt of empty line to the right of it.
 * Two things were wrong and neither was the strip being too narrow.
 *
 *   1. `statusRowUsableWidth` took only the row's own 19pt inset off the
 *      screen. AgentInput's container carries 8pt more a side, and the strip
 *      is inside it, so the row really has `screenWidth - 54` and the budget
 *      was handing out `screenWidth - 38`. The photograph settles it: the
 *      dot's left edge is 27pt from the screen, which is 8 + 19. Same class of
 *      error as DROVE-206's double-counted card padding, in the other
 *      direction: a term missing rather than a term counted twice.
 *   2. The live segment carried `maxWidth: '45%'` in the renderer, which no
 *      function here knew about. It is a share of the WHOLE row rather than of
 *      what is left on it, so at 393 it clamped the segment to 152pt while
 *      the row had 339 and was using 244. The one child under that cap that
 *      can shrink is the label, and when no tool is running the label IS the
 *      working word. So the most important fact on the line was cut by a cap
 *      measured against a row that was mostly empty.
 *
 * The fix is not a wider strip. It is an ORDER, written down below, and a cap
 * derived from it instead of from a fraction.
 *
 * Pure, so the budget can be pinned at 393, 375 and 320 without a renderer.
 * AgentInputStatusRow.tsx draws it.
 */
import { MOBILE_COMPOSER_LAYOUT, MOBILE_COMPOSER_METRICS } from './agentInputLayout';

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
     * The average advance for the row's font at 11pt.
     *
     * The font is IBM Plex Sans (`Typography.default`), not the system one the
     * note here used to name, and Plex runs a little wider than SF Pro: the
     * row Clay photographed for DROVE-223 estimates at 236pt and MEASURES 244,
     * so the estimate is about 3% lean rather than the generous over-count it
     * claimed to be. It is left at 6 on purpose. The 16pt of phantom width in
     * `statusRowUsableWidth` was the error worth fixing, and with that gone
     * the budget is 8pt conservative overall; moving this to 7 instead would
     * over-count by 8% and start folding facts off rows that fit.
     */
    glyphWidth: 6,
    /**
     * The row's own inset: the composer's GLYPH COLUMN, read off the composer
     * rather than written down again, so the row and this estimate cannot
     * disagree about where the row's edges are (DROVE-153).
     *
     * It reads `textInset` since DROVE-206 rather than reassembling the shell
     * inset and a button's glyph offset. Both spelled 19 while the `+` was a
     * 44pt button, and both still spell 19.
     *
     * DROVE-206 called this "where its ink actually starts" and DROVE-214
     * measured that and found it was not: 19 is where the `+`'s transparent em
     * box started, and its ink starts on the 14pt column now. The strip keeps
     * 19 because it is a column the strip and the zen caret share, and moving
     * it is a change to those two rather than a consequence of redrawing the
     * `+`. It is a chosen column, not a derived one.
     */
    paddingHorizontal: MOBILE_COMPOSER_LAYOUT.textInset,
    /**
     * AgentInput's OWN gutter, outside the row's inset (DROVE-223).
     *
     * The strip is a child of AgentInput's container, which pads 8pt a side on
     * a phone, and every version of this budget before DROVE-223 measured the
     * row against the bare screen instead. That is 16pt the row never had, and
     * it is the width the `45%` cap was spending when it cut the working word.
     * Read off the composer rather than written down again, for the same
     * reason `paddingHorizontal` is.
     */
    outerGutter: MOBILE_COMPOSER_METRICS.shellGutter,
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
 * THE ORDER IN WHICH THE ROW GIVES WAY (DROVE-223).
 *
 * The strip had folds and it had shrink weights, and between them sat a `45%`
 * cap in the renderer that answered to neither. So the row's behaviour under
 * pressure was emergent, and what it happened to drop first was the one word
 * that says what the session is DOING. This list is that behaviour written
 * down, most expendable first:
 *
 *   1. `contextPercent`. The ring beside it fills with the same number, and a
 *      tap prints the exact tokens. The cheapest thing on a full row.
 *   2. `quotaWindow`, the word `week`, once an account heads the quota. The
 *      account says whose number it is; the sheet spells the window out.
 *   3. `toolName`, a TOOL's name. `Bash` is recoverable from the tree behind
 *      the fold, and the clock and the count under it are the fact.
 *   4. `account`, truncated at the tail rather than dropped. A cut name is
 *      still recognisable; the first thing that gives way as TEXT.
 *   5. `tokens`, the live token count. A number, and one tap away.
 *   6. `elapsed`, the turn's clock. The same.
 *   7. `workingWord`. LAST. It is the answer to "what is happening", and
 *      Clay's own reading of it: "the working word goes last... the token
 *      count or the elapsed timer can shorten or drop before it". 5 and 6
 *      moved BELOW 4 and above 7 for exactly that.
 *
 * THE RULE, and the next fact added to this line inherits it: nothing later on
 * this list gives way while anything earlier is still on the row. A new fact
 * takes a place on this list before it takes a place on the line.
 *
 * `model` is not on the list. It left the row in DROVE-178 and the fold is
 * kept only for a caller that still passes one; where it fires it fires with
 * the tool name, which is where DROVE-167 put it.
 */
export const STATUS_ROW_GIVE_WAY = [
    'contextPercent',
    'quotaWindow',
    'toolName',
    'account',
    'tokens',
    'elapsed',
    'workingWord',
] as const;

export type StatusRowGiveWay = (typeof STATUS_ROW_GIVE_WAY)[number];

/** Where a fact sits in the order; lower goes first. */
export function statusRowGiveWayRank(what: StatusRowGiveWay): number {
    return STATUS_ROW_GIVE_WAY.indexOf(what);
}

/**
 * Which segment gives way first when the row is over budget, as flex weights.
 *
 * These are `STATUS_ROW_GIVE_WAY` in the only shape a renderer can act on, so
 * they are DERIVED from it rather than written twice: a bigger number gives
 * more, and the ranks run the other way. `model` is dead on the phone since
 * DROVE-178 and kept for a caller that passes one. The quota number and the
 * context never shrink at all, because a truncated number says nothing while a
 * truncated account name is still recognisable.
 */
export const statusRowShrink = {
    /** Longest tail, still recognisable cut: the first to give. */
    account: 3,
    model: 2,
    /**
     * DROVE-155 lets the tool NAME go and DROVE-223 lets the numbers go after
     * the account, in that order. The working word inside this segment is
     * still the last thing on the row to move, which is why the segment no
     * longer carries a cap of its own while it is the label (`statusRowLiveCap`).
     */
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
     * The live label is the WORKING WORD, not a tool's name (DROVE-223).
     *
     * The two are the same string slot and they give way in opposite orders,
     * so the fold has to be told which one it is looking at. With this set the
     * tool-name fold does not fire at all and `statusRowLiveCap` returns no
     * cap: the working word is last on `STATUS_ROW_GIVE_WAY`, so nothing may
     * clamp the segment carrying it.
     */
    workingWord?: boolean;
    /**
     * The live segment's three pieces, so a fold can rebuild it (DROVE-223).
     *
     * `live` is what is DRAWN and the estimate measures that; these are what
     * it is made of, and the token and clock folds need them because dropping
     * a number out of the middle of a finished string is not something a
     * string can do. A caller that passes only `live` keeps the old behaviour:
     * neither of those two folds can change anything, so neither fires.
     */
    liveLabel?: string | null;
    liveElapsed?: string | null;
    liveTokens?: string | null;
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

/**
 * What the row actually has to draw in.
 *
 * TWO insets come off each end, not one (DROVE-223): AgentInput's own gutter,
 * which the strip sits inside, and then the row's alignment to the composer's
 * glyph column. 8 + 19 = the 27pt from the screen edge to the dot in Clay's
 * photograph. Counting only the second handed the row 16pt it never had, and
 * the `45%` cap was spending that width when it cut the working word.
 */
export function statusRowUsableWidth(screenWidth: number): number {
    const m = statusRowMetrics;
    return screenWidth - 2 * (m.outerGutter + m.paddingHorizontal);
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

/** One drawn segment and what it costs, in the order the row lays them out. */
export interface StatusRowSegment {
    key: 'live' | 'tasks' | 'connection' | 'model' | 'quota' | 'context';
    width: number;
}

/**
 * The row broken into its segments, which is what lets a cap be measured
 * rather than guessed (DROVE-223).
 *
 * `estimateStatusRowWidth` is this plus the dot and the separators between
 * them, so the total and the per-segment share can never disagree about what
 * is on the line.
 */
export function statusRowSegments(parts: StatusRowParts): StatusRowSegment[] {
    const m = statusRowMetrics;
    const segments: StatusRowSegment[] = [];
    if (parts.live) {
        let live = estimateStatusRowTextWidth(parts.live);
        if (parts.agentCount && parts.agentCount > 0) {
            live += m.agentsGlyph + estimateStatusRowTextWidth(String(parts.agentCount));
        }
        if (parts.liveExpands) live += m.chevron;
        segments.push({ key: 'live', width: live });
    }
    if (parts.tasks) segments.push({ key: 'tasks', width: estimateStatusRowTextWidth(parts.tasks) + m.chevron });
    if (parts.connection) segments.push({ key: 'connection', width: estimateStatusRowTextWidth(parts.connection) });
    if (parts.model) segments.push({ key: 'model', width: estimateStatusRowTextWidth(parts.model) });
    if (parts.quota) {
        segments.push({
            key: 'quota',
            width: estimateStatusRowTextWidth(parts.quota) + (parts.quotaExpands ? m.chevron : 0),
        });
    }
    if (parts.context || parts.contextGauge) {
        segments.push({
            key: 'context',
            width: (parts.context ? estimateStatusRowTextWidth(parts.context) : 0)
                + (parts.contextGauge ? m.gauge : 0),
        });
    }
    return segments;
}

/** The dot and the separators: everything on the row that is not a segment. */
export function statusRowChromeWidth(segmentCount: number): number {
    const m = statusRowMetrics;
    if (segmentCount === 0) return 0;
    return m.dot + m.dotMarginRight + (segmentCount - 1) * m.separator;
}

export function estimateStatusRowWidth(parts: StatusRowParts): number {
    const segments = statusRowSegments(parts);
    if (segments.length === 0) return 0;
    return statusRowChromeWidth(segments.length)
        + segments.reduce((total, segment) => total + segment.width, 0);
}

/**
 * The most the LIVE segment may take, in points, or null for no cap at all.
 *
 * It was `maxWidth: '45%'` in the renderer, a share of the whole row that no
 * function here could see. At 393 that is 152pt against a segment that wants
 * 163, so it cut the working word on a row using 244 of its 339 (DROVE-223).
 * A cap has to be what the rest of the line does not need, and this is that:
 * the usable width less the dot, the separators and every other segment.
 *
 * NULL while the label is the working word. That is `STATUS_ROW_GIVE_WAY`
 * read literally: the working word is last, so nothing above it on the row
 * may clamp the segment carrying it. If the line is genuinely too full, the
 * account gives way first, which is what its flex weight already says.
 *
 * The reason the cap exists at all is still met: a 30-character MCP tool name
 * is held to its share and cannot squeeze the account, only now the share is
 * measured off this row rather than assumed to be 45% of every row.
 */
export function statusRowLiveCap(parts: StatusRowParts, screenWidth: number): number | null {
    if (parts.workingWord) return null;
    const segments = statusRowSegments(parts);
    if (!segments.some((segment) => segment.key === 'live')) return null;
    const others = segments
        .filter((segment) => segment.key !== 'live')
        .reduce((total, segment) => total + segment.width, 0);
    const room = statusRowUsableWidth(screenWidth) - statusRowChromeWidth(segments.length) - others;
    return Math.max(0, room);
}

/** True when the row draws whole at this width, with nothing cut. */
export function statusRowFits(parts: StatusRowParts, screenWidth: number): boolean {
    return estimateStatusRowWidth(parts) <= statusRowUsableWidth(screenWidth);
}

export interface StatusRowFolds {
    /**
     * A TOOL's name goes and the numbers beside it stay (DROVE-155).
     *
     * Never the working word (DROVE-223). It is the same string slot, and this
     * fold used to take it out third of everything on the row when the rule
     * says it goes last.
     */
    toolName: boolean;
    /** The model goes whole, because the name alone did not save the row. */
    model: boolean;
    /** The live token count goes, after the account has given what it can. */
    tokens: boolean;
    /** Then the turn's clock. The last thing to go before the working word. */
    elapsed: boolean;
}

/** The live segment as drawn once these folds have fired. */
export function statusRowLiveText(parts: StatusRowParts, folds: StatusRowFolds): string | null {
    const pieces = [parts.liveLabel, parts.liveElapsed, parts.liveTokens];
    if (pieces.every((piece) => piece == null)) {
        // A caller with only the finished string. DROVE-155's own pair still
        // works; the two number folds have nothing to take apart.
        if (folds.toolName && parts.liveWithoutName != null) return parts.liveWithoutName;
        return parts.live ?? null;
    }
    const kept = [
        folds.toolName ? null : parts.liveLabel,
        folds.elapsed ? null : parts.liveElapsed,
        folds.tokens ? null : parts.liveTokens,
    ].filter((piece): piece is string => !!piece);
    return kept.length > 0 ? kept.join(' ') : null;
}

/**
 * Which folds the row needs at this width, in `STATUS_ROW_GIVE_WAY`'s order.
 *
 * Nothing folds on a row that fits, and no fold fires on a part that is not on
 * the row. Over budget the steps are taken one at a time and only as far as
 * the width needs: a tool's name, then the model for a caller that still
 * passes one, then the token count, then the clock. Between the model and the
 * token count sits the ACCOUNT, which truncates rather than folding, so it is
 * a flex weight (`statusRowShrink`) and not a step here.
 *
 * The working word is on none of these steps. If every fold has fired and the
 * row is still over, the row shrinks in `statusRowShrink`'s order instead, and
 * the account is what gives.
 */
export function statusRowFolds(parts: StatusRowParts, screenWidth: number): StatusRowFolds {
    const folds: StatusRowFolds = { toolName: false, model: false, tokens: false, elapsed: false };
    if (statusRowFits(parts, screenWidth)) return folds;

    let row = parts;
    /** Take one step; true once the row fits and there is nothing left to do. */
    const fold = (key: keyof StatusRowFolds, next: StatusRowParts): boolean => {
        row = next;
        folds[key] = true;
        return statusRowFits(row, screenWidth);
    };
    /**
     * A fold is only worth taking when it changes what is drawn, and never
     * when it would leave the segment empty: erasing the live segment is a
     * deletion, not a fold, and the row would then say nothing about the turn
     * at all.
     */
    const withLive = (key: keyof StatusRowFolds): StatusRowParts | null => {
        const live = statusRowLiveText(parts, { ...folds, [key]: true });
        if (live == null || live === row.live) return null;
        return { ...row, live };
    };

    // 3. a TOOL's name, and never the working word.
    if (parts.live && !parts.workingWord) {
        const nameless = withLive('toolName');
        if (nameless && fold('toolName', nameless)) return folds;
    }
    // The model, where DROVE-167 put it: with the name, for a caller that
    // still draws one. Nothing on the phone does.
    if (parts.model && fold('model', { ...row, model: null })) return folds;
    // 5 and 6. The numbers, after the account has taken its share of the cut.
    for (const key of ['tokens', 'elapsed'] as const) {
        const next = withLive(key);
        if (next && fold(key, next)) return folds;
    }
    return folds;
}
