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
 * one number Clay scans for was buried in prose. A row is now a name, a track
 * filled to the headroom LEFT, the number, and the reset time trailing behind
 * it, all on one line. The fill is coloured by how much headroom is left, never
 * by which account it is, so 43% and 0% compare down the column at a glance.
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
    usageLimitsFromDroverUsage,
    type DroverAccountUsageRow,
    type DroverOtherAccountRow,
    type DroverUsageLike,
} from '@/utils/droverUsage';
import {
    formatUsageLimitResetTime,
    getUsageLimitDisplayPercentage,
    getUsageLimitRows,
    type UsageLimitsLike,
} from '@/utils/sessionStatusBar';
import { t } from '@/text';

export type UsageStripInput = {
    /** Plan quota windows from agent state; the remote path's feed. */
    usageLimits: UsageLimitsLike;
    /** Every drover account's headroom from session metadata (DROVE-47). */
    droverUsage: DroverUsageLike;
    /** The older per-account stamp, the fallback when the snapshot marks nothing current. */
    droverAccount?: string | null;
    /** The "% left" setting; utilization is always percent USED on the wire. */
    showRemaining: boolean;
    /**
     * The strip's own rule for the week figure: it shows when the context
     * gauge does, or when the user asked for it always. A drover-fed session
     * ignores this, see resolveUsageStrip.
     */
    contextShown: boolean;
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
     * How much of the track the fill covers, 0..1. Always the headroom LEFT,
     * whatever the "% left" setting says, so every row in the popup fills the
     * same direction and the column can be read down.
     */
    fraction: number;
    /** The number the setting asks for, "43%"; null when nothing was measured. */
    percentText: string | null;
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
    rows: UsageBarRow[];
};

export type UsageStrip = {
    /** The number on the strip, already flipped for the "% left" setting; null hides it. */
    weekPercent: number | null;
    /** Nothing from the SDK; the snapshot is what the strip is reading. */
    usageFromDrover: boolean;
    /**
     * The sheet: one block per account, the current one first, each with the
     * same Session, Week and family-week rows under its own headroom.
     */
    usageBarGroups: UsageBarGroup[];
};

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
    /** Between each pair of columns; three of them on a row. */
    gap: 8,
    percent: 34,
    trailing: 88,
    /** The track never shrinks past this, however narrow the container is. */
    minTrack: 40,
} as const;

/** Everything on a row that is not the track: paddings, three columns, three gaps. */
export const usageBarFixedWidth =
    usageBarColumns.horizontalPadding * 2
    + usageBarColumns.name
    + usageBarColumns.percent
    + usageBarColumns.trailing
    + usageBarColumns.gap * 3;

/**
 * How wide the track is inside a container of this width. One number for the
 * whole popup, so every track starts and ends at the same x no matter which
 * fields its row happens to have.
 */
export function usageBarTrackWidth(containerWidth: number): number {
    if (!Number.isFinite(containerWidth)) return usageBarColumns.minTrack;
    return Math.max(usageBarColumns.minTrack, Math.round(containerWidth - usageBarFixedWidth));
}

/** What the number column shows when nothing was measured: a dash, never a gap. */
export const usageBarMissingPercent = '\u2013';

/** The number column's text, so the missing case cannot render as empty. */
export function usageBarPercentLabel(percentText: string | null | undefined): string {
    return percentText ? percentText : usageBarMissingPercent;
}

/**
 * Percent left to a track fraction. Nothing measured reads as an empty track
 * rather than a full one: a row with no figure must not look healthy.
 */
export function usageBarFraction(percentLeft: number | null | undefined): number {
    if (typeof percentLeft !== 'number' || !Number.isFinite(percentLeft)) return 0;
    return Math.min(100, Math.max(0, percentLeft)) / 100;
}

/**
 * The fill colour, by headroom left and nothing else. Deliberately not per
 * account: the point of the column is that two accounts at the same percent
 * look the same.
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

export function usageBarRowFrom(input: {
    key: string;
    name: string;
    percentLeft: number | null;
    percentText: string | null;
    trailing: string;
    disabled?: boolean;
}): UsageBarRow {
    const cut = truncateUsageName(input.name);
    return {
        key: input.key,
        name: cut.name,
        fullName: input.name,
        nameTruncated: cut.truncated,
        fraction: usageBarFraction(input.percentLeft),
        percentText: input.percentText,
        trailing: input.trailing,
        tone: usageBarTone(input.percentLeft),
        disabled: input.disabled === true,
    };
}

/**
 * "jamrizzi · 51% left", or just the name when nothing was measured.
 *
 * The composer popup's heading and the session info screen's account line
 * (DROVE-137) are the same sentence and have to stay that way, so it is built
 * once here rather than spelled out on both screens (DROVE-129).
 */
export function droverAccountHeadroomLabel(
    account: { name: string; headroom?: number | null } | null | undefined,
    showRemaining: boolean,
): string {
    const name = account?.name;
    if (!name) return '';
    const headroom = account?.headroom;
    if (typeof headroom !== 'number' || !Number.isFinite(headroom)) return name;
    return `${name} · ${showRemaining
        ? t('agentInput.usagePopup.left', { percent: Math.round(headroom) })
        : t('agentInput.usagePopup.used', { percent: Math.round(100 - headroom) })}`;
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

export function usageAccountBarRow(a: DroverOtherAccountRow, showRemaining: boolean): UsageBarRow {
    // An account that is out says WHEN it is back; that is the fact worth the
    // trailing slot. With no figure at all the trailing text is the reason
    // there is none, so the empty track is explained.
    const back = usageAccountBackLabel(a);
    if (!a.loggedIn) {
        return usageBarRowFrom({
            key: `account:${a.name}`,
            name: a.name,
            percentLeft: null,
            percentText: null,
            trailing: t('agentInput.usagePopup.noLogin'),
            disabled: true,
        });
    }
    if (a.headroom == null) {
        return usageBarRowFrom({
            key: `account:${a.name}`,
            name: a.name,
            percentLeft: null,
            percentText: null,
            trailing: back || t('agentInput.usagePopup.unmeasured'),
        });
    }
    const percent = showRemaining ? a.headroom : 100 - a.headroom;
    return usageBarRowFrom({
        key: `account:${a.name}`,
        name: a.name,
        percentLeft: a.headroom,
        percentText: `${percent}%`,
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

/** "jamrizzi · 51% left", or the reason there is no figure. */
export function usageAccountGroupTitle(a: DroverOtherAccountRow, showRemaining: boolean): string {
    if (!a.name) return '';
    if (!a.loggedIn) return `${a.name} · ${t('agentInput.usagePopup.noLogin')}`;
    if (a.headroom == null) return `${a.name} · ${t('agentInput.usagePopup.unmeasured')}`;
    return droverAccountHeadroomLabel(a, showRemaining);
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
    showRemaining: boolean,
    override?: UsageLimitsLike,
): UsageBarGroup {
    const byId = new Map<string, { utilization: number | null; resetsAt: number | null }>();
    for (const window of account.windows) {
        byId.set(window.id, { utilization: window.utilization, resetsAt: window.resetsAt });
    }
    for (const row of getUsageLimitRows(override ?? null)) {
        byId.set(row.id, { utilization: row.utilization, resetsAt: row.resetsAt });
    }
    const rows = measures.map((measure) => {
        const window = byId.get(measure.id);
        const utilization = window?.utilization ?? null;
        // `utilization` is percent USED on the wire; the track fills with what
        // is left of it either way, only the printed number follows the setting.
        const percent = utilization == null ? null : getUsageLimitDisplayPercentage(utilization, showRemaining);
        return usageBarRowFrom({
            key: `${account.name}:${measure.id}`,
            name: measure.label,
            percentLeft: utilization == null ? null : 100 - utilization,
            percentText: percent == null ? null : `${Math.round(percent)}%`,
            trailing: window?.resetsAt != null
                ? t('agentInput.usagePopup.resets', { time: formatUsageLimitResetTime(window.resetsAt) })
                : '',
            disabled: !account.loggedIn,
        });
    });
    // The cooling time is normally the reset on one of the rows above, so it
    // is not repeated. When the account has no windows at all it is the only
    // thing there is to say, and it goes on the title rather than nowhere.
    const back = rows.some((row) => row.trailing) ? '' : usageAccountBackLabel(account);
    const title = usageAccountGroupTitle(account, showRemaining);
    return {
        key: account.name ? `account:${account.name}` : 'usage',
        title: back && title ? `${title} · ${back}` : title,
        active: account.current,
        rows,
    };
}

export function resolveUsageStrip(input: UsageStripInput): UsageStrip {
    // Agent state first, because it is live from the SDK; the drover snapshot
    // when there is none, which is every pane session.
    const droverLimits = usageLimitsFromDroverUsage(input.droverUsage, input.droverAccount);
    const usageLimits = input.usageLimits ?? droverLimits;
    const usageFromDrover = !input.usageLimits && !!droverLimits;
    // Only Session and Week are user-meaningful; provider-internal windows
    // (nimbus_quill and friends) stay out of the popup.
    const rows = getUsageLimitRows(usageLimits ?? null);
    const week = rows.find((row) => row.id === 'seven_day') ?? null;
    // A session with the snapshot and no stream shows the strip regardless of
    // the context setting: the number is the reason Clay opens the popup, not
    // a near-limit warning that happens to be on.
    const weekPercent = week?.utilization != null && (input.contextShown || usageFromDrover)
        ? getUsageLimitDisplayPercentage(week.utilization, input.showRemaining)
        : null;

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
            loggedIn: true,
            headroom: null,
            back: null,
            family: null,
            current: true,
            windows: [],
        });
    }
    const measures = usageMeasures(accounts);
    // No heading over the LIST (DROVE-117). Clay: "Don't say other accounts.
    // Have each one listed." Each block is headed by its own account, which is
    // the name he is choosing between; a label over the whole list told nobody
    // anything.
    const groups = accounts.map((account) => usageAccountBarGroup(
        account,
        measures,
        input.showRemaining,
        // The SDK stream is live and belongs to the session's own account; the
        // snapshot is the only reading there is for every other one.
        account.current ? input.usageLimits : null,
    ));
    return { weekPercent, usageFromDrover, usageBarGroups: groups };
}
