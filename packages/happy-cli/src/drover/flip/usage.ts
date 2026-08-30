/**
 * Every account's headroom, carried to the app on the session (DROVE-47).
 *
 * Happy fills the strip under the composer from the SDK's rate_limit_event and
 * the get_usage flush in claudeRemote.ts. That is the REMOTE path only. Under
 * one mode (DROVE-1) every session is a Claude Code TUI in a tmux pane, so the
 * stream never exists and the strip stayed blank — Clay, 2026-08-30: "shouldn't
 * all my quotas and limits and stuff show here".
 *
 * Meanwhile the flip picker and `drover accounts` already print, per account,
 * percent left and when each model family is back, read from Claude Code's own
 * `cachedUsageUtilization` in each account's .claude.json. That reading is
 * readUsageCache in accounts.ts, and it is the ONLY parser: this file turns
 * those rows into one snapshot and puts it on the session's metadata, the same
 * channel the droverAccount stamp rides. Nothing here talks to Anthropic.
 *
 * The whole registry goes, not just the account this session is on, so the
 * phone can answer "where can I flip to" without a terminal. The app folds the
 * other accounts away; it does not drop them.
 */

import { statSync } from 'node:fs'

import { logger } from '@/ui/logger'
import {
    accountConfigFile,
    coolingState,
    cooldownFamily,
    isLoggedIn,
    ledgerPath,
    readAccounts,
    readLedger,
    readUsageCache,
    type DroverAccount,
    type Ledger,
    type UsageLimitRow,
} from './accounts'
import { familyOfDisplayName } from './limits'

/**
 * One usage row, reduced to what a phone can render.
 *
 * `scope` is the display name the cache put on the row ("Fable"), kept as
 * written so the app can print it. `family` is that name reduced by the same
 * rule the picker uses, or null for an account-wide row — and ALSO null for a
 * scoped row nobody can classify, which is the conservative reading everything
 * else here takes. The app tells the two apart by `scope`.
 */
export interface UsageRowSnapshot {
    /** `session`, `weekly_all`, `weekly_scoped`, … as Claude Code names them. */
    kind: string
    /** Percent USED, 0-100, the way the cache and the app's colour thresholds both count. */
    percent: number
    /** Epoch ms, or null when the row carries no parseable reset. */
    resetsAt: number | null
    scope: string | null
    family: string | null
}

export interface AccountUsageSnapshot {
    name: string
    /** The account this session is on. Exactly one row is, when any is. */
    current: boolean
    loggedIn: boolean
    /** When Claude Code last fetched this account's cache; null when it never has. */
    fetchedAt: number | null
    /**
     * Percent LEFT on the fullest limit, or null when nothing was ever
     * measured. The same arithmetic as `drover accounts` (100 minus the highest
     * percent in the cache), so the phone and the picker print one number.
     */
    headroom: number | null
    /**
     * When the account expects headroom again and why, merged from the ledger
     * and the cache exactly as the picker merges them; null when it has some
     * now. `family` names the one model that is out, when both sources agree
     * on one, and is absent when the whole account is.
     */
    cooling: { until: number; reason: string; family?: string } | null
    limits: UsageRowSnapshot[]
}

export interface DroverUsage {
    capturedAt: number
    accounts: AccountUsageSnapshot[]
}

function rowSnapshot(row: UsageLimitRow): UsageRowSnapshot | null {
    const percent = Number(row?.percent)
    if (!Number.isFinite(percent)) return null
    const resets = Date.parse(String(row?.resets_at ?? ''))
    const scope = row?.scope
    const display = scope?.model?.display_name
    // A surface scope has never been observed. It is kept as a scoped row the
    // app can see, with no family, rather than dropped — dropping is how a
    // limit goes missing from the one screen Clay is looking at.
    const scopeName = scope?.surface != null
        ? `surface:${String(scope.surface)}`
        : typeof display === 'string' && display ? display : null
    return {
        kind: String(row?.kind ?? 'usage'),
        percent: Math.min(100, Math.max(0, percent)),
        resetsAt: Number.isFinite(resets) ? resets : null,
        scope: scopeName,
        family: scope?.surface == null ? familyOfDisplayName(display) ?? null : null,
    }
}

/**
 * The one family a cooling account is out for, or undefined for all of them.
 *
 * Same two-source agreement `drover accounts` prints in its STATE column: the
 * maxed cache rows must all be scoped to one family AND the ledger entry, if
 * there is one still in force, must name that same family. Either source
 * saying "everything" wins, because "Fable back Thu 05:00" on an account that
 * is out for Opus too would send a session there to hit the wall.
 */
function coolingFamilyOf(rows: UsageRowSnapshot[], ledger: Ledger, name: string, now: number): string | undefined {
    const families = new Set<string>()
    for (const r of rows) {
        if (r.percent < 100 || r.resetsAt === null || r.resetsAt <= now) continue
        if (!r.family) return undefined
        families.add(r.family)
    }
    const recorded = ledger[name]
    if (recorded && recorded.until > now) {
        const f = cooldownFamily(recorded)
        if (!f) return undefined
        families.add(f)
    }
    return families.size === 1 ? [...families][0] : undefined
}

function accountSnapshot(a: DroverAccount, ledger: Ledger, current: string | undefined, now: number): AccountUsageSnapshot {
    const cache = readUsageCache(a)
    const limits = (cache?.rows ?? []).map(rowSnapshot).filter((r): r is UsageRowSnapshot => r !== null)
    const cooling = coolingState(a, ledger, now)
    const family = cooling.until > 0 ? coolingFamilyOf(limits, ledger, a.name, now) : undefined
    return {
        name: a.name,
        current: a.name === current,
        loggedIn: isLoggedIn(a),
        fetchedAt: cache?.fetchedAt ?? null,
        headroom: limits.length ? 100 - Math.max(...limits.map((r) => r.percent)) : null,
        cooling: cooling.until > 0
            ? { until: cooling.until, reason: cooling.reason, ...(family ? { family } : {}) }
            : null,
        limits,
    }
}

/** What every registry account looks like right now, with `current` marked. */
export function usageSnapshot(current: string | undefined, now = Date.now()): DroverUsage {
    const ledger = readLedger()
    return {
        capturedAt: now,
        accounts: readAccounts().map((a) => accountSnapshot(a, ledger, current, now)),
    }
}

/**
 * Identical data is still re-stamped this often, so the snapshot's capturedAt
 * (the app's "as of") does not misreport freshness. Same interval the remote
 * path uses for the same reason.
 */
const refreshIntervalMs = 5 * 60_000
/**
 * How often the cache files are looked at without being asked. Cheap — one
 * stat per account plus the ledger — and it is what catches an account being
 * refreshed by a DIFFERENT session, which no transcript in this one will say.
 */
const pollMs = 30_000
/**
 * A transcript emits many messages per turn, and each one asks for a refresh.
 * They are coalesced into one look shortly after the last, so a turn costs one
 * stat pass, not one per line.
 */
const settleMs = 1_500

export interface UsageReporterOptions {
    /** The account this session is on, asked fresh each time — a flip moves it. */
    current: () => string | undefined
    /** Where the snapshot goes; runClaude points this at session metadata. */
    publish: (usage: DroverUsage) => void
    /** Overridden in tests. */
    now?: () => number
    pollMs?: number
    settleMs?: number
}

/**
 * Keeps the app's copy of the snapshot in step with what is on disk.
 *
 * Publishes on start, then whenever a cache file, the ledger, or the account
 * this session is on has changed since the last look — a look being a stat of
 * each file, and a full re-read only when a stat moved. Asked to look by the
 * transcript scanner (a turn ending, a limit notice landing) and by a flip,
 * and it looks on its own every `pollMs` for changes made by someone else.
 */
export class UsageReporter {
    private readonly current: () => string | undefined
    private readonly publish: (usage: DroverUsage) => void
    private readonly now: () => number
    private readonly pollEvery: number
    private readonly settle: number

    private stamp = ''
    private signature = ''
    private publishedAt = 0
    private settleTimer: NodeJS.Timeout | null = null
    private pollTimer: NodeJS.Timeout | null = null
    private stopped = false

    constructor(opts: UsageReporterOptions) {
        this.current = opts.current
        this.publish = opts.publish
        this.now = opts.now ?? Date.now
        this.pollEvery = opts.pollMs ?? pollMs
        this.settle = opts.settleMs ?? settleMs
    }

    start(): void {
        if (this.stopped || this.pollTimer) return
        this.tick()
        this.pollTimer = setInterval(() => this.tick(), this.pollEvery)
        // Never the reason the process stays alive.
        this.pollTimer.unref?.()
    }

    stop(): void {
        this.stopped = true
        if (this.pollTimer) clearInterval(this.pollTimer)
        if (this.settleTimer) clearTimeout(this.settleTimer)
        this.pollTimer = null
        this.settleTimer = null
    }

    /** Something may have changed; look soon, once, however many times this is called. */
    refresh(): void {
        if (this.stopped || this.settleTimer) return
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null
            this.tick()
        }, this.settle)
        this.settleTimer.unref?.()
    }

    /**
     * Look now. Returns true when a snapshot went out. Synchronous so a test
     * can drive it without timers, and so a flip's refresh lands before the
     * relaunch rather than racing it.
     */
    tick(): boolean {
        if (this.stopped) return false
        try {
            const now = this.now()
            const stale = now - this.publishedAt >= refreshIntervalMs
            const stamp = this.stampOf()
            if (stamp === this.stamp && !stale) return false
            this.stamp = stamp
            const usage = usageSnapshot(this.current(), now)
            const signature = JSON.stringify(usage.accounts)
            if (signature === this.signature && !stale) return false
            this.signature = signature
            this.publishedAt = now
            this.publish(usage)
            return true
        } catch (err) {
            // Best effort, always. A strip that is a little stale beats a
            // session that dies because a config file was mid-write.
            logger.debug('[flip] usage snapshot failed (ignored)', err)
            return false
        }
    }

    /** What could have changed the answer, cheaply: file mtimes and who we are. */
    private stampOf(): string {
        const parts: string[] = [this.current() ?? '']
        const mtime = (path: string) => {
            try {
                return String(statSync(path).mtimeMs)
            } catch {
                return '-'
            }
        }
        for (const a of readAccounts()) parts.push(a.name, mtime(accountConfigFile(a)))
        parts.push(mtime(ledgerPath()))
        return parts.join('\0')
    }
}
