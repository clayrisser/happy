/**
 * HOW LONG A CURSOR LOGIN HAS LEFT, and nothing else about it (DROVE-270).
 *
 * A cursor token is a JWT with a sixty-day life and NO REFRESH FLOW — measured,
 * not assumed: `exp - iat` is exactly 5184000 on every token drover has minted,
 * and cursor-agent has no redemption call to extend one. So the only repair is
 * Clay at a browser, and a warning that arrives after the token dies has
 * arrived too late to be a warning. `lib/drover-cursor-auth.sh` puts a card on
 * the bus once a day for the last week and counts the days down in `drover
 * accounts`; this is the same countdown, read the same way, so the phone shows
 * the figure the terminal shows.
 *
 * NO SECRET LEAVES THIS FILE, and that is the constraint the whole design
 * answers. The store holds a live credential, so every export below returns a
 * STATE and a DAY COUNT — never the token, never the object it sits in. Nothing
 * here logs, and nothing here returns a value a caller could reassemble a token
 * from. That is what lets `usage.ts` put the answer on a session's metadata,
 * which travels to the phone, while `machineAccounts.ts` keeps its promise that
 * no credential passes through the account readers.
 *
 * READ IN PROCESS, like every other account fact in this CLI. Shelling out to
 * `drover accounts --json` would be a second reader that can disagree with the
 * flip picker, and it would make the list fail on a machine whose wrapper is
 * not where the daemon thinks it is. The constants below are therefore kept
 * deliberately identical to the shell's, and named after it, so a drift shows
 * up as a diff rather than as two screens quoting different days.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { droverStateDir } from './messageLedger'

/**
 * Where the tokens live. NOT accounts.json: that registry is committed as an
 * example, is hand-edited, and every reader of it is documented as never
 * touching a credential. `DROVER_CURSOR_AUTH` is the same override
 * lib/drover-cursor-auth.sh takes, so a test or a per-machine layout moves both
 * halves at once.
 */
export function cursorAuthStorePath(): string {
    const explicit = process.env.DROVER_CURSOR_AUTH
    if (explicit && explicit.length > 0) return explicit
    return join(droverStateDir(), 'cursor-auth.json')
}

/**
 * How a stored cursor credential is doing.
 *
 * `renew` IS A WORKING TOKEN and the distinction is the entire point: it is
 * reported apart from `live` because the repair needs a human at a browser and
 * has to be asked for while the thing still works. Everything deciding "can
 * work go here" treats renew as yes.
 *
 * `tombstone` is not a lapse. cursor-agent leaves an epoch-expired stub behind
 * when an account signs out, so calling that "expired" would blame the calendar
 * for something that happened to the account — and send Clay to check his
 * clock instead of to sign in.
 *
 * `unreadable` counts as usable on purpose: cursor could change its token
 * format, and refusing every session over a parse failure would be a worse
 * outage than trying and being told no.
 */
export type CursorTokenState =
    | 'live'
    | 'renew'
    | 'expiring'
    | 'expired'
    | 'tombstone'
    | 'unreadable'
    | 'missing'

/** Anything claiming to expire before this is a MARKER, not a credential.
 *  2000-01-01: cursor did not exist, so no real session token carries it. */
export const cursorTombstoneBefore = 946684800

/**
 * How much warning a dead-end credential gets. Seven days out of sixty.
 *
 * Long enough that a week of not looking at the phone still leaves a day, short
 * enough that it is not background noise for eight weeks. It is also more than
 * one weekend, so a warning raised on a Friday is still standing on Monday.
 */
export function cursorRenewWithin(): number {
    const raw = Number(process.env.DROVER_CURSOR_RENEW_WITHIN)
    return Number.isFinite(raw) && raw > 0 ? raw : 604800
}

/**
 * The `exp` claim, in seconds, or null.
 *
 * Decoded LOCALLY and never verified, because the signature is Cursor's to
 * check and this is not an authorization decision — it is a countdown on a
 * screen. base64url is re-padded by hand; a JWT segment is stripped of `=`.
 */
function tokenExpiry(token: string): number | null {
    const segment = token.split('.')[1]
    if (!segment) return null
    try {
        const b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
        const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown
        if (!claims || typeof claims !== 'object') return null
        const exp = (claims as { exp?: unknown }).exp
        return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
    } catch {
        return null
    }
}

/** The state of a token string. Split out so it is testable without a store. */
export function cursorTokenStateOf(token: string | null | undefined, now = Date.now()): CursorTokenState {
    if (!token) return 'missing'
    const exp = tokenExpiry(token)
    if (exp === null) return 'unreadable'
    if (exp < cursorTombstoneBefore) return 'tombstone'
    const seconds = Math.floor(now / 1000)
    if (exp <= seconds) return 'expired'
    // The same 300-second margin cursor-agent uses internally, so drover's idea
    // of "too close to start work on" matches the one that will refuse it.
    if (exp - seconds < 300) return 'expiring'
    if (exp - seconds < cursorRenewWithin()) return 'renew'
    return 'live'
}

/** Whole days until a token dies, rounded DOWN, or null when there is no date.
 *  Down, because "1 day left" on something with eleven hours left is the lie
 *  that costs Clay the account. */
export function cursorTokenDaysLeftOf(token: string | null | undefined, now = Date.now()): number | null {
    if (!token) return null
    const exp = tokenExpiry(token)
    if (exp === null || exp < cursorTombstoneBefore) return null
    const left = exp - Math.floor(now / 1000)
    return left <= 0 ? 0 : Math.floor(left / 86400)
}

/** What the store holds for one account, with the secret already discarded. */
export interface CursorTokenReading {
    state: CursorTokenState
    /** Whole days until expiry, or null for a token with no readable date. */
    daysLeft: number | null
}

/**
 * Read the whole store once, then answer per account.
 *
 * One read for a list of accounts rather than one per row: `usageSnapshot` runs
 * on every session start and every account poll, and re-reading and re-parsing
 * a credential file six times is six times the window in which it is in memory.
 */
export function readCursorTokens(now = Date.now()): Map<string, CursorTokenReading> {
    const out = new Map<string, CursorTokenReading>()
    let parsed: unknown
    try {
        parsed = JSON.parse(readFileSync(cursorAuthStorePath(), 'utf8'))
    } catch {
        // No store, unreadable store, or a store this process may not open. All
        // three mean the same thing to a caller: nothing is known here. Never
        // logged — the path is fine to say, but a parse error from a credential
        // file is not something to put in a log line's context.
        return out
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
        const token = entry && typeof entry === 'object'
            ? (entry as { token?: unknown }).token
            : undefined
        const raw = typeof token === 'string' ? token : null
        out.set(name, {
            state: cursorTokenStateOf(raw, now),
            daysLeft: cursorTokenDaysLeftOf(raw, now),
        })
    }
    return out
}

/** Nothing stored, said once so every caller spells the absence the same. */
export const cursorTokenMissing: CursorTokenReading = { state: 'missing', daysLeft: null }

/**
 * Can a session run on this token?
 *
 * The one field a caller deciding "send work here" should read. `renew` is yes
 * — it works, it simply has a deadline — and `unreadable` is yes for the reason
 * given on the type above.
 */
export function cursorTokenUsable(state: CursorTokenState): boolean {
    return state === 'live' || state === 'renew' || state === 'unreadable'
}
