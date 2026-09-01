/**
 * Cattle Drover accounts (BASED-98).
 *
 * A drover account is one CLAUDE_CONFIG_DIR, one subscription login. The CLI
 * stamps `metadata.droverAccount` on every session it starts under
 * `claude-acct`, so the app can tell which account is doing the work. Sessions
 * with no stamp are "unaccounted".
 *
 * The sessions list used to filter itself by account from a chip row. That row
 * is gone (DROVE-135) and so are the two helpers that served only it; account
 * management belongs in Settings, not on top of the list.
 */

/* ------------------------------------------------------------------------- *
 * WHICH HARNESS AN ACCOUNT IS FOR (DROVE-270).
 *
 * Clay, with the Accounts page open: "Why doesn't it have an option to add a
 * cursor account". It did not, and the reason it could not is here: an account
 * carried no harness anywhere in this app, so a cursor subscription and a
 * Claude subscription were the same shape and every screen would have had to
 * guess which was which from a missing number.
 *
 * The two are genuinely different things, and the difference is the whole
 * design:
 *
 *   a CLAUDE account is a LOGIN in a CLAUDE_CONFIG_DIR. The credential lives
 *     on one machine — on a Mac, a Keychain item keyed to that directory —
 *     and only one of them can be in use at a time, which is why a flip exists
 *     and why it is a config-dir swap and a respawn.
 *   a CURSOR account is a TOKEN. cursor-agent takes `CURSOR_AUTH_TOKEN`, which
 *     outranks both an API key and the machine's stored login, so drover hands
 *     each session its own and two cursor accounts run side by side. There is
 *     nothing to swap, so there is no flip.
 *
 * Absent means claude, always: every session, snapshot and registry written
 * before this field existed is a Claude one.
 * ------------------------------------------------------------------------- */

/** The harness an account row is for. Absent, blank or unknown-cased → claude. */
export function accountHarness(account: { harness?: string | null } | null | undefined): string {
    const raw = typeof account?.harness === 'string' ? account.harness.trim().toLowerCase() : '';
    return raw || 'claude';
}

/** A CLAUDE account: a login, a config dir, a keychain item, a flip target. */
export function isClaudeAccount(account: { harness?: string | null } | null | undefined): boolean {
    return accountHarness(account) === 'claude';
}

/** A CURSOR account: a token, no directory, no measurable quota, no flip. */
export function isCursorAccount(account: { harness?: string | null } | null | undefined): boolean {
    return accountHarness(account) === 'cursor';
}

/**
 * Why a cursor row shows a dash where every other row shows a percentage.
 *
 * Said out loud rather than left as an empty slot, because the alternative
 * reading of a blank is "the app failed to fetch it". Cursor publishes no
 * quota anywhere — no usage cache, no limits, no reset — and that is
 * STRUCTURAL, not an oversight: its accounting is server-side. The number is
 * not late, it does not exist. Never rendered as a healthy 100%: guessing
 * either end of the scale would put a cursor account into a ranking by
 * measured headroom, where it has no business being.
 */
export const cursorQuotaUnmeasured = 'no quota published';

/* ------------------------------------------------------------------------- *
 * THE SIXTY-DAY FUSE (DROVE-270).
 *
 * A cursor token is a JWT that lives exactly sixty days and CANNOT be renewed
 * — cursor-agent has no refresh flow for one, measured rather than assumed. So
 * the repair is always Clay at a browser, and a warning that arrives after the
 * token dies has arrived too late to be a warning at all. The machine counts
 * the days down in `drover accounts` and puts a card on the bus once a day for
 * the last week; these are the words the phone says for the same countdown, so
 * the two surfaces cannot quote different days.
 *
 * `renew` IS A WORKING STATE. A row in it runs work perfectly well today, which
 * is why the countdown reads as a deadline and never as a fault: colouring it
 * like a broken account would teach Clay to ignore it for the six days it is
 * wrong before the one day it is right.
 * ------------------------------------------------------------------------- */

/** How the machine reports a stored cursor token. Absent means an older daemon
 *  that did not look, which is NOT the same as `missing` — nothing stored. */
export type CursorTokenState =
    | 'live'
    | 'renew'
    | 'expiring'
    | 'expired'
    | 'tombstone'
    | 'unreadable'
    | 'missing';

export type CursorTokenLike = {
    harness?: string | null;
    tokenState?: string | null;
    expiresInDays?: number | null;
};

/** The reported state, or null when the machine did not report one. */
export function cursorTokenState(account: CursorTokenLike | null | undefined): CursorTokenState | null {
    const raw = typeof account?.tokenState === 'string' ? account.tokenState.trim().toLowerCase() : '';
    switch (raw) {
        case 'live':
        case 'renew':
        case 'expiring':
        case 'expired':
        case 'tombstone':
        case 'unreadable':
        case 'missing':
            return raw;
        default:
            return null;
    }
}

/**
 * `renew in 3d`, or null when there is nothing to count down to.
 *
 * Only in the `renew` window, which is the last seven days of the sixty. Shown
 * for the whole sixty it would be wallpaper, and wallpaper is what the last
 * week has to cut through.
 *
 * "today" rather than "in 0d" for the final day, because `0d` reads as a
 * rendering bug at exactly the moment it must not.
 */
export function cursorRenewLabel(account: CursorTokenLike | null | undefined): string | null {
    if (!isCursorAccount(account)) return null;
    if (cursorTokenState(account) !== 'renew') return null;
    const days = account?.expiresInDays;
    if (typeof days !== 'number' || !Number.isFinite(days)) return 'renew soon';
    const whole = Math.max(0, Math.floor(days));
    return whole === 0 ? 'renew today' : `renew in ${whole}d`;
}

/**
 * The one slot a cursor row gets, in order of what Clay has to do about it.
 *
 * A broken login outranks the deadline, and the deadline outranks "no quota
 * published" — which is the steady state and therefore the last thing worth
 * saying. Each broken state names its own repair, because the three have
 * different causes and only one of them is the calendar's fault:
 *
 *   missing    nothing is stored. The login never landed, or the token was
 *              forgotten with the row left behind.
 *   tombstone  somebody signed OUT of Cursor. What is stored is the marker
 *              cursor-agent leaves, not a credential — so blaming expiry here
 *              would send him to check his clock.
 *   expired    the sixty days ran out, and there is no refresh to try.
 *
 * `unreadable` deliberately reads as the steady state: cursor could change its
 * token format, and shouting "broken" at every row over a parse failure would
 * be worse than the format change itself.
 */
export function cursorAccountLabel(account: CursorTokenLike | null | undefined): string {
    switch (cursorTokenState(account)) {
        case 'missing':
            return 'no cursor token — sign in again';
        case 'tombstone':
            return 'signed out of Cursor — sign in again';
        case 'expired':
        case 'expiring':
            return 'login expired — sign in again';
        case 'renew':
            return `${cursorRenewLabel(account)} · ${cursorQuotaUnmeasured}`;
        default:
            return cursorQuotaUnmeasured;
    }
}

/**
 * The same fact in the width a quota bar has, which is a few words.
 *
 * The bar row and the group heading under the composer cannot carry a repair
 * instruction, so they carry the STATE and let the Accounts page say what to do
 * about it. Deliberately not the full sentence truncated: a clipped
 * instruction is worse than none.
 */
export function cursorAccountTrailing(account: CursorTokenLike | null | undefined): string {
    switch (cursorTokenState(account)) {
        case 'missing':
            return 'no cursor token';
        case 'tombstone':
            return 'signed out';
        case 'expired':
        case 'expiring':
            return 'login expired';
        case 'renew':
            return cursorRenewLabel(account) ?? cursorQuotaUnmeasured;
        default:
            return cursorQuotaUnmeasured;
    }
}

/** Can work run on this cursor account? `renew` is YES — it works today. */
export function cursorAccountUsable(account: CursorTokenLike | null | undefined): boolean {
    switch (cursorTokenState(account)) {
        case 'missing':
        case 'tombstone':
        case 'expired':
        case 'expiring':
            return false;
        default:
            // Includes a machine that reported no state at all: an older daemon
            // did not look, and refusing every cursor row over a field it never
            // sent would break the list it used to draw fine.
            return true;
    }
}

/**
 * Every drover account stamped on any known session, sorted.
 *
 * The flip action runs per session row, where rebuilding the list view would
 * be wasteful, so it reads the raw session map instead. Only a stamped account
 * counts; unaccounted sessions contribute nothing.
 */
export function collectDroverAccountsFromSessions(
    sessions: Iterable<{
        metadata?: {
            droverAccount?: string | null;
            droverUsage?: { accounts?: ({ name?: unknown; harness?: string | null } | null)[] | null } | null;
        } | null;
    }>,
): string[] {
    const found = new Set<string>();
    // CURSOR ACCOUNTS ARE NOT FLIP TARGETS (DROVE-270), and this list is a flip
    // picker: `/flip <name>` is a CLAUDE_CONFIG_DIR swap and a respawn, and a
    // cursor account has no directory to swap to. The stamp alone cannot say
    // which is which — it is a bare name — so the harness is read off the usage
    // snapshots the same sessions carry, which is the one place the machine
    // reports it. Collected across ALL sessions before anything is admitted, so
    // a cursor account is excluded even when the only session naming it is not
    // the one that carries the snapshot.
    const cursor = new Set<string>();
    const stamped = new Set<string>();
    for (const session of sessions) {
        const account = session.metadata?.droverAccount;
        if (account) stamped.add(account);
        for (const row of session.metadata?.droverUsage?.accounts ?? []) {
            if (typeof row?.name === 'string' && row.name && isCursorAccount(row)) cursor.add(row.name);
        }
    }
    for (const account of stamped) {
        if (!cursor.has(account)) found.add(account);
    }
    return [...found].sort();
}

/**
 * The chat message that moves a session to another account.
 *
 * There is no flip RPC and there must not be one: happy-cli parses `/flip` out
 * of the message stream before the queue (drover/flip/controller.ts), so a
 * plain message is the whole mechanism. Bare `/flip` lets the CLI pick the next
 * account with headroom; naming one asks for that account. The watch builds the
 * exact same string (sync/droverWatchFeed.ts).
 */
export function droverFlipMessage(account?: string | null): string {
    const name = account?.trim();
    return name ? `/flip ${name}` : '/flip';
}
