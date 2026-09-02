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
import { accountHarness } from './droverAccounts';
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
    /**
     * Does this row still describe a window that EXISTS? (DROVE-204)
     *
     * The CLI's verdict, made against the real clock at the moment it read the
     * cache. False means the window this counted has already reset, so the
     * percent describes something that was thrown away: no bar, no number.
     * Absent from a snapshot an older CLI wrote, and absent reads as usable —
     * which is what that CLI meant.
     */
    usable?: boolean | null;
};

export type DroverUsageAccountLike = {
    name: string;
    /**
     * Which subscription this account is — 'claude' or 'cursor' (DROVE-270).
     * Absent means claude, which is what every snapshot written before the
     * field existed meant.
     */
    harness?: string | null;
    /**
     * How the cursor token is doing, and how many whole days it has left.
     * Null on a Claude row; absent from a machine whose daemon predates the
     * fields. A cursor login runs sixty days and cannot be refreshed, so the
     * countdown is the only warning there is.
     */
    tokenState?: string | null;
    expiresInDays?: number | null;
    current?: boolean | null;
    loggedIn?: boolean | null;
    /**
     * Claude Code's one-time first run is settled for that config dir
     * (DROVE-246). False is a dead end for a flip; absent means an older
     * machine that does not report it, which reads as fine.
     */
    onboarded?: boolean | null;
    /**
     * THE BACK DOOR (DROVE-333): the ambient login, plus every row sharing it.
     *
     * An automatic pick does not land there while anything else can take the
     * work, and a session already there is not flipped, downgraded or parked
     * off it — so the only way on or off is by hand, and the `Switch ›` on this
     * sheet is one of the hands.
     *
     * The CLI decides it and stamps it (happy-cli src/drover/flip/accounts.ts
     * `isBackdoorAccount`), because this payload carries neither `ambient` nor
     * `login` and cannot work it out. Absent means an older machine that never
     * asked, which reads as NOT the back door: inventing one out of a missing
     * field would label somebody's ordinary account.
     */
    backdoor?: boolean | null;
    fetchedAt?: number | null;
    /** Percent LEFT on the fullest limit; null when never measured. */
    headroom?: number | null;
    cooling?: { until: number; reason?: string | null; family?: string | null } | null;
    limits?: DroverUsageRowLike[] | null;
};

export type DroverUsageLike = {
    capturedAt: number;
    /** The model family the session is running ("opus"); null when unknown (DROVE-173). */
    modelFamily?: string | null;
    accounts: DroverUsageAccountLike[];
} | null | undefined;

/**
 * Does this window bind a session running `modelFamily`? (DROVE-173)
 *
 * The app's copy of the CLI's `rowApplies` (happy-cli
 * src/drover/flip/usage.ts), and it has to stay its copy: the CLI computes
 * `headroom` with that rule and the wrist's binding limit is derived here from
 * the same rows, so the two would print different windows the moment they
 * disagreed (DROVE-129).
 *
 * An unscoped window binds every model. A family window binds only a session
 * in that family. An unreadable scope binds, and an unknown model is bound by
 * everything — the conservative reading on both sides.
 */
export function droverRowApplies(
    row: Pick<DroverUsageRowLike, 'scope' | 'family'>,
    modelFamily: string | null | undefined,
): boolean {
    if (!row.scope) return true;
    if (!modelFamily) return true;
    if (!row.family) return true;
    return row.family === modelFamily;
}

/**
 * WHICH WINDOW SITS OVER WHICH, AND WHAT THAT COSTS THE ONE UNDERNEATH
 * (DROVE-255).
 *
 * Clay, at the sheet: "When week has expired show session expired so it's more
 * obvious." Three accounts read `0% left on Week` over a SESSION row drawn at
 * 0% used with a green sliver, which under fill-as-used (DROVE-230) is the
 * picture of a brand new window with everything still in it. Both numbers were
 * true. The five-hour window really had not been touched, and it was also
 * completely unspendable, because the week above it was gone. The row wearing
 * the healthy mark was the row that could not be used.
 *
 * So: A WINDOW IS MOOTED WHEN A WIDER WINDOW THAT ALSO APPLIES TO IT IS
 * EXHAUSTED, and a mooted window must not advertise capacity.
 *
 * `covers` is the whole rule and it is written down here rather than left to
 * "the longer one wins", because the longer one does NOT always win. The Fable
 * week is seven days and the session is five hours, and an exhausted Fable
 * week moots nothing on an account whose session window an Opus turn will
 * spend — the sheet's own caption says as much ("Fable week not counted for
 * Opus"). Greying a row that is genuinely usable is a worse bug than the one
 * this fixes, so both halves have to hold:
 *
 *   PERIOD — the covering window's period is strictly LONGER. A week contains
 *   a session; a session does not contain a week. A spent session therefore
 *   moots nothing: the week still has room, it is simply not reachable until
 *   the next five-hour window opens, and that is what the session row's own
 *   full bar and reset time already say.
 *
 *   MODEL SCOPE — every model the narrow window measures, the wide one
 *   measures too. An unscoped window measures every model, so it covers
 *   anything narrower. A family window measures one family, so it covers only
 *   a window scoped to that same family, and never the account-wide session
 *   row.
 *
 * The rule is deliberately NOT model-aware, though the session's own model is
 * known here. A Fable session on an account whose Fable week is spent really
 * can spend nothing, so a model-aware rule would moot the account-wide session
 * row for it. It would also moot that row on every OTHER account listed for a
 * flip, whose Opus headroom is real and is exactly what the sheet is opened to
 * find; and the model can change under a sheet that is already open. The
 * structural rule is the conservative half, it fixes the reported bug, and it
 * means a surface with no model context (the wrist) reads these windows the
 * same way this one does (DROVE-129).
 */
export type DroverWindowPeriod = 'session' | 'week';

export type DroverWindowSpan = {
    /** Five hours or seven days. Null for a kind neither side knows. */
    period: DroverWindowPeriod | null;
    /** The model family it measures; null when it measures every model. */
    family: string | null;
};

/** Longer is higher. The only ordering `droverWindowCovers` reads. */
const droverWindowPeriodRank: Record<DroverWindowPeriod, number> = { session: 1, week: 2 };

/**
 * A window id back into the two facts the rule needs.
 *
 * Off the ID rather than the raw row, because the ids are the one spelling
 * both feeds share: `droverWindowId` builds them from the CLI's snapshot and
 * the SDK stream already speaks `five_hour` / `seven_day`, so a remote session
 * and a pane session are covered by the same relation. A kind neither prefix
 * matches — the provider-internal windows `headroom` counts and the sheet does
 * not draw — comes back with no period, which covers nothing and is covered by
 * nothing. That is the conservative end on purpose.
 */
export function droverWindowSpan(id: string): DroverWindowSpan {
    for (const [prefix, period] of [['five_hour', 'session'], ['seven_day', 'week']] as const) {
        if (id === prefix) return { period, family: null };
        if (id.startsWith(`${prefix}_`)) return { period, family: id.slice(prefix.length + 1) };
    }
    return { period: null, family: null };
}

/** Does `wider` contain `narrower`, for every model `narrower` measures? */
export function droverWindowCovers(wider: DroverWindowSpan, narrower: DroverWindowSpan): boolean {
    if (!wider.period || !narrower.period) return false;
    if (droverWindowPeriodRank[wider.period] <= droverWindowPeriodRank[narrower.period]) return false;
    // Unscoped measures every model, so it covers anything shorter. A family
    // window covers only the same family — this is the half that keeps an
    // exhausted Fable week off the account-wide session row.
    if (wider.family == null) return true;
    return wider.family === narrower.family;
}

export type DroverMootableWindow = {
    id: string;
    /** Percent USED, the wire's direction; null when nothing was measured. */
    utilization: number | null;
    /** The reading still describes a window that exists (DROVE-204). */
    usable: boolean;
};

/**
 * Is there nothing left in this window?
 *
 * ROUNDED, the same way the account heading rounds `headroom`, so a row cannot
 * be told it is fine underneath a heading that says `0% left on Week`. Making
 * the rows agree with the heading is the entire point of the ticket, and a
 * second rounding rule is how they would come apart again.
 *
 * A window whose reading has expired is not spent, it is unknown (DROVE-204),
 * and unknown must not moot anything: the honest answer there is that nobody
 * knows what is in it.
 */
export function droverWindowSpent(window: DroverMootableWindow): boolean {
    if (!window.usable) return false;
    if (typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) return false;
    return Math.round(100 - window.utilization) <= 0;
}

/**
 * The exhausted window that makes this one unspendable, or null.
 *
 * Two windows are left alone on purpose. One with NO figure advertises no
 * capacity, so there is nothing to take away and DROVE-204's own reason keeps
 * the trailing slot. One that is exhausted ITSELF is honestly drawn by its own
 * full red bar, and it is also the row the heading may be quoting — the
 * binding mark and a hollow track on one row would be the contradiction this
 * ticket is removing, wearing different clothes.
 */
export function droverMootingWindow<T extends DroverMootableWindow>(
    window: DroverMootableWindow,
    windows: readonly T[],
): T | null {
    if (!window.usable) return null;
    if (typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) return null;
    if (droverWindowSpent(window)) return null;
    const span = droverWindowSpan(window.id);
    for (const other of windows) {
        if (other.id === window.id) continue;
        if (!droverWindowSpent(other)) continue;
        if (droverWindowCovers(droverWindowSpan(other.id), span)) return other;
    }
    return null;
}

/**
 * How old a per-account reading may be before the sheet says so (DROVE-173).
 *
 * Claude Code refreshes an account's cache as a session starts, so an hour
 * without one means nobody has looked. Under that the numbers move slowly
 * enough that a label would be noise.
 */
export const droverStaleAfterMs = 60 * 60_000;

/**
 * How often the CLI goes and looks (happy-cli `src/drover/flip/usage.ts`,
 * `sweepMs`). Kept in step with it by hand, the way `droverRowApplies` is
 * kept in step with `rowApplies`: the two run in different processes and the
 * app has no way to read the CLI's constant.
 */
export const droverSweepMs = 10 * 60_000;

/**
 * How old the snapshot ON SCREEN is (DROVE-230).
 *
 * Different from `droverAccountStale`, which asks whether one account's cache
 * lagged the sweep that read it. This asks whether the whole reading is old,
 * which is the question Clay was actually asking when he said the numbers
 * looked wrong: `main` read 66/99/100 against a sheet showing 37/2/0 and the
 * entire three-point gap was minutes of aging that nothing on the sheet
 * mentioned.
 *
 * Measured against the phone's clock on purpose, and it is the one place that
 * is right to do so: the question is "how long since anyone looked", and only
 * the wall clock can answer it.
 */
export function droverSnapshotAgeMs(
    capturedAt: number | null | undefined,
    now: number,
): number | null {
    if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null;
    if (!Number.isFinite(now)) return null;
    // A snapshot stamped in the future is a clock disagreement, not a negative
    // age. Zero reads as "just now", which is the honest end of that.
    return Math.max(0, now - capturedAt);
}

/** Has the sweep that should have refreshed this reading failed to land? */
export function droverSnapshotOverdue(ageMs: number | null): boolean {
    return ageMs != null && ageMs >= droverSweepMs;
}

/**
 * Is this account's reading old enough that the sheet must not show it as
 * current? (DROVE-173)
 *
 * Measured against the SNAPSHOT's own `capturedAt`, not the wall clock. The
 * CLI reads every account's cache in one pass, so `capturedAt` is when the
 * question was last asked and `fetchedAt` is when THIS account last answered;
 * the gap between them is the only staleness the snapshot can be honest about.
 * Using the phone's clock instead would call a snapshot stale for having been
 * in flight, and would make this untestable without freezing time.
 *
 * Two ways to be stale, and the second is the one that bites. Age is the
 * obvious one. The other is a window that had already RESET when the snapshot
 * was taken: the session window is five hours, so a cache one window old
 * prints LAST window's reset as if it were the next one, and a reset time in
 * the past is the proof rather than a guess.
 */
export function droverAccountStale(
    account: Pick<DroverUsageAccountLike, 'fetchedAt' | 'limits'> | null | undefined,
    capturedAt: number,
): boolean {
    if (!account || !Number.isFinite(capturedAt)) return false;
    for (const row of rows(account)) {
        if (typeof row.resetsAt === 'number' && Number.isFinite(row.resetsAt) && row.resetsAt <= capturedAt) {
            return true;
        }
    }
    const fetchedAt = account.fetchedAt;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return false;
    return capturedAt - fetchedAt >= droverStaleAfterMs;
}

function rows(account: Pick<DroverUsageAccountLike, 'limits'> | null | undefined): DroverUsageRowLike[] {
    return Array.isArray(account?.limits) ? account.limits : [];
}

/**
 * Is this row's number about a window that still exists? (DROVE-204)
 *
 * The CLI says so on the wire, because it had the real clock when it read the
 * cache. Without that field — an older CLI — the same question is asked of the
 * snapshot's own `capturedAt`, which is the only clock this side can compare
 * against honestly (see droverAccountStale for why not the phone's).
 *
 * This is the rule behind "99% session left" on an account that was refusing
 * turns: the row was real, its five-hour window had reset three hours before
 * the snapshot, and nothing had been back to look.
 */
export function droverRowUsable(
    row: Pick<DroverUsageRowLike, 'resetsAt' | 'usable'>,
    capturedAt: number,
): boolean {
    if (typeof row.usable === 'boolean') return row.usable;
    const resets = row.resetsAt;
    if (typeof resets !== 'number' || !Number.isFinite(resets)) return true;
    if (!Number.isFinite(capturedAt)) return true;
    return resets > capturedAt;
}

/** Does this account carry a reading whose window has already reset? */
export function droverAccountExpired(
    account: Pick<DroverUsageAccountLike, 'limits'> | null | undefined,
    capturedAt: number,
): boolean {
    return rows(account).some((row) => !droverRowUsable(row, capturedAt));
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

/**
 * THE SNAPSHOT NARROWED TO ONE HARNESS (DROVE-352).
 *
 * Clay, on a Claude session: "This particular session is a Claude session, so
 * I'm not sure why it's showing Cursor accounts. The list of accounts for the
 * session you're in should only show accounts that are on that computer AND
 * are the same harness." His sheet had two Cursor blocks between the Claude
 * ones, each drawing three dashed bars for Session, Week and Fable week —
 * windows a cursor subscription does not have, on accounts the session could
 * never move onto.
 *
 * The CLI stamps THE WHOLE REGISTRY (`usageSnapshot` maps `readAccounts()`
 * with no harness filter), which is right for the payload and wrong for this
 * screen: the sheet is where a session is compared against the places it could
 * go, and a cursor account is not one of them for a Claude session.
 *
 * THE MACHINE HALF NEEDS NO CODE. This snapshot is session metadata, written
 * by the CLI process hosting that session off that machine's own registry, and
 * the sheet reads `session.metadata.droverUsage`. There is no path by which
 * another machine's accounts reach it. Only the harness had to be asked.
 *
 * THE CURRENT ACCOUNT IS NEVER DROPPED. The account a session is running on is
 * that account whatever `flavor` claims, and a mis-stamped flavor emptying the
 * sheet would be a worse bug than the one this fixes. So the filter can only
 * ever remove rows the session is NOT on.
 *
 * Absent on both sides reads as claude (`sessionHarness`, `accountHarness`),
 * which is what makes an older snapshot degrade to exactly today's behaviour
 * rather than to an empty sheet.
 */
export function droverUsageForHarness(
    usage: DroverUsageLike,
    harness: string,
    droverAccount?: string | null,
): DroverUsageLike {
    if (!usage || !Array.isArray(usage.accounts)) return usage;
    const current = currentDroverUsageAccount(usage, droverAccount);
    const kept = usage.accounts.filter((a) => a === current || accountHarness(a) === harness);
    // Identity when nothing goes, so a memo keyed on this object does not
    // churn on every session that has one harness in its registry.
    if (kept.length === usage.accounts.length) return usage;
    return { ...usage, accounts: kept };
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
    // A window that had already reset is DROPPED here rather than passed on
    // with its number (DROVE-204). This feeds the one figure on the composer
    // strip, which has no room to explain itself; a strip with no week figure
    // reads as "not known", a strip saying 99% on a window that reset three
    // hours ago reads as a promise.
    const windows = droverAccountWindows(account, usage.capturedAt)
        .filter((w) => w.usable)
        .map((w) => ({
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
    /**
     * False when this window had already reset when the snapshot was taken
     * (DROVE-204). The row is still drawn, and drawn with no bar and no
     * number: the utilization above describes a window that no longer exists.
     */
    usable: boolean;
};

/**
 * One account's limits as windows, ids matching the SDK's.
 *
 * Split out for DROVE-148: the quota sheet now draws Session, Week and each
 * family week for EVERY account, not only the one the session is on, so the
 * mapping that used to serve the current account alone has to work on any of
 * them. A row this cannot place is still passed through under its own kind.
 */
export function droverAccountWindows(
    account: DroverUsageAccountLike | null | undefined,
    capturedAt = Number.NaN,
): DroverUsageWindow[] {
    return rows(account).map((row) => ({
        // The one spelling of a window's id (DROVE-131): the wrist's binding
        // row and the strip's bars name a window with this same string.
        id: droverWindowId(row),
        family: row.scope || row.family ? droverFamilyLabel(row) : null,
        utilization: row.percent,
        resetsAt: row.resetsAt ?? null,
        usable: droverRowUsable(row, capturedAt),
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
    /**
     * 'claude' or 'cursor' (DROVE-270). Carried onto the row because a cursor
     * account is UNMEASURED for a structural reason and unswitchable for a
     * structural reason, and neither can be told from `headroom: null` alone —
     * an unread Claude account looks identical and is neither.
     */
    harness: string;
    /**
     * The cursor token's state and its days left, carried through so the sheet
     * can say `renew in 3d` in the slot a percentage would occupy. Null on a
     * Claude row and on a machine that reported neither.
     */
    tokenState: string | null;
    expiresInDays: number | null;
    loggedIn: boolean;
    /**
     * Claude Code's one-time first run is settled for that config dir
     * (DROVE-246). False makes the row unswitchable exactly as `loggedIn:
     * false` does — a session there opens on the theme picker — and it is
     * carried separately because the two need different fixes.
     */
    onboarded: boolean;
    /**
     * The back door: nothing automatic lands here or moves off it (DROVE-333).
     * The row stays switchable — a flip BY HAND is the whole point of it.
     */
    backdoor: boolean;
    /** The reading is old enough to say so rather than show as current (DROVE-173). */
    stale?: boolean;
    /**
     * At least one of this account's windows had already reset (DROVE-204), so
     * there is no headroom figure and the heading has to say WHY there is none
     * — "not measured" would be a different, milder claim.
     */
    expired?: boolean;
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
        .map((a) => toAccountRow(a, usage.capturedAt));
}

/**
 * One account as a row. Extracted so the CURRENT account and every other one
 * are described by the same code (DROVE-129: one derivation, not two that
 * drift). The composer popup lists the others with this shape; the session
 * info screen shows the current one with it (DROVE-137).
 */
function toAccountRow(a: DroverUsageAccountLike, capturedAt = Number.NaN): DroverOtherAccountRow {
    const cooling = a.cooling && typeof a.cooling.until === 'number' ? a.cooling : null;
    const family = cooling?.family
        ? droverFamilyLabel({ family: cooling.family })
        : null;
    return {
        name: a.name,
        harness: accountHarness(a),
        tokenState: typeof a.tokenState === 'string' ? a.tokenState : null,
        expiresInDays: typeof a.expiresInDays === 'number' && Number.isFinite(a.expiresInDays)
            ? a.expiresInDays
            : null,
        loggedIn: a.loggedIn !== false,
        // Absent reads as onboarded, which is what an older CLI meant: it did
        // not report the field because nothing had asked the question yet.
        onboarded: a.onboarded !== false,
        // Absent reads as NOT the back door, which is the opposite default and
        // the right one: onboarding is a thing an old CLI simply did not
        // mention, and a back door is a thing it did not have.
        backdoor: a.backdoor === true,
        ...(droverAccountStale(a, capturedAt) ? { stale: true } : {}),
        ...(droverAccountExpired(a, capturedAt) ? { expired: true } : {}),
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
 *
 * That registry order is no longer what the SHEET lists (DROVE-248). It ranks
 * these by headroom in `rankUsageAccounts`, because "which account should I
 * move to" is not a question the registry's order answers. What comes out of
 * here is still the registry's, and it is what breaks the ranking's last tie.
 */
export function droverAccountsUsage(usage: DroverUsageLike, droverAccount?: string | null): DroverAccountUsageRow[] {
    if (!usage || !Array.isArray(usage.accounts)) return [];
    const current = currentDroverUsageAccount(usage, droverAccount);
    const named = usage.accounts.filter((a) => a && typeof a.name === 'string');
    const ordered = current ? [current, ...named.filter((a) => a !== current)] : named;
    return ordered.map((a) => ({
        ...toAccountRow(a, usage.capturedAt),
        current: a === current,
        windows: droverAccountWindows(a, usage.capturedAt),
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
    if (account && typeof account.name === 'string') return toAccountRow(account, usage?.capturedAt ?? Number.NaN);
    const name = droverAccount?.trim();
    if (!name) return null;
    // A session already RUNNING on this account is the proof that it can run,
    // so both gates read true here — there is nothing to warn about on a pane
    // that is answering (DROVE-246).
    // 'claude' rather than a guess: the only thing known here is a stamped
    // name, and every session predating the harness field is a Claude one.
    return {
        name,
        harness: 'claude',
        tokenState: null,
        expiresInDays: null,
        loggedIn: true,
        onboarded: true,
        // A bare stamp says a name and nothing else, and the back door is a
        // fact about the REGISTRY. Guessing it from the name is exactly what
        // isBackdoorAccount refuses to do on both sides (DROVE-333).
        backdoor: false,
        headroom: null,
        back: null,
        family: null,
    };
}
