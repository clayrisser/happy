/**
 * The FRESH reading, which Claude Code prints but refuses to write down
 * (DROVE-340).
 *
 * Clay, tonight: "the limit progress cards are constantly out of date, at
 * least the ones for the active session ... I need this more frequent than
 * minutes and minutes."
 *
 * DROVE-204 found the refresh -- `claude -p /usage` -- and read its result off
 * `cachedUsageUtilization` afterwards, deliberately NOT parsing the paragraph
 * because "a second parser of the same fact" is what readUsageCache exists to
 * prevent. That was the right instinct about one fact and wrong about which
 * fact this is, and the difference is the whole ticket.
 *
 * MEASURED against the installed 2.1.257, on an account actively burning its
 * session window:
 *
 *     cache before   fetchedAtMs 1788303039947   session 68
 *     printed        "Current session: 70% used, resets Sep 2 at 4:20am"
 *     cache after    fetchedAtMs 1788303039947   session 68   (byte-identical)
 *
 * So `/usage` fetches LIVE every time and prints what it fetched. What it
 * throttles is only the WRITE: it will not rewrite its own cache inside five
 * minutes of writing it (confirmed at 11s, 60s and 120s gaps -- the same bytes
 * come back every time). The paragraph and the cache are therefore not the
 * same fact. The paragraph is the reading; the cache is a five-minute-old copy
 * of an earlier one.
 *
 * That is why the cards were minutes stale, and no amount of scheduling could
 * have fixed it: DROVE-204's sweep was reading the copy. Measured on this
 * machine while the ticket was filed, the ACTIVE account's cache was 15.4
 * minutes old and said the session was 26% used when it was 68%.
 *
 * So the paragraph is parsed here into exactly the row shape readUsageCache
 * already returns, and written to drover's own state. `readUsageCache` then
 * hands back whichever of the two readings is NEWER. Every consumer --
 * headroom, the bars, the wrist, the flip picker, `drover accounts` -- is
 * untouched and gets the fresher number for free, which keeps DROVE-129's one
 * derivation intact: still one shape, still one reader.
 *
 * Nothing here talks to Anthropic and nothing here reads a credential. It
 * parses stdout from a Claude Code pointed at an account's config dir, the
 * same child DROVE-204 already spawned.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from '@/ui/logger'
import type { UsageCache, UsageLimitRow } from './accounts'

/**
 * Where drover keeps its own readings.
 *
 * Its OWN state dir, never the account's `.claude.json`. Writing into that
 * file would be a read-modify-write race against a live Claude Code that
 * rewrites the whole thing, and losing a credential out of a config file to
 * make a progress bar move faster is not a trade worth making.
 */
export function readingPath(stateDir: string, name: string): string {
    return join(stateDir, 'usage', encodeURIComponent(name) + '.json')
}

/**
 * The three lines `/usage` prints, as they actually appear:
 *
 *     Current session: 70% used, resets Sep 2 at 4:20am (Europe/London)
 *     Current week (all models): 14% used, resets Sep 3 at 10am (Europe/London)
 *     Current week (Fable): 24% used, resets Sep 3 at 10am (Europe/London)
 *
 * The reset clause is optional on purpose: a percent with no reset is still
 * worth having, and `rowUsable` reads a missing reset as "says nothing either
 * way", the same one-way reading the rest of the flip code takes.
 */
const lineRe = /^Current\s+(session|week)\s*(?:\(([^)]*)\))?\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used(?:.*?resets\s+(.+?))?\s*$/i

/** "Sep 2 at 4:20am (Europe/London)", and "10am" with the minutes left off. */
const resetRe = /^([A-Za-z]{3,})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i

const months = [
    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]

/**
 * A named zone's offset AT a given instant, in ms.
 *
 * Asked of Intl rather than assumed, because the paragraph names a zone that
 * is nearly never the machine's -- Claude Code printed Europe/London on a Mac
 * running CDT -- and DROVE-173 already spent a night on a five-hour offset
 * that looked like staleness.
 */
function zoneOffsetAt(zone: string, ms: number): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(ms))
    const at: Record<string, string> = {}
    for (const p of parts) at[p.type] = p.value
    const asUtc = Date.UTC(
        Number(at.year), Number(at.month) - 1, Number(at.day),
        Number(at.hour) % 24, Number(at.minute), Number(at.second),
    )
    return asUtc - ms
}

/**
 * A wall-clock time in a named zone, as an instant.
 *
 * Two passes because the offset depends on the instant being looked for: the
 * first guess picks an offset, and applying it can move the result across a
 * DST boundary into a different one. Two passes settle every case except the
 * ambiguous hour a fall-back repeats, where either answer is one hour out and
 * a usage window does not care.
 */
function zonedEpoch(zone: string, y: number, mo: number, d: number, h: number, mi: number): number {
    const guess = Date.UTC(y, mo, d, h, mi)
    const first = zoneOffsetAt(zone, guess)
    const ms = guess - first
    const second = zoneOffsetAt(zone, ms)
    return second === first ? ms : guess - second
}

/**
 * The reset clause as epoch ms, or null when it will not parse.
 *
 * The year is missing from the printed form, so it is CHOSEN: the candidate
 * that lands in the future and soonest. Every window Claude Code reports is a
 * session (five hours) or a week, so the true answer is always within about
 * eight days, and that is what makes choosing safe across a new year -- on
 * Dec 31 the printed "Jan 2" is next year's, and only next year's candidate is
 * both future and close.
 */
export function parseResetClause(clause: string | undefined, now: number): number | null {
    if (!clause) return null
    const m = resetRe.exec(clause.trim())
    if (!m) return null
    const mo = months.indexOf(m[1].slice(0, 3).toLowerCase())
    if (mo < 0) return null
    const day = Number(m[2])
    let hour = Number(m[3])
    const min = m[4] ? Number(m[4]) : 0
    const half = m[5]?.toLowerCase()
    if (half === 'pm' && hour < 12) hour += 12
    if (half === 'am' && hour === 12) hour = 0
    // No zone printed means the clock is the machine's own, which is what the
    // Date constructor reads. Everything observed so far names one.
    const zone = m[6]?.trim()
    const year = new Date(now).getUTCFullYear()
    let best: number | null = null
    for (const y of [year - 1, year, year + 1]) {
        let ms: number
        try {
            ms = zone ? zonedEpoch(zone, y, mo, day, hour, min) : new Date(y, mo, day, hour, min).getTime()
        } catch {
            return null
        }
        if (!Number.isFinite(ms) || ms <= now) continue
        if (best === null || ms < best) best = ms
    }
    return best
}

/**
 * Turn what `/usage` printed into the rows readUsageCache already returns.
 *
 * Returns null when the text carries no recognisable row at all, which is how
 * a refusal, a first-run wizard or a changed output format is told from a
 * genuine reading. An EMPTY row list would read downstream as "measured, and
 * there are no limits", which is the most generous possible lie.
 *
 * `fallback` is the account's existing rows, used ONLY for a reset the print
 * did not carry. The percent is never taken from it: a fresh percent beside a
 * remembered reset is the honest combination, and the reverse is the bug this
 * ticket is about.
 */
export function parseUsagePrint(
    text: string,
    now: number,
    fallback: UsageLimitRow[] = [],
): UsageLimitRow[] | null {
    const rows: UsageLimitRow[] = []
    for (const raw of text.split(/\r?\n/)) {
        const m = lineRe.exec(raw.trim())
        if (!m) continue
        const scope = m[2]?.trim()
        const scoped = !!scope && scope.toLowerCase() !== 'all models'
        const kind = m[1].toLowerCase() === 'session'
            ? 'session'
            : (scoped ? 'weekly_scoped' : 'weekly_all')
        const percent = Number(m[3])
        if (!Number.isFinite(percent)) continue
        const prior = fallback.find((row) => {
            if (String(row?.kind ?? '') !== kind) return false
            if (!scoped) return true
            const name = row?.scope?.model?.display_name
            return typeof name === 'string' && name.trim().toLowerCase() === scope.toLowerCase()
        })
        const printed = parseResetClause(m[4], now)
        const remembered = Date.parse(String(prior?.resets_at ?? ''))
        const resets = printed ?? (Number.isFinite(remembered) ? remembered : null)
        const row: UsageLimitRow = { kind, percent }
        if (resets !== null) row.resets_at = new Date(resets).toISOString()
        // An unscoped row carries scope: null exactly as the cache writes it,
        // because rowBlocks tells "no scope" (binds every model) from "a scope
        // I cannot read" (binds too, for safety) and the two must not merge.
        row.scope = scoped ? { model: { display_name: scope } } : null
        rows.push(row)
    }
    return rows.length ? rows : null
}

/** Drover's own reading for one account, or null when there is none. */
export function readReading(stateDir: string, name: string): UsageCache | null {
    try {
        const path = readingPath(stateDir, name)
        if (!existsSync(path)) return null
        const raw = JSON.parse(readFileSync(path, 'utf8')) as { fetchedAt?: unknown; rows?: unknown }
        if (!Array.isArray(raw?.rows)) return null
        const fetchedAt = Number(raw?.fetchedAt)
        return {
            fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : null,
            rows: raw.rows.filter((row): row is UsageLimitRow => !!row && typeof row === 'object'),
        }
    } catch (err) {
        logger.debug('[flip] could not read the drover usage reading for ' + name, err)
        return null
    }
}

/** Write one, best effort. A reading that will not save is not worth a crash. */
export function writeReading(stateDir: string, name: string, rows: UsageLimitRow[], now: number): void {
    try {
        const path = readingPath(stateDir, name)
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, JSON.stringify({ fetchedAt: now, rows }))
    } catch (err) {
        logger.debug('[flip] could not record the drover usage reading for ' + name, err)
    }
}

/**
 * Whichever reading is newer.
 *
 * A reading with no `fetchedAt` cannot claim to be newer than one that has a
 * timestamp -- it loses every comparison rather than being treated as now.
 * Claude Code's own cache wins ties, because on the tick that wrote both they
 * are the same numbers and the vendor's is the one everything already agreed
 * about.
 */
export function fresherReading(vendor: UsageCache | null, ours: UsageCache | null): UsageCache | null {
    if (!vendor) return ours
    if (!ours) return vendor
    const a = vendor.fetchedAt
    const b = ours.fetchedAt
    if (b === null) return vendor
    if (a === null) return ours
    return b > a ? ours : vendor
}
