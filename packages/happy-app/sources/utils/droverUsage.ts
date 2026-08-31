/**
 * The usage strip for a session with no SDK rate-limit stream (DROVE-47).
 *
 * `agentState.usageLimits` is filled by the CLI's remote path, from the SDK's
 * rate_limit_event and get_usage. A Cattle Drover pane session is a Claude
 * Code TUI in tmux and never has that stream, so the strip under the composer
 * stayed empty while `drover accounts` in the terminal knew every account's
 * headroom. The CLI now stamps that knowledge on `metadata.droverUsage` — every
 * registry account, the one the session is on marked `current` — and this file
 * turns it into what the strip already renders.
 *
 * Two outputs. The current account becomes a UsageLimitsLike, window ids
 * matching the SDK's (`five_hour`, `seven_day`) so the existing chip, popup and
 * colour code light up unchanged, plus one window per model family the cache
 * scopes. The OTHER accounts become rows for a folded group in the same popup,
 * so the phone answers "where can I flip to" without a terminal.
 */
import type { UsageLimitsLike } from './sessionStatusBar';

export type DroverUsageRowLike = {
    kind: string;
    /** Percent used, 0-100. */
    percent: number;
    resetsAt?: number | null;
    /** The cache's own scope name ("Fable"); null for an account-wide row. */
    scope?: string | null;
    /** That scope reduced to a family ("fable"); null when unscoped or unreadable. */
    family?: string | null;
};

export type DroverUsageAccountLike = {
    name: string;
    current?: boolean | null;
    loggedIn?: boolean | null;
    fetchedAt?: number | null;
    /** Percent LEFT on the fullest limit; null when never measured. */
    headroom?: number | null;
    cooling?: { until: number; reason?: string | null; family?: string | null } | null;
    limits?: DroverUsageRowLike[] | null;
};

export type DroverUsageLike = {
    capturedAt: number;
    accounts: DroverUsageAccountLike[];
} | null | undefined;

function rows(account: DroverUsageAccountLike | null | undefined): DroverUsageRowLike[] {
    return Array.isArray(account?.limits) ? account.limits : [];
}

/**
 * The account the session is on. The `current` flag is what the CLI says at
 * the moment of the snapshot; `droverAccount` is the older stamp and is only
 * the fallback for a snapshot that marked nothing.
 */
export function currentDroverUsageAccount(
    usage: DroverUsageLike,
    droverAccount?: string | null,
): DroverUsageAccountLike | null {
    if (!usage || !Array.isArray(usage.accounts)) return null;
    return usage.accounts.find((a) => a?.current)
        ?? (droverAccount ? usage.accounts.find((a) => a?.name === droverAccount) : undefined)
        ?? null;
}

/** "fable" -> "Fable"; the cache's own spelling when it has one. */
export function droverFamilyLabel(row: Pick<DroverUsageRowLike, 'scope' | 'family'>): string | null {
    if (row.scope) return row.scope;
    if (row.family) return row.family.charAt(0).toUpperCase() + row.family.slice(1);
    return null;
}

/** Window id for a scoped weekly row: `seven_day_fable`, `seven_day_opus`. */
export function droverFamilyWindowId(row: Pick<DroverUsageRowLike, 'kind' | 'scope' | 'family'>): string {
    const base = row.kind === 'session' ? 'five_hour' : 'seven_day';
    const tag = (row.family ?? row.scope ?? 'scoped').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return `${base}_${tag}`;
}

/**
 * The window id for ANY usage row, scoped or not.
 *
 * `session` becomes `five_hour` and `weekly_all` becomes `seven_day`, the two
 * ids the strip already knows; a scoped row keeps its family in the id. Pulled
 * out of usageLimitsFromDroverUsage so the wrist's binding-limit row
 * (DROVE-131) names a window with the same string the strip does, rather than
 * a second spelling that would look like a different limit (DROVE-129).
 */
export function droverWindowId(row: Pick<DroverUsageRowLike, 'kind' | 'scope' | 'family'>): string {
    if (row.scope || row.family) return droverFamilyWindowId(row);
    if (row.kind === 'session') return 'five_hour';
    if (row.kind === 'weekly_all') return 'seven_day';
    return row.kind;
}

/**
 * The current account's rows in the shape agentState.usageLimits takes.
 *
 * `session` becomes `five_hour` and `weekly_all` becomes `seven_day`, the two
 * ids the strip already knows. A scoped row keeps its family in the id and a
 * label the popup can print, and a row this cannot place is passed through
 * under its own kind rather than dropped — a limit missing from the one screen
 * Clay is looking at is the whole bug.
 */
export function usageLimitsFromDroverUsage(
    usage: DroverUsageLike,
    droverAccount?: string | null,
): UsageLimitsLike {
    const account = currentDroverUsageAccount(usage, droverAccount);
    if (!usage || !account) return null;
    const windows = droverAccountWindows(account).map((w) => ({
        id: w.id,
        ...(w.family ? { label: w.family } : {}),
        utilization: w.utilization,
        resetsAt: w.resetsAt,
    }));
    return { capturedAt: usage.capturedAt, windows };
}

export type DroverUsageWindow = {
    /** `five_hour`, `seven_day`, `seven_day_fable`, or the cache's own kind. */
    id: string;
    /** "Fable" when the row is scoped to a model family; null when it is not. */
    family: string | null;
    /** Percent USED, the wire's direction. */
    utilization: number;
    resetsAt: number | null;
};

/**
 * One account's limits as windows, ids matching the SDK's.
 *
 * Split out for DROVE-148: the quota sheet now draws Session, Week and each
 * family week for EVERY account, not only the one the session is on, so the
 * mapping that used to serve the current account alone has to work on any of
 * them. A row this cannot place is still passed through under its own kind.
 */
export function droverAccountWindows(account: DroverUsageAccountLike | null | undefined): DroverUsageWindow[] {
    return rows(account).map((row) => ({
        // The one spelling of a window's id (DROVE-131): the wrist's binding
        // row and the strip's bars name a window with this same string.
        id: droverWindowId(row),
        family: row.scope || row.family ? droverFamilyLabel(row) : null,
        utilization: row.percent,
        resetsAt: row.resetsAt ?? null,
    }));
}

export type DroverFamilyRow = {
    id: string;
    /** "Fable" — the model family this row is scoped to. */
    family: string;
    utilization: number;
    resetsAt: number | null;
};

/** The current account's family-scoped rows, for the popup under Session and Week. */
export function droverFamilyRows(usage: DroverUsageLike, droverAccount?: string | null): DroverFamilyRow[] {
    const account = currentDroverUsageAccount(usage, droverAccount);
    const out: DroverFamilyRow[] = [];
    for (const row of rows(account)) {
        const family = row.scope || row.family ? droverFamilyLabel(row) : null;
        if (!family) continue;
        out.push({
            id: droverFamilyWindowId(row),
            family,
            utilization: Math.round(Math.min(100, Math.max(0, row.percent))),
            resetsAt: typeof row.resetsAt === 'number' && Number.isFinite(row.resetsAt) ? row.resetsAt : null,
        });
    }
    return out;
}

export type DroverOtherAccountRow = {
    name: string;
    loggedIn: boolean;
    /** Percent left, the picker's own number; null when never measured. */
    headroom: number | null;
    /** When it is back, when it is out right now. */
    back: number | null;
    /** The one family that is out, when it is one and not the whole account. */
    family: string | null;
};

/**
 * Every account this session is NOT on, in registry order, with the same
 * figures the flip picker prints — "jamrizzi · 65% left", "main · 0% · Fable
 * back Thu 05:00". Registry order rather than headroom order on purpose: it
 * is the order `drover accounts` prints, and the popup's job is to agree with
 * it, not to re-rank it.
 */
export function droverOtherAccounts(usage: DroverUsageLike, droverAccount?: string | null): DroverOtherAccountRow[] {
    if (!usage || !Array.isArray(usage.accounts)) return [];
    const current = currentDroverUsageAccount(usage, droverAccount);
    return usage.accounts
        .filter((a) => a && typeof a.name === 'string' && a !== current)
        .map(toAccountRow);
}

/**
 * One account as a row. Extracted so the CURRENT account and every other one
 * are described by the same code (DROVE-129: one derivation, not two that
 * drift). The composer popup lists the others with this shape; the session
 * info screen shows the current one with it (DROVE-137).
 */
function toAccountRow(a: DroverUsageAccountLike): DroverOtherAccountRow {
    const cooling = a.cooling && typeof a.cooling.until === 'number' ? a.cooling : null;
    const family = cooling?.family
        ? droverFamilyLabel({ family: cooling.family })
        : null;
    return {
        name: a.name,
        loggedIn: a.loggedIn !== false,
        headroom: typeof a.headroom === 'number' && Number.isFinite(a.headroom)
            ? Math.round(Math.min(100, Math.max(0, a.headroom)))
            : null,
        back: cooling?.until ?? null,
        family,
    };
}

export type DroverAccountUsageRow = DroverOtherAccountRow & {
    /** The account the session is on. Exactly one, when the snapshot names one. */
    current: boolean;
    windows: DroverUsageWindow[];
};

/**
 * EVERY account in the snapshot, the current one first, registry order after
 * it, each carrying its own quota windows (DROVE-148).
 *
 * Clay: "This should be listing all three bars for each account." One headroom
 * number per account does not answer the question the sheet exists for, which
 * is where to flip to: an account can be fine on the week and burnt on the
 * session, and that is exactly the moment the sheet gets opened. So the sheet
 * needs each account's windows, not just its fullest limit.
 *
 * Current first rather than in registry order, because it is the account being
 * compared against; the rest keep the order `drover accounts` prints.
 */
export function droverAccountsUsage(usage: DroverUsageLike, droverAccount?: string | null): DroverAccountUsageRow[] {
    if (!usage || !Array.isArray(usage.accounts)) return [];
    const current = currentDroverUsageAccount(usage, droverAccount);
    const named = usage.accounts.filter((a) => a && typeof a.name === 'string');
    const ordered = current ? [current, ...named.filter((a) => a !== current)] : named;
    return ordered.map((a) => ({
        ...toAccountRow(a),
        current: a === current,
        windows: droverAccountWindows(a),
    }));
}

/**
 * The account this session is running on, in that same row shape (DROVE-137).
 *
 * Falls back to the `droverAccount` stamp when there is no usage snapshot at
 * all: a session on a machine whose CLI predates DROVE-47 still knows WHICH
 * account it is on, and the name with no bar beats no line at all.
 */
export function currentDroverAccountRow(
    usage: DroverUsageLike,
    droverAccount?: string | null,
): DroverOtherAccountRow | null {
    const account = currentDroverUsageAccount(usage, droverAccount);
    if (account && typeof account.name === 'string') return toAccountRow(account);
    const name = droverAccount?.trim();
    if (!name) return null;
    return { name, loggedIn: true, headroom: null, back: null, family: null };
}
