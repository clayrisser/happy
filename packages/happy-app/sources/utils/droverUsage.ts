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
    const windows = rows(account).map((row) => {
        const scoped = !!(row.scope || row.family);
        const id = scoped
            ? droverFamilyWindowId(row)
            : row.kind === 'session' ? 'five_hour'
                : row.kind === 'weekly_all' ? 'seven_day'
                    : row.kind;
        const family = scoped ? droverFamilyLabel(row) : null;
        return {
            id,
            ...(family ? { label: family } : {}),
            utilization: row.percent,
            resetsAt: row.resetsAt ?? null,
        };
    });
    return { capturedAt: usage.capturedAt, windows };
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
        .map((a) => {
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
        });
}
