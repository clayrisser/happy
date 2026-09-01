/**
 * What the usage strip under the composer shows, decided in one place.
 *
 * Two feeds can fill it. `agentState.usageLimits` is live from the SDK on a
 * remote session. `metadata.droverUsage` (DROVE-47) is the CLI's reading of
 * every drover account's usage cache, and on a pane session it is the ONLY
 * feed there is: a Claude Code TUI in tmux has no rate_limit_event stream, so
 * the strip stayed blank on the phone while `drover accounts` in the terminal
 * knew every number.
 *
 * Pure so the choice between the two, the gate on the week figure and the
 * popup's rows can be pinned by a test without mounting the composer.
 *
 * The sheet's rows are BARS, not sentences (DROVE-107). Each account used to
 * cost three text lines - "bitspur.com · 0% left", then "Fable back Sep 2",
 * and a long name wrapped again - so five accounts filled the screen and the
 * one number Clay scans for was buried in prose. A row is now a name, a track,
 * the number, and the reset time trailing behind it, all on one line. The fill
 * is coloured by how close the window is to its limit, never by which account
 * it is, so 43% and 0% compare down the column at a glance.
 *
 * EVERY BAR FILLS AS USAGE IS CONSUMED, AND NOTHING MAY REVERSE IT (DROVE-230).
 *
 * The bars used to EMPTY as usage was consumed, with one line of small print
 * at the bottom of a scrolling sheet saying so. Clay, who owns this app and
 * specified these bars, read a verified-correct sheet and asked "Oh so 0%
 * means nothing left?" — he could not tell which way his own bars ran. That is
 * not an accuracy bug and no amount of correctness fixes it: a caption cannot
 * repair a backwards affordance, because the affordance is read first and the
 * caption is read never.
 *
 * So the direction is now carried by the MARK. A download fills, a battery
 * drains toward empty, a loading bar fills; a bar that grows means the thing
 * it measures is accumulating, and what accumulates here is usage. `Clay: they
 * should fill up instead so it's consistent.` The bare percentages follow the
 * fill for the same reason — a track filled to 99% beside a figure reading 2%
 * is the identical contradiction one level down — so a row's number is always
 * percent USED.
 *
 * Headroom is still the fact Clay needs to pick an account, and it survives in
 * exactly one place: the account heading, which says `main · 2% left on Week`.
 * That is allowed to count the other way ONLY because it spells the word and
 * names its window, so it cannot be read backwards on its own. Nothing else on
 * this sheet may count down. There is no setting for this: a preference that
 * reverses a mark is a preference that makes the mark unreadable, which is the
 * bug this fixed.
 *
 * The proof it works is `risserproperties`, which under the old convention
 * read `Session 100%` beside `Week 0%` — correct, and nonsense. Filling as
 * used it reads `Session 0%` beside `Week 100%`: a fresh session window on an
 * account whose week is spent, which is exactly what it is.
 *
 * AND A WINDOW UNDER A SPENT ONE SHOWS NOTHING (DROVE-255).
 *
 * Filling as used fixed the direction and left one contradiction standing.
 * Three of Clay's accounts read `0% left on Week` in the heading, with a
 * SESSION row under it at 0% used: a solid track, a green sliver, no reset
 * time. Both figures were correct. The five-hour window really was untouched,
 * and it was also unspendable, because the week over it was gone — so the row
 * carrying the healthy mark was the row that could not be used, drawn exactly
 * like a fresh session on a healthy account.
 *
 * A window is MOOTED when a wider window that also applies to it is exhausted,
 * and a mooted window must not advertise capacity. What "wider" means is
 * `droverWindowCovers` in utils/droverUsage.ts, written down there rather than
 * assumed here, because the longer window does not always win: the Fable week
 * is seven days and moots no account-wide session row, which is the same fact
 * this sheet's own caption states. A mooted row gets the treatment DROVE-204
 * already built for a window with nothing to say — hollow track, a dash, the
 * reason trailing — and the reason names the window that did it.
 *
 * Every account gets all of them (DROVE-148). The current account had Session,
 * Week and Fable week; every other account had one bar for its fullest limit.
 * Clay: "This should be listing all three bars for each account." One number
 * per account cannot answer the question the sheet is opened for, which is
 * where to flip to, because an account can be fine on the week and burnt on
 * the session and one figure hides that. So there is one shape now: a block
 * per account, headed by its name and headroom, over the same measure rows.
 */
import {
    currentDroverAccountRow,
    droverAccountsUsage,
    droverFamilyLabel,
    droverMootingWindow,
    droverRowApplies,
    droverRowUsable,
    droverSnapshotAgeMs,
    droverSnapshotOverdue,
    droverWindowId,
    usageLimitsFromDroverUsage,
    type DroverAccountUsageRow,
    type DroverOtherAccountRow,
    type DroverUsageAccountLike,
    type DroverUsageLike,
} from '@/utils/droverUsage';
import {
    backdoorAccountLabel,
    cursorAccountTrailing,
    cursorAccountUsable,
    isCursorAccount,
} from '@/utils/droverAccounts';
import { harnessName } from '@/utils/harnessName';
import {
    formatUsageLimitResetTime,
    getUsageLimitRows,
    usageLimitZoneLabel,
    type UsageLimitsLike,
} from '@/utils/sessionStatusBar';
import { estimateStatusRowTextWidth, statusRowMetrics } from './statusRowLayout';
import { t } from '@/text';

export type UsageStripInput = {
    /** Plan quota windows from agent state; the remote path's feed. */
    usageLimits: UsageLimitsLike;
    /** Every drover account's headroom from session metadata (DROVE-47). */
    droverUsage: DroverUsageLike;
    /** The older per-account stamp, the fallback when the snapshot marks nothing current. */
    droverAccount?: string | null;
};

/**
 * Colour classes for the fill, by how much headroom is LEFT. Four, not a
 * gradient: the row has to be readable at 6pt tall from across a desk.
 */
export type UsageBarTone = 'ample' | 'low' | 'critical' | 'unknown';

/** One thin row: a name, a track, a number, and the reset time behind it. */
export type UsageBarRow = {
    key: string;
    /** The name as it renders, already cut to the row's name column. */
    name: string;
    /** The whole name, for the accessibility label a cut one would lose. */
    fullName: string;
    /** True when `name` is shorter than `fullName`. */
    nameTruncated: boolean;
    /**
     * How much of the track the fill covers, 0..1: percent USED, always
     * (DROVE-230). No caller and no setting can reverse it.
     */
    fraction: number;
    /** Percent USED, "43%"; null when nothing was measured. */
    percentText: string | null;
    /**
     * The same figure with its direction spelled out, "43% used", for the
     * accessibility label (DROVE-230). A screen reader never sees the fill, so
     * the one carrier of direction the sighted row has does not exist for it
     * and the word has to be said instead. Null when nothing was measured.
     */
    percentSpoken: string | null;
    /**
     * Something WAS measured here, even if it came out at zero (DROVE-230).
     *
     * The distinction the sheet could not draw: under the old convention a
     * window measured at 0% left and a window nobody had measured both drew an
     * empty track, which is why five identical Fable zeroes read as a parse
     * failure. Filling as used moves the exhausted case to a FULL bar, and this
     * flag covers the other end — a window measured at 0% USED keeps a visible
     * sliver of fill, so it cannot be mistaken for the bare track of a row with
     * no reading at all.
     */
    measured: boolean;
    /**
     * The window the account's headroom came from (DROVE-230): the fullest of
     * the windows that bind this session's model, and therefore the one that
     * stops work first. `main · 2% left on Week` sitting over a session row
     * reading 37% used to look like a contradiction, because nothing said the
     * heading was about a different row.
     */
    binding?: boolean;
    /** "Resets 6 PM", "Fable back Sep 4", "no login". Empty when there is none. */
    trailing: string;
    tone: UsageBarTone;
    /** Nothing behind the row to flip to. */
    disabled: boolean;
};

export type UsageBarGroup = {
    key: string;
    /** "jamrizzi · 51% left"; empty when the caller draws bare rows. */
    title: string;
    /** The account the session is on, so one block reads as yours (DROVE-148). */
    active?: boolean;
    /**
     * The bare account name behind the block, which is what a switch sends
     * (DROVE-160). Null on the block that stands for a session the registry
     * does not know, and on the bare rows the info screen draws.
     */
    account?: string | null;
    /**
     * The block can be tapped to move the session onto it: it names a real
     * account, it is not the one already in use, and that account is logged
     * in. An account with no login cannot take the session, so it is refused
     * here rather than by a switch that bounces a minute later on the Mac.
     */
    switchable?: boolean;
    rows: UsageBarRow[];
};

export type UsageStrip = {
    /** The number on the strip, already flipped for the "% left" setting; null hides it. */
    weekPercent: number | null;
    /**
     * The strip percentage's COLOUR band, from `usageBarTone` (DROVE-231).
     *
     * Clay: "Account is right aligned with the percentage and changes color as
     * it fills up." The band is the sheet's own function on the sheet's own
     * window, carried out here rather than recomputed on the strip, so the two
     * surfaces cannot disagree about whether this account is warm. It takes
     * headroom LEFT, like every other caller, so the display direction setting
     * cannot change what colour an account is.
     */
    weekTone: UsageBarTone;
    /** Nothing from the SDK; the snapshot is what the strip is reading. */
    usageFromDrover: boolean;
    /**
     * The sheet: one block per account, the current one first, each with the
     * same Session, Week and family-week rows under its own headroom.
     */
    usageBarGroups: UsageBarGroup[];
    /**
     * One caption under the bars, and it is no longer LOAD-BEARING
     * (DROVE-230).
     *
     * It used to open with `Bars show left`, which is where the only statement
     * of the sheet's direction lived: small, secondary, at the bottom of
     * something you scroll. The mark carries the direction now, so the caption
     * carries only what a mark cannot — the timezone every time on this sheet
     * is in (the phone's, where /usage prints the Mac's, and the same instant
     * read 7:49 AM here and 1:49pm there), how old the reading is, and which
     * measured window the headroom figures leave out. Nothing here is needed
     * to read a bar.
     */
    usageBarFooter: string;
    /**
     * When the snapshot behind these bars was taken (DROVE-230); null when
     * there is no snapshot. Handed to the component rather than worded here,
     * because how OLD a reading is changes while nothing else on this object
     * does — see usageBarFooterText.
     */
    usageBarCapturedAt: number | null;
};

/**
 * "Times in CDT · Fable week not counted for Opus" (DROVE-230), which the
 * component prefixes with the age of the reading.
 *
 * Two facts, and neither is how to read a bar. The direction clause is gone:
 * it was the whole caption's reason to exist and the reason the sheet was
 * unreadable, since a rule stated once in small print at the bottom of a
 * scroll is a rule nobody has read.
 *
 * The AGE is deliberately NOT composed here. It is the one part of the line
 * that changes while nothing else does, and a string built in a memo keyed on
 * the snapshot would still read "Read just now" an hour after the sweep
 * stopped — a lie on the exact axis this ticket is about. The component holds
 * a clock and prepends it (`usageSnapshotAgeText`, same function).
 *
 * `headroom for Opus` is gone with it. The only model-scoped window the API
 * returns is Fable's — `seven_day_opus` and `seven_day_sonnet` both come back
 * null — so a caption promising a number FOR Opus promised something the data
 * does not contain. What is true is the opposite and is now what it says: an
 * Opus session's headroom skips Fable's week, and the window it skipped is
 * named because that window is the one that was actually measured.
 */
export function usageBarFooterText(input: {
    /** The model the session is running; null when the snapshot never said. */
    modelFamily?: string | null;
    /** Family windows that exist in the data and do NOT bind this session. */
    skipped?: string[];
}): string {
    const parts: string[] = [];
    const zone = usageLimitZoneLabel();
    if (zone) parts.push(t('agentInput.usagePopup.zoneNote', { zone }));
    const skipped = input.skipped ?? [];
    if (skipped.length > 0 && input.modelFamily) {
        parts.push(t('agentInput.usagePopup.familyNotCounted', {
            windows: skipped.join(', '),
            family: input.modelFamily.charAt(0).toUpperCase() + input.modelFamily.slice(1),
        }));
    }
    return parts.join(' \u00b7 ');
}

/**
 * "just now", "3m ago", "2h ago", and the word for a reading the sweep should
 * have refreshed and has not (DROVE-230).
 *
 * Clay: "When are you going to fix these to make them accurate?" They were
 * accurate. `main` read 66/99/100 used against a sheet showing 37/2/0 left,
 * and every point of that gap was the reading aging while nothing on the sheet
 * admitted a reading has an age at all. The CLI sweeps every ten minutes with
 * a five-minute floor, so minutes-old is the NORMAL case and has to be legible
 * rather than hidden.
 */
export function usageSnapshotAgeText(capturedAt: number | null | undefined, now: number): string {
    const ms = droverSnapshotAgeMs(capturedAt, now);
    if (ms == null) return '';
    const minutes = Math.floor(ms / 60_000);
    const age = minutes < 1
        ? t('agentInput.usagePopup.ageJustNow')
        : minutes < 60
            ? t('agentInput.usagePopup.ageMinutes', { minutes })
            : minutes < 60 * 24
                ? t('agentInput.usagePopup.ageHours', { hours: Math.floor(minutes / 60) })
                : t('agentInput.usagePopup.ageDays', { days: Math.floor(minutes / (60 * 24)) });
    return droverSnapshotOverdue(ms)
        ? t('agentInput.usagePopup.capturedOverdue', { age })
        : t('agentInput.usagePopup.captured', { age });
}

/**
 * The family windows in this snapshot that do NOT bind the session's model, in
 * the popup's own words ("Fable week").
 *
 * This is the honest half of what the caption used to claim. `headroom` is
 * computed over the windows that apply (`droverRowApplies`), so on an Opus
 * session Fable's exhausted week is measured, present on the sheet, and
 * deliberately not counted — and until now nothing said so.
 */
export function usageSkippedFamilyWindows(usage: DroverUsageLike): string[] {
    const family = usage?.modelFamily ?? null;
    if (!usage || !family || !Array.isArray(usage.accounts)) return [];
    const out: string[] = [];
    for (const account of usage.accounts) {
        for (const row of Array.isArray(account?.limits) ? account.limits : []) {
            if (!row || droverRowApplies(row, family)) continue;
            const label = droverFamilyLabel(row);
            if (!label) continue;
            const worded = t('agentInput.usagePopup.familyWeek', { family: label });
            if (!out.includes(worded)) out.push(worded);
        }
    }
    return out;
}

/** How wide the name column is, in characters, before a name is cut. */
export const usageBarNameLimit = 14;

/**
 * The four columns, in points (DROVE-117).
 *
 * DROVE-107 sized these to fit a 393pt phone with every field present, but let
 * the absent ones COLLAPSE: a row with no reset time gave its trailing slot to
 * the track, so `jamrizzi` drew a visibly longer bar than `bitspur.com` at a
 * similar headroom, and a row with no figure left a hole in the number column.
 * A bar whose length encodes how much trailing text the row happens to carry
 * is not comparable with the bar above it, which was the whole point of using
 * bars. So every column holds its width whether or not it has content: the
 * percent renders a dash, the trailing slot renders empty, and the track is a
 * fixed width computed from the container rather than whatever is left over.
 */
export const usageBarColumns = {
    /** Inset on each side of the row, matching the status line above it. */
    horizontalPadding: 16,
    name: 80,
    /** Between each pair of columns; four of them on a row. */
    gap: 8,
    percent: 34,
    trailing: 88,
    /**
     * The dot marking the BINDING row (DROVE-230), and the slot it always
     * keeps so the names line up whether or not a row has one. Same width as
     * the heading's current-account dot and set left of the name for the same
     * reason, so a block reads as one column of marks rather than two.
     */
    mark: 5,
    /** The track never shrinks past this, however narrow the container is. */
    minTrack: 40,
} as const;

/** Everything on a row that is not the track: paddings, four columns, four gaps. */
export const usageBarFixedWidth =
    usageBarColumns.horizontalPadding * 2
    + usageBarColumns.mark
    + usageBarColumns.name
    + usageBarColumns.percent
    + usageBarColumns.trailing
    + usageBarColumns.gap * 4;

/**
 * How wide the track is inside a container of this width. One number for the
 * whole popup, so every track starts and ends at the same x no matter which
 * fields its row happens to have.
 */
export function usageBarTrackWidth(containerWidth: number): number {
    if (!Number.isFinite(containerWidth)) return usageBarColumns.minTrack;
    return Math.max(usageBarColumns.minTrack, Math.round(containerWidth - usageBarFixedWidth));
}

/**
 * The trailing column's font size, and whether a label fits in it (DROVE-248).
 *
 * The column is a fixed 88pt at every screen width, so this is one question
 * and not three: at 320, 375 and 393 the track absorbs the difference and the
 * trailing slot does not move. Widening it is therefore not free. At 320 the
 * track is already down to 49pt against a 40pt floor, which is why the reset
 * label got shorter instead.
 *
 * The estimate is the status row's measured advance, scaled from its 11pt to
 * this column's 10pt. Same font (`Typography.default`, IBM Plex Sans), and it
 * is read off `statusRowMetrics` rather than written down again so the two
 * cannot disagree about how wide a character is.
 */
export const usageBarTrailingFontSize = 10;

export function usageBarTrailingWidth(text: string): number {
    return estimateStatusRowTextWidth(text) * (usageBarTrailingFontSize / statusRowMetrics.fontSize);
}

export function usageBarTrailingFits(text: string): boolean {
    return usageBarTrailingWidth(text) <= usageBarColumns.trailing;
}

/** What the number column shows when nothing was measured: a dash, never a gap. */
export const usageBarMissingPercent = '\u2013';

/** The number column's text, so the missing case cannot render as empty. */
export function usageBarPercentLabel(percentText: string | null | undefined): string {
    return percentText ? percentText : usageBarMissingPercent;
}

/**
 * Percent left to a track fraction. ONE direction, no parameter: the track
 * fills as usage is consumed (DROVE-230).
 *
 * The single function every bar in the product runs through, phone and wrist
 * alike — `collectAccountRows` sends the wrist the number this returns rather
 * than letting Swift do its own arithmetic, so the two surfaces cannot end up
 * running opposite ways (DROVE-129's rule, applied to a direction instead of a
 * figure). It takes percent LEFT because that is what the CLI's `headroom` is
 * and what the callers hold; it returns the fill, which is the other one.
 *
 * Nothing measured reads as an empty track rather than a full one: a row with
 * no figure must not look healthy. The row's `measured` flag is what tells
 * that empty apart from a window genuinely at 0% used.
 */
export function usageBarFraction(percentLeft: number | null | undefined): number {
    if (typeof percentLeft !== 'number' || !Number.isFinite(percentLeft)) return 0;
    const left = Math.min(100, Math.max(0, percentLeft));
    return (100 - left) / 100;
}

/**
 * The fill colour, by headroom left and nothing else. Deliberately not per
 * account: the point of the column is that two accounts at the same percent
 * look the same.
 *
 * Reading it off what is LEFT means the colour WARMS as the bar fills, which
 * is the convention a filling bar already carries everywhere else (a disk, a
 * battery charging into its last tenth) and a second carrier for the one fact
 * the sheet exists to show: an exhausted window is a full red bar and needs no
 * number read (DROVE-230). No new hue was spent on this. The three bands are
 * the theme's existing success / amber / warningCritical, which the bars have
 * always used; DROVE-215's white-unless-active rule governs the composer's
 * control GLYPHS, and DROVE-176's palette is that row's vocabulary, neither of
 * which a data mark is drawn from.
 */
export function usageBarTone(percentLeft: number | null | undefined): UsageBarTone {
    if (typeof percentLeft !== 'number' || !Number.isFinite(percentLeft)) return 'unknown';
    const left = Math.min(100, Math.max(0, percentLeft));
    if (left < 10) return 'critical';
    if (left < 35) return 'low';
    return 'ample';
}

/**
 * Cut a name to the column. `risserproperties` is wider than the column and
 * used to wrap the whole row onto a third line; it now ends in an ellipsis and
 * the full name stays on the row for VoiceOver.
 */
export function truncateUsageName(name: string, limit = usageBarNameLimit): { name: string; truncated: boolean } {
    if (name.length <= limit) return { name, truncated: false };
    return { name: `${name.slice(0, Math.max(1, limit - 1))}\u2026`, truncated: true };
}

/**
 * ONE window's headroom, turned into everything a mark needs to show it
 * (DROVE-230).
 *
 * The single derivation. Every quota mark in the product is drawn from what
 * this returns and none of them does the arithmetic itself: the sheet's bars
 * (`usageBarRowFrom`), the composer strip's account figure
 * (`resolveUsageStrip`, worn by DROVE-231) and the wrist's rows
 * (`collectAccountRows` -> `DroverAccountRow.used`, worn by DROVE-228) all
 * call it. That is DROVE-129's rule applied to a DIRECTION: the reason the
 * bars could run backwards for a release is that each surface converted
 * headroom into a mark on its own, so there was no one place a direction could
 * be stated. Now there is, and reversing it is one edit that moves all three.
 *
 * It takes percent LEFT because that is what the CLI's `headroom` is and what
 * every caller holds. It returns the fill, which is the other one.
 */
export type UsageFill = {
    /**
     * Something WAS measured, even if it came out at zero. False is the bare
     * track: nothing was ever read, or what was read describes a window that
     * has since reset.
     */
    measured: boolean;
    /** Percent USED, 0-100, rounded; null when nothing was measured. */
    percentUsed: number | null;
    /** How much of the track the fill covers, 0..1. Zero when unmeasured. */
    fraction: number;
    /** The bare figure for a column, "43%"; null when nothing was measured. */
    percentText: string | null;
    /** The same figure with its direction said, "43% used", for a screen reader. */
    percentSpoken: string | null;
    tone: UsageBarTone;
};

export function usageFill(percentLeft: number | null | undefined): UsageFill {
    const measured = typeof percentLeft === 'number' && Number.isFinite(percentLeft);
    const percentUsed = measured
        ? Math.round(100 - Math.min(100, Math.max(0, percentLeft as number)))
        : null;
    return {
        measured,
        percentUsed,
        fraction: usageBarFraction(percentLeft),
        percentText: percentUsed == null ? null : `${percentUsed}%`,
        percentSpoken: percentUsed == null
            ? null
            : t('agentInput.usagePopup.used', { percent: percentUsed }),
        tone: usageBarTone(percentLeft),
    };
}

export function usageBarRowFrom(input: {
    key: string;
    name: string;
    percentLeft: number | null;
    trailing: string;
    disabled?: boolean;
    /** The window the account's headroom was read off (DROVE-230). */
    binding?: boolean;
}): UsageBarRow {
    const cut = truncateUsageName(input.name);
    // The number is DERIVED from the same figure the fill is, rather than
    // passed in beside it (DROVE-230). A caller that could hand in a percent
    // of its own is a caller that could hand in "2%" over a bar filled to 98%,
    // which is the contradiction this ticket exists to remove.
    const fill = usageFill(input.percentLeft);
    return {
        key: input.key,
        name: cut.name,
        fullName: input.name,
        nameTruncated: cut.truncated,
        fraction: fill.fraction,
        percentText: fill.percentText,
        percentSpoken: fill.percentSpoken,
        measured: fill.measured,
        trailing: input.trailing,
        tone: fill.tone,
        disabled: input.disabled === true,
        ...(input.binding ? { binding: true } : {}),
    };
}

/**
 * "jamrizzi · 51% left on Session", or just the name when nothing was measured.
 *
 * The composer popup's heading and the session info screen's account line
 * (DROVE-137) are the same sentence and have to stay that way, so it is built
 * once here rather than spelled out on both screens (DROVE-129).
 *
 * The ONE figure on this sheet that counts DOWN (DROVE-230), and it earns the
 * exception twice over. It says `left` out loud, so it cannot be read as the
 * bars are read; and headroom, not usage, is the fact that answers the
 * question the sheet is opened for, which is which account to move onto.
 *
 * It also NAMES its window, which is the other half of the same bug. The
 * heading is the BINDING window — the fullest of the ones that bind this
 * session's model, the one that stops work first — so `main · 2% left` sat
 * over a session row reading 37% and read as a contradiction. `main · 2% left
 * on Week` is the same two numbers with the arithmetic removed.
 */
export function droverAccountHeadroomLabel(
    account: { name: string; headroom?: number | null } | null | undefined,
    /** The binding window's own word, "Week"; null when none could be picked. */
    bindingLabel?: string | null,
): string {
    const name = account?.name;
    if (!name) return '';
    const headroom = account?.headroom;
    if (typeof headroom !== 'number' || !Number.isFinite(headroom)) return name;
    const percent = Math.round(headroom);
    return `${name} · ${bindingLabel
        ? t('agentInput.usagePopup.leftOn', { percent, window: bindingLabel })
        : t('agentInput.usagePopup.left', { percent })}`;
}

/**
 * One drover account as a bar row.
 *
 * Split out of resolveUsageStrip for DROVE-137: the session info screen draws
 * the CURRENT account with the same row the composer popup draws the others
 * with, rather than a third variant of a bar. Same rules either way. An
 * account that is out says when it is back, one with no figure says why, and a
 * logged-out one is dimmed rather than hidden.
 */
/** "Back 6 PM" / "Fable back Sep 4"; empty when the account is not cooling. */
export function usageAccountBackLabel(a: Pick<DroverOtherAccountRow, 'back' | 'family'>): string {
    if (a.back == null) return '';
    return a.family
        ? t('agentInput.usagePopup.familyBack', { family: a.family, time: formatUsageLimitResetTime(a.back) })
        : t('agentInput.usagePopup.back', { time: formatUsageLimitResetTime(a.back) });
}

export function usageAccountBarRow(a: DroverOtherAccountRow): UsageBarRow {
    // An account that is out says WHEN it is back; that is the fact worth the
    // trailing slot. With no figure at all the trailing text is the reason
    // there is none, so the bare track is explained.
    const back = usageAccountBackLabel(a);
    // A CURSOR ROW ANSWERS NONE OF THE QUESTIONS BELOW (DROVE-270), so it is
    // taken out first rather than threaded through them. It has no headroom to
    // read, no window to expire and no cooldown to come back from — and every
    // way its credential goes wrong wants a different sentence from Claude's
    // "no login": an expired token is a login that HAPPENED, and a tombstone is
    // a deliberate sign-out. The mark is the same hollow track with a dash that
    // an unmeasured Claude row draws, because that mark is honest here too; it
    // is the words that differ.
    if (isCursorAccount(a)) {
        return usageBarRowFrom({
            key: `account:${a.name}`,
            name: a.name,
            percentLeft: null,
            trailing: cursorRowTrailing(a),
            // `renew` is NOT disabled. The token works today and simply has a
            // deadline; greying it out for the last week of sixty days would
            // hide a working account.
            disabled: !cursorAccountUsable(a),
        });
    }
    if (!a.loggedIn) {
        return usageBarRowFrom({
            key: `account:${a.name}`,
            name: a.name,
            percentLeft: null,
            trailing: t('agentInput.usagePopup.noLogin'),
            disabled: true,
        });
    }
    if (a.headroom == null) {
        // Both nothings land here and both come out UNMEASURED, which is the
        // point (DROVE-230). Filling as used, a window nobody read and a
        // window read at 0% used would otherwise draw the identical empty
        // track, and the second one is a FRESH window — the most misleading
        // thing this sheet could say. `measured: false` is what keeps them
        // apart in the mark; the trailing word says which nothing it is.
        //
        // A cursor row is a THIRD nothing and the only permanent one, and it
        // never reaches here: it is answered above, because "not measured"
        // would read as "not measured YET" over a figure that is never coming
        // (DROVE-270).
        return usageBarRowFrom({
            key: `account:${a.name}`,
            name: a.name,
            percentLeft: null,
            trailing: back
                || (a.expired
                    ? t('agentInput.usagePopup.windowReset')
                    : t('agentInput.usagePopup.unmeasured')),
        });
    }
    return usageBarRowFrom({
        key: `account:${a.name}`,
        name: a.name,
        percentLeft: a.headroom,
        trailing: back,
    });
}

/** One quota window, named once and drawn on every account's block. */
export type UsageMeasure = { id: string; label: string };

/**
 * The rows every block carries, in one order (DROVE-148).
 *
 * Session and Week always, then one row per model family any account scopes a
 * limit to. Computed across ALL accounts rather than per account on purpose:
 * the blocks are there to be compared down the sheet, so `main` has to draw a
 * Fable week row even with nothing in it, or its Week row would sit level with
 * someone else's Fable week and the column would lie.
 */
export function usageMeasures(accounts: DroverAccountUsageRow[]): UsageMeasure[] {
    const measures: UsageMeasure[] = [
        { id: 'five_hour', label: t('agentInput.usagePopup.session') },
        { id: 'seven_day', label: t('agentInput.usagePopup.week') },
    ];
    const seen = new Set(measures.map((m) => m.id));
    for (const account of accounts) {
        for (const window of account.windows) {
            if (!window.family || seen.has(window.id)) continue;
            seen.add(window.id);
            measures.push({ id: window.id, label: t('agentInput.usagePopup.familyWeek', { family: window.family }) });
        }
    }
    return measures;
}

/**
 * A cursor row SAYS it is one, on this sheet (DROVE-338). The Accounts screen
 * groups rows under "machine · Cursor", but here every account is one flat
 * list, and a Claude account and a cursor account may share an address — the
 * night it bit, a bare "clayrisser@gmail.com · no quota published" beside a
 * Claude row was read as a broken Claude login. The harness name is the same
 * one the session header uses.
 */
export function cursorRowTrailing(a: DroverOtherAccountRow): string {
    return `${harnessName('cursor')} · ${cursorAccountTrailing(a)}`;
}

/** "jamrizzi · 51% left on Week", or the reason there is no figure. */
export function usageAccountGroupTitle(a: DroverOtherAccountRow, bindingLabel?: string | null): string {
    if (!a.name) return '';
    // A cursor account before every Claude question, including "no login"
    // (DROVE-270). It is none of the nothings below: nobody failed to measure
    // it, no reading expired, and it publishes no quota at all. When its
    // sixty-day token is inside the last week the heading says THAT instead —
    // the deadline is the only thing on this row Clay can act on, and it cannot
    // be refreshed without him.
    if (isCursorAccount(a)) return `${a.name} · ${cursorRowTrailing(a)}`;
    if (!a.loggedIn) return `${a.name} · ${t('agentInput.usagePopup.noLogin')}`;
    // Two different nothings, and saying the wrong one is the bug (DROVE-204).
    // "not measured" means nobody ever asked. This means somebody asked, and
    // the answer has since expired — the account may be wide open or entirely
    // spent, and the heading must not imply either.
    if (a.headroom == null && a.expired) return `${a.name} · ${t('agentInput.usagePopup.headroomUnknown')}`;
    if (a.headroom == null) return `${a.name} · ${t('agentInput.usagePopup.unmeasured')}`;
    // A headroom whose window has already reset is the same nothing wearing a
    // number (DROVE-230). `droverBindingLimit` refuses to name a window here
    // for the reason DROVE-204 gave: the one nobody re-read is exactly the one
    // that could be full. The heading was still printing the CLI's stamped
    // figure over a row drawn with no bar at all, which is a claim the sheet
    // cannot back. An account with no limit ROWS is untouched by this — there
    // is no expired window there, just a headroom with no windows to name.
    if (a.expired && !bindingLabel) return `${a.name} · ${t('agentInput.usagePopup.headroomUnknown')}`;
    return droverAccountHeadroomLabel(a, bindingLabel);
}

/**
 * One account as a block: its name and headroom over the same measure rows
 * every other block gets (DROVE-148).
 *
 * `override` is the SDK's live windows, which only the current account has and
 * which beat the snapshot's reading of it. A measure the account has no figure
 * for still draws its row, with the dash the current account already used, so
 * the blocks stay the same height and line up.
 */
export function usageAccountBarGroup(
    account: DroverAccountUsageRow,
    measures: UsageMeasure[],
    options?: {
        /**
         * The window this account's `headroom` was read off (DROVE-230), from
         * `droverBindingLimit` over the same rows the CLI computed it from.
         * Marks its row and names itself in the heading, so `main · 2% left on
         * Week` over a session row reading 37% stops looking like a
         * contradiction. Null when no window binds, which is also when the
         * heading has no figure to explain.
         */
        binding?: DroverBindingLimit | null;
        /** The SDK's live windows for the current account. */
        override?: UsageLimitsLike;
    },
): UsageBarGroup {
    const binding = options?.binding ?? null;
    const override = options?.override;
    const byId = new Map<string, { utilization: number | null; resetsAt: number | null; usable: boolean }>();
    for (const window of account.windows) {
        byId.set(window.id, { utilization: window.utilization, resetsAt: window.resetsAt, usable: window.usable });
    }
    // The SDK stream is live by definition, so its windows are always usable.
    for (const row of getUsageLimitRows(override ?? null)) {
        byId.set(row.id, { utilization: row.utilization, resetsAt: row.resetsAt, usable: true });
    }
    // What each window is CALLED on this sheet, so a row that is blocked can
    // name the window that blocked it (DROVE-255). A mooting window this
    // cannot name is not used: the whole value of the reason is that it says
    // WHICH window did it, and "spent" on its own says less than the reset
    // time it would replace.
    const label = new Map(measures.map((measure) => [measure.id, measure.label]));
    // Every window this account has a reading for, whether or not it is drawn.
    // The mooting rule is asked over the account's own windows and nobody
    // else's: a week spent on `main` says nothing about `jamrizzi`.
    const windows = [...byId.entries()].map(([id, window]) => ({
        id,
        utilization: window.utilization,
        usable: window.usable,
    }));
    const rows = measures.map((measure) => {
        const window = byId.get(measure.id);
        // A window that had already reset when this was captured keeps its row
        // and loses its figures (DROVE-204). DROVE-173's `stale` label was the
        // right instinct and not enough: a bar and a percentage next to the
        // word `stale` still reads as data. The trailing text is the reason
        // there is nothing to read.
        // An expired window loses its figures and therefore its fill
        // (DROVE-204). Under fill-as-used that matters more than it did: a
        // window whose reading describes something that no longer exists must
        // NOT draw as 0% used, because 0% used is what a brand new window
        // looks like and the two are opposite facts. `percentLeft: null` makes
        // the row unmeasured, which is a bare track rather than an empty fill.
        const expired = window != null && !window.usable;
        // MOOTED: a wider window that also applies to this one is exhausted,
        // so this one cannot be spent however much is left in it (DROVE-255).
        // Clay: "When week has expired show session expired so it's more
        // obvious." The session rows on his three dead accounts read 0% used
        // with a green sliver, which under fill-as-used is the picture of a
        // fresh window, sitting directly under a heading saying `0% left on
        // Week`. Both facts were true and together they lied.
        //
        // It gets DROVE-204's treatment rather than a new one, because it is
        // the same claim: this row's number describes capacity that is not
        // there to be had. Hollow track, a dash, and the reason in the
        // trailing slot. The reason NAMES the window that did it, which is
        // also what the heading names, so the two now agree.
        //
        // The session's own reset time is what the trailing slot gives up for
        // it. That is the right trade: when the week is gone, the hour the
        // five-hour window turns over changes nothing, and the reset that does
        // matter is printed on the Week row two lines down.
        const mooted = window == null || expired
            ? null
            : droverMootingWindow(
                { id: measure.id, utilization: window.utilization, usable: window.usable },
                windows,
            );
        const mootedBy = mooted ? label.get(mooted.id) ?? null : null;
        const utilization = expired || mootedBy != null ? null : window?.utilization ?? null;
        return usageBarRowFrom({
            key: `${account.name}:${measure.id}`,
            name: measure.label,
            percentLeft: utilization == null ? null : 100 - utilization,
            trailing: expired
                ? t('agentInput.usagePopup.windowReset')
                : mootedBy != null
                    ? t('agentInput.usagePopup.mooted', { window: mootedBy })
                    : window?.resetsAt != null
                        ? t('agentInput.usagePopup.resets', { time: formatUsageLimitResetTime(window.resetsAt) })
                        : '',
            disabled: !account.loggedIn,
            // Marked, never re-ranked here: the heading's number and this flag
            // have to come off one decision or they can point at two rows.
            binding: binding != null && binding.id === measure.id,
        });
    });
    // The cooling time is normally the reset on one of the rows above, so it
    // is not repeated. When the account has no windows at all it is the only
    // thing there is to say, and it goes on the title rather than nowhere.
    const back = rows.some((row) => row.trailing) ? '' : usageAccountBackLabel(account);
    const base = usageAccountGroupTitle(account, binding?.label ?? null);
    // A reading nobody has refreshed says so rather than passing as current
    // (DROVE-173). The five-hour session window means a snapshot one window
    // old prints LAST window's reset time, which is what read as a wrong
    // clock next to /usage.
    const title = account.stale && base ? `${base} · ${t('agentInput.usagePopup.stale')}` : base;
    const headline = back && title ? `${title} · ${back}` : title;
    // THE BACK DOOR, LAST ON THE HEADING (DROVE-333).
    //
    // This sheet is where the `Switch ›` lives, so it is the sheet where Clay
    // decides where a session goes — and until now it was the one account
    // surface that could NOT say which row the machine leaves alone. Settings ›
    // Accounts said it from `MachineAccount`; the payload here is session
    // metadata and carried neither `ambient` nor `login`, so the CLI stamps
    // `backdoor` on the snapshot instead and this reads it.
    //
    // Last, after the headroom, the staleness and the back-at time, because
    // those are what the bars underneath are about; this says what a TAP would
    // mean. Same words as the Settings row, from the same constant.
    //
    // The block stays switchable. Manual is not a downgrade here, it is the
    // whole design: the machine will not go through this door, and Clay always
    // can.
    return {
        key: account.name ? `account:${account.name}` : 'usage',
        title: headline && account.backdoor ? `${headline} · ${backdoorAccountLabel}` : headline,
        active: account.current,
        account: account.name || null,
        // The sheet is the screen where the choice is made, so it is the
        // screen the move happens from (DROVE-160).
        // `onboarded === false` blocks a switch exactly as `loggedIn === false`
        // does (DROVE-246): a config dir that has never been through Claude
        // Code's first run opens on the theme picker, so tapping it moves the
        // session nowhere and leaves a pane nobody can answer. Absent means
        // fine, so an older machine behaves as it did before.
        //
        // A CURSOR ACCOUNT IS NOT SWITCHABLE, ever (DROVE-270). A flip is a
        // CLAUDE_CONFIG_DIR swap and a respawn, and a cursor account has no
        // directory to swap to — it carries a token, which is exactly why two
        // cursor accounts run side by side and need no flip at all. Offering
        // one here would send `/flip <cursor account>` to a CLI that would
        // rightly refuse it, after Clay had already watched his session stop.
        switchable:
            !!account.name &&
            !account.current &&
            !isCursorAccount(account) &&
            account.loggedIn !== false &&
            account.onboarded !== false,
        rows,
    };
}

/**
 * The one limit that is actually stopping you, for a surface with room for one
 * (DROVE-131).
 *
 * The phone's popup shows Session, Week and every family week side by side and
 * lets Clay rank them himself. A wrist has room for one figure, so the ranking
 * has to be DECIDED rather than shown, and it is decided here so the wrist and
 * the phone cannot disagree about which limit is the problem (DROVE-129).
 *
 * Most binding is the window with the most USED among the windows that APPLY
 * to the session's model, which is the same set `headroom` is computed from:
 * the CLI writes `100 - max(percent)` over exactly those rows (happy-cli
 * src/drover/flip/usage.ts `headroomOf`), so `percentLeft` here and the
 * `headroom` on the same account are two readings of one number and can never
 * drift apart. The label is the popup's own word for the window, so a wrist
 * saying "Fable week" and a phone row saying "Fable week" mean the same row.
 *
 * Model awareness is DROVE-173: Fable's exhausted week is not what is stopping
 * an Opus session, and the wrist naming it made the whole account look dead.
 */
export type DroverBindingLimit = {
    /** `five_hour`, `seven_day`, `seven_day_fable` — the strip's own ids. */
    id: string;
    /** "Session", "Week", "Fable week". */
    label: string;
    /** Percent LEFT on it, 0-100. */
    percentLeft: number;
    /** Epoch ms it resets; null when the cache never said. */
    resetsAt: number | null;
    tone: UsageBarTone;
};

export function droverBindingLimit(
    account: DroverUsageAccountLike | null | undefined,
    modelFamily?: string | null,
    capturedAt = Number.NaN,
): DroverBindingLimit | null {
    const limits = Array.isArray(account?.limits) ? account.limits : [];
    let worst: (typeof limits)[number] | null = null;
    for (const row of limits) {
        if (!row || typeof row.percent !== 'number' || !Number.isFinite(row.percent)) continue;
        if (!droverRowApplies(row, modelFamily)) continue;
        // One expired window and there IS no binding limit (DROVE-204). The
        // wrist shows a single figure, so it cannot qualify one; and the
        // window nobody has measured is exactly the one that could be full.
        // Same rule the CLI's headroomOf takes, because this number and that
        // one are two readings of the same rows and must never disagree
        // (DROVE-129).
        if (!droverRowUsable(row, capturedAt)) return null;
        // Strictly greater, so a tie keeps the FIRST row: the cache lists
        // session before week before the family windows, and the shorter
        // window is the one that bites first at equal utilisation.
        if (!worst || row.percent > worst.percent) worst = row;
    }
    if (!worst) return null;
    const percentLeft = Math.round(Math.min(100, Math.max(0, 100 - worst.percent)));
    const family = worst.scope || worst.family ? droverFamilyLabel(worst) : null;
    // A kind neither the popup nor this knows is printed as itself rather than
    // called "Week". `headroom` is computed over every row including the
    // provider-internal ones, so one of those really can be the binding limit,
    // and the wrist naming the wrong window is worse than an ugly word.
    const label = family
        ? t('agentInput.usagePopup.familyWeek', { family })
        : worst.kind === 'session'
            ? t('agentInput.usagePopup.session')
            : worst.kind === 'weekly_all'
                ? t('agentInput.usagePopup.week')
                : worst.kind;
    return {
        id: droverWindowId(worst),
        label,
        percentLeft,
        resetsAt: typeof worst.resetsAt === 'number' && Number.isFinite(worst.resetsAt) ? worst.resetsAt : null,
        tone: usageBarTone(percentLeft),
    };
}

/**
 * WHICH ACCOUNT TO MOVE TO, BEST FIRST (DROVE-248).
 *
 * Clay: "Always sort these by most recommended to least where the first one is
 * the active one." The order after the current account used to be the order
 * `drover accounts` prints, which is the registry's and answers nothing: in
 * the sheet he photographed the second row was `main` at 0% left and the best
 * account he had was fifth. The sheet exists to answer one question and the
 * order was working against it.
 *
 * MOST RECOMMENDED IS HEADROOM ON THE BINDING WINDOW, and the same headroom
 * the block's own heading prints. Not a score, on purpose. Every block shows
 * its percentage, so an order that IS that percentage is one a reader can
 * check at a glance and therefore trust; an order computed from something the
 * sheet does not show is one he has to take on faith. That is the DROVE-230
 * mistake in a different coat, a mark whose meaning lived only in the code.
 *
 * The reset time was considered as a WEIGHT and is used only as a TIE-BREAK.
 * The argument for weighting is real: 10% that comes back in an hour is worth
 * more than 20% that comes back on Saturday. Three things beat it. The weight
 * depends on `now`, so the order would drift while the sheet sits open with
 * no figure on it changing. It ranks two visible percentages in an order
 * neither percentage explains. And it decides on ONE window for an account
 * that is showing three, when the reset it would weight by is already printed
 * on the row for anyone who wants it. So at equal headroom the account whose
 * binding window comes back sooner goes above, which is the insight applied
 * where it cannot mislead.
 *
 * Tiers come first and headroom only sorts within one, because "can this
 * account take my session at all" outranks how much is left in it.
 */
export const usageAccountTier = {
    /** The account the session is on. Always first, never re-ranked. */
    current: 0,
    /** Logged in, not cooling, and a measured headroom above zero. */
    open: 1,
    /**
     * Logged in and usable, with no figure the heading will print. A guess
     * that could be a full account, so it sits under every account KNOWN to
     * have room and over every one known to have none.
     */
    unknown: 2,
    /** Measured at zero, or cooling with the whole account out. */
    spent: 3,
    /** No login. It cannot take the session, so nothing else about it ranks. */
    noLogin: 4,
} as const;

export type UsageAccountRank = {
    tier: number;
    /** Percent left on the binding window; -1 when the heading prints none. */
    headroom: number;
    /** When this account is worth looking at again; null when nothing says. */
    revives: number | null;
    /** Registry position, the last tie-break, so `drover accounts` still decides. */
    index: number;
};

/**
 * The headroom the block's HEADING will print, or null when it prints a reason
 * instead.
 *
 * Read off the same three refusals `usageAccountGroupTitle` makes, rather than
 * off `headroom` directly. An account whose windows had already reset when the
 * snapshot was taken carries a stamped figure the heading deliberately will
 * not show (DROVE-204), and ranking it by a number the sheet refuses to print
 * is the one way this order could stop being checkable.
 */
function rankedHeadroom(
    account: DroverAccountUsageRow,
    binding: DroverBindingLimit | null,
): number | null {
    if (!account.loggedIn) return null;
    if (account.headroom == null) return null;
    if (account.expired && !binding) return null;
    return account.headroom;
}

export function usageAccountRank(
    account: DroverAccountUsageRow,
    binding: DroverBindingLimit | null,
    index: number,
): UsageAccountRank {
    const headroom = rankedHeadroom(account, binding);
    // Cooling with no family named is the WHOLE account out until that time.
    // A family-scoped cooling is not, and needs no special case: `headroom` is
    // computed over the windows that apply to this session's model, so a
    // family that is out either already reads zero or does not bind at all.
    const out = account.back != null && !account.family;
    const tier = account.current
        ? usageAccountTier.current
        : !account.loggedIn
            ? usageAccountTier.noLogin
            : out
                ? usageAccountTier.spent
                : headroom == null
                    ? usageAccountTier.unknown
                    : headroom <= 0
                        ? usageAccountTier.spent
                        : usageAccountTier.open;
    return {
        tier,
        headroom: headroom ?? -1,
        // For an account with room, when the window it is measured on refills.
        // For a spent one, when it is back, which is the only thing left worth
        // ordering the dead by.
        revives: tier === usageAccountTier.spent
            ? account.back ?? binding?.resetsAt ?? null
            : binding?.resetsAt ?? null,
        index,
    };
}

function compareUsageAccountRank(a: UsageAccountRank, b: UsageAccountRank): number {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === usageAccountTier.open && a.headroom !== b.headroom) return b.headroom - a.headroom;
    if (a.tier === usageAccountTier.open || a.tier === usageAccountTier.spent) {
        // Sooner first; an account that never said goes behind one that did.
        const left = a.revives ?? Number.POSITIVE_INFINITY;
        const right = b.revives ?? Number.POSITIVE_INFINITY;
        if (left !== right) return left - right;
    }
    return a.index - b.index;
}

/**
 * The accounts in the order the sheet lists them.
 *
 * Pure and total: same accounts and same bindings, same order, with the
 * registry index breaking every remaining tie so it is never arbitrary.
 */
export function rankUsageAccounts(
    accounts: DroverAccountUsageRow[],
    bindings: Map<string, DroverBindingLimit | null>,
): DroverAccountUsageRow[] {
    return accounts
        .map((account, index) => ({
            account,
            rank: usageAccountRank(account, bindings.get(account.name) ?? null, index),
        }))
        .sort((a, b) => compareUsageAccountRank(a.rank, b.rank))
        .map((entry) => entry.account);
}

/**
 * THE ORDER IS FROZEN WHILE THE SHEET IS OPEN (DROVE-248).
 *
 * `rankUsageAccounts` is pure and re-ranks on every snapshot, which is right
 * for deciding the order and wrong for keeping it. A block on this sheet is a
 * Pressable that MOVES THE SESSION onto that account (DROVE-160), and
 * `UsageReporter` sweeps every ten minutes. Re-sorting under a travelling
 * thumb would land the tap on a different account than the one aimed at, which
 * is not a cosmetic jump but a switch he did not ask for.
 *
 * So the sheet captures the key order when it opens and re-applies it to every
 * later reading. The figures stay live: bars, percentages, headings and the
 * freshness caption all keep moving, and only the ORDER is pinned. Closing and
 * reopening re-ranks. An account the sweep adds while the sheet is open is not
 * in the held order, so it lands at the tail rather than jumping into place.
 */
export function holdUsageGroupOrder(groups: UsageBarGroup[], held: string[]): UsageBarGroup[] {
    if (held.length === 0) return groups;
    const order = new Map(held.map((key, index) => [key, index]));
    const at = (group: UsageBarGroup) => order.get(group.key) ?? Number.MAX_SAFE_INTEGER;
    return [...groups].sort((a, b) => at(a) - at(b));
}

/**
 * The later of the two readings this account has, or nothing (DROVE-340).
 *
 * There are two objects carrying an account's windows and they are not the
 * same reading. `agentState.usageLimits` is written when the SDK emits a
 * `rate_limit_event` and then left alone — `mergeUsageLimits` even carries the
 * previous utilization forward when an event brings none — so between events
 * it only gets older. `metadata.droverUsage` is a snapshot the CLI re-takes on
 * its own cadence, thirty seconds on the account a session is running.
 *
 * Both stamp `capturedAt`, so the comparison needs no new wire field. The SDK
 * reading wins only when it is strictly newer; a tie goes to the snapshot,
 * because that is the object every other surface already reads and reading one
 * object is the point.
 *
 * Returning null rather than the snapshot keeps this a pure "is the override
 * worth using" question, and leaves each caller to fall back the way it
 * already did.
 */
export function fresherUsageLimits(
    usageLimits: UsageLimitsLike,
    droverUsage: DroverUsageLike,
): UsageLimitsLike {
    if (!usageLimits) return null;
    const snapshotAt = droverUsage?.capturedAt;
    if (typeof snapshotAt !== 'number' || !Number.isFinite(snapshotAt)) return usageLimits;
    const streamAt = usageLimits.capturedAt;
    if (typeof streamAt !== 'number' || !Number.isFinite(streamAt)) return null;
    return streamAt > snapshotAt ? usageLimits : null;
}

export function resolveUsageStrip(input: UsageStripInput): UsageStrip {
    // Whichever of the two readings for THIS account was taken later
    // (DROVE-340). Agent state used to win outright, on the grounds that it is
    // live from the SDK; it is live only in the sense that it arrived on a
    // stream, and nothing updates it between events. Under drover every
    // session is a local TUI, where `rate_limit_event` never fires at all, so
    // agent state is whatever was last seen — sometimes nothing, sometimes an
    // hour old — while the snapshot is re-read every thirty seconds. That
    // precedence is why the sheet's bars sat minutes behind the wrist, which
    // reads the snapshot and only the snapshot.
    const droverLimits = usageLimitsFromDroverUsage(input.droverUsage, input.droverAccount);
    const live = fresherUsageLimits(input.usageLimits, input.droverUsage);
    const usageLimits = live ?? droverLimits;
    const usageFromDrover = !live && !!droverLimits;
    // Only Session and Week are user-meaningful; provider-internal windows
    // (nimbus_quill and friends) stay out of the popup.
    const rows = getUsageLimitRows(usageLimits ?? null);
    const week = rows.find((row) => row.id === 'seven_day') ?? null;
    // A week reading is shown because there IS one (DROVE-194). It used to be
    // withheld unless the context gauge was already on the row, on the theory
    // that the quota was a companion to it; a drover-fed session was exempt,
    // which is why the pane sessions kept theirs and nobody noticed.
    //
    // What made that gate fatal is what the row lost since. The account is
    // drawn INSIDE this segment (DROVE-138), the word `online` went to the dot
    // in the same change, and DROVE-178 took the model back off. So on a remote
    // session, whose windows come from `agentState.usageLimits` rather than the
    // snapshot, withholding the week figure withheld the account with it and
    // left the whole strip empty but for a 7pt dot. Clay: "why isn't it showing
    // my accounts and limits at the bottom like it used to."
    //
    // The context gauge has its own rule (`getContextStatus`, near-limit or the
    // always-show setting) and it is not this one.
    // Percent USED, always, like every mark on the sheet below it
    // (DROVE-230). Run through `usageFill` rather than inverted here, so the
    // strip's figure and the sheet's bars cannot end up on opposite
    // conventions again; DROVE-231 owns how the strip words it.
    const weekPercent = week?.utilization != null
        ? usageFill(100 - week.utilization).percentUsed
        : null;
    // The strip's colour, from the sheet's own ramp on the same window
    // (DROVE-231). `usageBarTone` takes headroom left, so the utilization is
    // turned back into headroom here rather than the ramp growing a direction.
    const weekTone = week?.utilization != null
        ? usageBarTone(100 - week.utilization)
        : usageBarTone(null);

    // Every account, current first, each its own block (DROVE-148). Before
    // this the current account got three rows and the rest got one bar apiece,
    // which is the wrong answer to "where do I flip to": one number cannot say
    // that an account is fine on the week and burnt on the session.
    const accounts = droverAccountsUsage(input.droverUsage, input.droverAccount);
    const sdkRows = getUsageLimitRows(input.usageLimits ?? null);
    // A session on an account the registry does not know still has the SDK's
    // own windows, and they still earn a block; it just has no headroom to
    // head it with.
    if (!accounts.some((a) => a.current) && sdkRows.length > 0) {
        const stamped = currentDroverAccountRow(null, input.droverAccount);
        accounts.unshift({
            name: stamped?.name ?? '',
            // SDK usage windows are Claude Code's, so this block is a Claude
            // one by construction: a cursor session has no such stream — and a
            // Claude login carries no token and no expiry.
            harness: 'claude',
            tokenState: null,
            expiresInDays: null,
            loggedIn: true,
            // The session is running here, so it demonstrably can (DROVE-246).
            onboarded: true,
            // The registry does not know this account, so it cannot be the
            // ambient row or a twin of it — and there is no snapshot to have
            // been stamped either way (DROVE-333).
            backdoor: false,
            headroom: null,
            back: null,
            family: null,
            current: true,
            windows: [],
        });
    }
    const measures = usageMeasures(accounts);
    // Which window each account's `headroom` came off, decided ONCE per
    // account and handed to the block (DROVE-230). Ranked over the snapshot's
    // raw rows rather than the mapped windows, because that is the set the CLI
    // computed `headroom` from — a heading whose number and whose named window
    // came from different sets would be the bug it is meant to fix.
    const bindings = new Map<string, DroverBindingLimit | null>();
    const capturedAt = input.droverUsage?.capturedAt ?? Number.NaN;
    for (const raw of input.droverUsage?.accounts ?? []) {
        if (!raw || typeof raw.name !== 'string' || !raw.name) continue;
        bindings.set(raw.name, droverBindingLimit(raw, input.droverUsage?.modelFamily ?? null, capturedAt));
    }
    // No heading over the LIST (DROVE-117). Clay: "Don't say other accounts.
    // Have each one listed." Each block is headed by its own account, which is
    // the name he is choosing between; a label over the whole list told nobody
    // anything.
    //
    // Ranked here rather than in `droverAccountsUsage` (DROVE-248), because
    // the ranking needs the binding window and that is decided in this
    // function. `droverAccountsUsage` still hands over the registry's order,
    // which is what breaks the last tie.
    const groups = rankUsageAccounts(accounts, bindings).map((account) => usageAccountBarGroup(account, measures, {
        binding: bindings.get(account.name) ?? null,
        // The SDK stream belongs to the session's own account, and overrides
        // the snapshot ONLY while it is the later of the two (DROVE-340). The
        // snapshot is the only reading there is for every other account, and
        // under drover it is the only fresh one for this account too — which
        // is what puts these bars, the heading above them, the info screen and
        // the wrist on one object.
        override: account.current ? live : null,
    }));
    return {
        weekPercent,
        weekTone,
        usageFromDrover,
        usageBarGroups: groups,
        usageBarCapturedAt: input.droverUsage?.capturedAt ?? null,
        usageBarFooter: usageBarFooterText({
            modelFamily: input.droverUsage?.modelFamily ?? null,
            skipped: usageSkippedFamilyWindows(input.droverUsage),
        }),
    };
}
