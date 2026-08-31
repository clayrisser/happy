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
 * The popup's rows are BARS, not sentences (DROVE-107). Each account used to
 * cost three text lines - "bitspur.com · 0% left", then "Fable back Sep 2",
 * and a long name wrapped again - so five accounts filled the screen and the
 * one number Clay scans for was buried in prose. A row is now a name, a track
 * filled to the headroom LEFT, the number, and the reset time trailing behind
 * it, all on one line. The fill is coloured by how much headroom is left, never
 * by which account it is, so 43% and 0% compare down the column at a glance.
 */
import {
    currentDroverUsageAccount,
    droverFamilyRows,
    droverOtherAccounts,
    usageLimitsFromDroverUsage,
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
    /** "jamrizzi · 51% left" / "Other accounts". */
    title: string;
    rows: UsageBarRow[];
};

export type UsageStrip = {
    /** The number on the strip, already flipped for the "% left" setting; null hides it. */
    weekPercent: number | null;
    /** Nothing from the SDK; the snapshot is what the strip is reading. */
    usageFromDrover: boolean;
    /**
     * The popup: this account's session, week and family rows under its own
     * headroom, then every other account folded under a second heading.
     */
    usageBarGroups: UsageBarGroup[];
};

/** How wide the name column is, in characters, before a name is cut. */
export const usageBarNameLimit = 14;

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

function barRow(input: {
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

export function resolveUsageStrip(input: UsageStripInput): UsageStrip {
    // Agent state first, because it is live from the SDK; the drover snapshot
    // when there is none, which is every pane session.
    const droverLimits = usageLimitsFromDroverUsage(input.droverUsage, input.droverAccount);
    const usageLimits = input.usageLimits ?? droverLimits;
    const usageFromDrover = !input.usageLimits && !!droverLimits;
    // Only Session and Week are user-meaningful; provider-internal windows
    // (nimbus_quill and friends) stay out of the popup.
    const rows = getUsageLimitRows(usageLimits ?? null);
    const session = rows.find((row) => row.id === 'five_hour') ?? null;
    const week = rows.find((row) => row.id === 'seven_day') ?? null;
    // A session with the snapshot and no stream shows the strip regardless of
    // the context setting: the number is the reason Clay opens the popup, not
    // a near-limit warning that happens to be on.
    const weekPercent = week?.utilization != null && (input.contextShown || usageFromDrover)
        ? getUsageLimitDisplayPercentage(week.utilization, input.showRemaining)
        : null;

    const mine: UsageBarRow[] = [];
    const push = (key: string, label: string, row: { utilization: number | null; resetsAt: number | null } | null) => {
        if (!row || row.utilization == null) return;
        // `utilization` is percent USED on the wire; the track fills with what
        // is left of it either way, only the printed number follows the setting.
        const left = 100 - row.utilization;
        const percent = getUsageLimitDisplayPercentage(row.utilization, input.showRemaining);
        mine.push(barRow({
            key,
            name: label,
            percentLeft: left,
            percentText: `${Math.round(percent)}%`,
            trailing: row.resetsAt != null
                ? t('agentInput.usagePopup.resets', { time: formatUsageLimitResetTime(row.resetsAt) })
                : '',
        }));
    };
    push('session', t('agentInput.usagePopup.session'), session);
    push('week', t('agentInput.usagePopup.week'), week);
    // Per model family, where the cache scopes a limit (DROVE-47): on Clay's
    // plan a Fable weekly row sits beside weekly_all, and the two differ by
    // forty points on the day it matters.
    for (const row of droverFamilyRows(input.droverUsage, input.droverAccount)) {
        push(row.id, t('agentInput.usagePopup.familyWeek', { family: row.family }), row);
    }
    const groups: UsageBarGroup[] = [];
    if (mine.length > 0) {
        // The heading carries the picker's own number for THIS account -
        // "jamrizzi · 65% left" - so the popup and `drover accounts` agree at
        // a glance.
        const current = currentDroverUsageAccount(input.droverUsage, input.droverAccount);
        const headroom = current?.headroom;
        const title = current && typeof headroom === 'number' && Number.isFinite(headroom)
            ? `${current.name} · ${input.showRemaining
                ? t('agentInput.usagePopup.left', { percent: Math.round(headroom) })
                : t('agentInput.usagePopup.used', { percent: Math.round(100 - headroom) })}`
            : current?.name ?? '';
        groups.push({ key: 'usage', title, rows: mine });
    }
    // Every OTHER account, folded under its own heading rather than dropped
    // (DROVE-47): the phone has to answer "where can I flip to" without a
    // terminal. Same figures the flip picker prints.
    const others = droverOtherAccounts(input.droverUsage, input.droverAccount)
        .map((a) => {
            // An account that is out says WHEN it is back; that is the fact
            // worth the trailing slot. With no figure at all the trailing text
            // is the reason there is none, so the empty track is explained.
            const back = a.back != null
                ? a.family
                    ? t('agentInput.usagePopup.familyBack', { family: a.family, time: formatUsageLimitResetTime(a.back) })
                    : t('agentInput.usagePopup.back', { time: formatUsageLimitResetTime(a.back) })
                : '';
            if (!a.loggedIn) {
                return barRow({
                    key: `account:${a.name}`,
                    name: a.name,
                    percentLeft: null,
                    percentText: null,
                    trailing: t('agentInput.usagePopup.noLogin'),
                    disabled: true,
                });
            }
            if (a.headroom == null) {
                return barRow({
                    key: `account:${a.name}`,
                    name: a.name,
                    percentLeft: null,
                    percentText: null,
                    trailing: back || t('agentInput.usagePopup.unmeasured'),
                });
            }
            const percent = input.showRemaining ? a.headroom : 100 - a.headroom;
            return barRow({
                key: `account:${a.name}`,
                name: a.name,
                percentLeft: a.headroom,
                percentText: `${percent}%`,
                trailing: back,
            });
        });
    if (others.length > 0) {
        groups.push({ key: 'accounts', title: t('agentInput.usagePopup.otherAccounts'), rows: others });
    }
    return { weekPercent, usageFromDrover, usageBarGroups: groups };
}
