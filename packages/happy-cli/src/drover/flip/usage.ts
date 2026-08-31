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
    isOnboarded,
    ledgerPath,
    modelDemand,
    readAccounts,
    readLedger,
    readUsageCache,
    unknownModel,
    type DroverAccount,
    type Ledger,
    type ModelDemand,
    type UsageLimitRow,
} from './accounts'
import { familyOfDisplayName } from './limits'
import { sweepUsage } from './refresh'

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
    /**
     * Percent USED, as the cache wrote it. A row whose percent is present but
     * not a number counts as 0, the way `drover accounts` counts it; the app
     * clamps for display.
     */
    percent: number
    /** Epoch ms, or null when the row carries no parseable reset. */
    resetsAt: number | null
    scope: string | null
    family: string | null
    /**
     * Does this row still describe a window that EXISTS? (DROVE-204)
     *
     * False once the window it measures has already reset, at which point the
     * percent is not merely stale, it is meaningless: the thing it counted was
     * emptied and refilled by an unknown amount while nobody was looking. So
     * the app draws no bar and no number for such a row, and headroom for the
     * account is UNKNOWN rather than generous.
     *
     * Carried explicitly rather than left to be re-derived on the phone. The
     * app has only the snapshot's `capturedAt` to compare against; the CLI has
     * the real clock and the row. Optional because a snapshot from an older
     * CLI does not carry it, and absent is read as usable — which is exactly
     * what that CLI meant.
     */
    usable?: boolean
}

/**
 * Is this reading still about a window that exists? (DROVE-204)
 *
 * A row carries the moment its own window resets. Once that moment has passed
 * the number in front of it describes a window that has since been thrown away
 * — Clay's sheet said "99% session left" off a five-hour window that had reset
 * three hours earlier, on accounts that were refusing turns.
 *
 * `resets_at` is the evidence rather than the age, because it is exact. A
 * fifteen-minute-old reading of a window that ended fourteen minutes ago is
 * useless; a two-hour-old reading of a week is not. A row with no parseable
 * reset says nothing either way and is left usable, the same one-way reading
 * readUsageExhaustion takes of the same field.
 */
export function rowUsable(row: Pick<UsageRowSnapshot, 'resetsAt'>, now: number): boolean {
    const resets = row.resetsAt
    if (typeof resets !== 'number' || !Number.isFinite(resets)) return true
    return resets > now
}

export interface AccountUsageSnapshot {
    name: string
    /** The account this session is on. Exactly one row is, when any is. */
    current: boolean
    /** There is a credential here. NOT the same as "a session can start here". */
    loggedIn: boolean
    /**
     * Claude Code's one-time first run is settled for this config dir, so an
     * interactive session reaches a prompt instead of the theme picker
     * (DROVE-246). A credentialed account with this false is a dead end for a
     * flip exactly as `loggedIn: false` is, and needs a different fix
     * (`drover trust`, not another login), which is why it is its own field.
     */
    onboarded: boolean
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
    /**
     * The model family this session is running ("opus"), or null when nothing
     * on disk said (DROVE-173).
     *
     * It rides the snapshot because headroom below is computed FOR it, and the
     * app has to apply the same rule to the wrist's binding limit (DROVE-129).
     * Two readers, one rule; without the family on the wire the app would have
     * to guess, and a guess here is what made a live account read as dead.
     */
    modelFamily: string | null
    accounts: AccountUsageSnapshot[]
}

/**
 * Does this row stand between THIS session and a turn? (DROVE-173)
 *
 * The same question `rowBlocks` in accounts.ts asks of a maxed row, asked of
 * every row so headroom can be computed for the model actually running. An
 * unscoped window (`session`, `weekly_all`) binds every model. A window scoped
 * to a family binds only a session in that family. A scope nobody can read
 * binds, because an unreadable scope must never make a dead account look
 * alive, and an UNKNOWN model binds on everything, which is byte-for-byte
 * what this did before families existed.
 *
 * Clay, with the sheet and /usage side by side: "bitspur.com · 0% left" on an
 * account whose session was 1% used, because Fable's week was exhausted and he
 * was on Opus. At 3:25am the same arithmetic told the flip logic every other
 * account was out of headroom and it stayed put.
 */
export function rowApplies(row: UsageRowSnapshot, demand: ModelDemand): boolean {
    if (!row.scope) return true
    if (demand.kind === 'unknown') return true
    if (!row.family) return true
    if (demand.kind === 'any') return false
    return row.family === demand.family
}

/**
 * Percent LEFT on the fullest window that applies to `demand`, or null when
 * none of them does (DROVE-173).
 *
 * Exported because the flip's own "is there room over there" is the same
 * question (DROVE-187): one function, so the sheet's number and the decision
 * the flip makes on it cannot disagree.
 */
export function headroomOf(
    rows: UsageRowSnapshot[],
    demand: ModelDemand = unknownModel,
    now?: number,
): number | null {
    const applies = rows.filter((r) => rowApplies(r, demand))
    if (!applies.length) return null
    // UNKNOWN BEATS OPTIMISM (DROVE-204). One window whose reading has expired
    // is enough to make the whole number unsafe, because that window could be
    // the one that is full — and headroom is what a flip and DROVE-187's
    // downgrade choose on. "Nobody looked" must never come out as "there is
    // room here"; it comes out as null, and every reader treats null as not
    // available.
    const unusable = applies.some((r) => !usableRow(r, now))
    if (unusable) return null
    // Clamped to the scale the way the table clamps it, so a cache that says
    // 120% reads as 0 left in both places.
    return Math.min(100, Math.max(0, 100 - Math.max(...applies.map((r) => r.percent))))
}

/**
 * The row's own verdict when the snapshot carries one, recomputed against
 * `now` when it does not. Keeps headroomOf callable with bare rows in a test
 * and with wire rows in production without two rules.
 */
function usableRow(row: UsageRowSnapshot, now?: number): boolean {
    if (typeof row.usable === 'boolean') return row.usable
    return rowUsable(row, now ?? Date.now())
}

/**
 * Which rows count, decided the way `drover accounts` decides it (limits_for in
 * libexec/drover-accounts): a row with no percent is not a measurement and is
 * dropped; a row whose percent is present but not a number is kept at 0. It
 * used to be Number(percent) with NaN dropped, which read "abc" the other way
 * round and read null as 0, so on a malformed cache the app's headroom could
 * differ from the table's. Same rule, same number, in both places.
 */
function rowSnapshot(row: UsageLimitRow, now: number): UsageRowSnapshot | null {
    const raw = row?.percent
    // jq's `//` treats false like null, so the shell drops both.
    if (raw === undefined || raw === null || raw === false) return null
    const percent = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    const resets = Date.parse(String(row?.resets_at ?? ''))
    const scope = row?.scope
    const display = scope?.model?.display_name
    // A surface scope has never been observed. It is kept as a scoped row the
    // app can see, with no family, rather than dropped — dropping is how a
    // limit goes missing from the one screen Clay is looking at.
    const scopeName = scope?.surface != null
        ? `surface:${String(scope.surface)}`
        : typeof display === 'string' && display ? display : null
    const resetsAt = Number.isFinite(resets) ? resets : null
    return {
        kind: String(row?.kind ?? 'usage'),
        percent,
        resetsAt,
        scope: scopeName,
        family: scope?.surface == null ? familyOfDisplayName(display) ?? null : null,
        usable: rowUsable({ resetsAt }, now),
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

function accountSnapshot(
    a: DroverAccount,
    ledger: Ledger,
    current: string | undefined,
    now: number,
    demand: ModelDemand,
): AccountUsageSnapshot {
    const cache = readUsageCache(a)
    const limits = (cache?.rows ?? [])
        .map((row) => rowSnapshot(row, now))
        .filter((r): r is UsageRowSnapshot => r !== null)
    const cooling = coolingState(a, ledger, now)
    const family = cooling.until > 0 ? coolingFamilyOf(limits, ledger, a.name, now) : undefined
    return {
        name: a.name,
        current: a.name === current,
        loggedIn: isLoggedIn(a),
        onboarded: isOnboarded(a),
        fetchedAt: cache?.fetchedAt ?? null,
        // 100 minus the fullest row that APPLIES to the model this session is
        // running (DROVE-173), and null when any of those rows has expired
        // (DROVE-204). With no model known that is every row, which is exactly
        // what it was before.
        headroom: headroomOf(limits, demand, now),
        cooling: cooling.until > 0
            ? { until: cooling.until, reason: cooling.reason, ...(family ? { family } : {}) }
            : null,
        limits,
    }
}

/**
 * What every registry account looks like right now, with `current` marked.
 *
 * `family` is the model this session is running, and headroom is computed for
 * it (DROVE-173). Undefined keeps the old, model-blind arithmetic.
 */
export function usageSnapshot(
    current: string | undefined,
    now = Date.now(),
    family?: string | undefined,
): DroverUsage {
    const ledger = readLedger()
    const demand = modelDemand(family)
    return {
        capturedAt: now,
        modelFamily: demand.kind === 'family' ? demand.family : null,
        accounts: readAccounts().map((a) => accountSnapshot(a, ledger, current, now, demand)),
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
/**
 * How often the reporter goes and LOOKS, rather than reading what is on disk
 * (DROVE-204).
 *
 * Ten minutes, and the arithmetic is the whole justification. A sweep costs
 * one `claude -p /usage` per account that needs one — about five seconds of a
 * background process, no tokens, no model call — and it skips any account
 * refreshed in the last five minutes, which is Claude Code's own rewrite
 * floor. Five accounts is therefore at most twenty-five seconds of subprocess
 * per ten minutes, and in the steady state far less, because an account only
 * qualifies once its reading has expired or passed the half-hour mark.
 *
 * Ten minutes also puts a ceiling on how wrong the flip can be: every account's
 * reading is at most that old when the picker reads it, against the 41 hours
 * measured on risserproperties before this existed.
 */
const sweepMs = 10 * 60_000

export interface UsageReporterOptions {
    /** The account this session is on, asked fresh each time — a flip moves it. */
    current: () => string | undefined
    /**
     * The model family this session is running, asked fresh each time — a
     * mid-session /model changes which windows bind (DROVE-173). Undefined
     * from the option or from the call keeps the model-blind arithmetic.
     */
    family?: () => string | undefined
    /** Where the snapshot goes; runClaude points this at session metadata. */
    publish: (usage: DroverUsage) => void
    /** Overridden in tests. */
    now?: () => number
    pollMs?: number
    settleMs?: number
    /**
     * Go and look at accounts nobody has looked at (DROVE-204). Overridden in
     * tests, and set to null to turn the sweep off entirely — a session under
     * test must not spawn five Claude Codes.
     */
    sweep?: ((now: number) => Promise<string[]>) | null
    sweepMs?: number
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
    private readonly family: () => string | undefined
    private readonly publish: (usage: DroverUsage) => void
    private readonly now: () => number
    private readonly pollEvery: number
    private readonly settle: number
    private readonly sweeper: ((now: number) => Promise<string[]>) | null
    private readonly sweepEvery: number

    private stamp = ''
    private signature = ''
    private publishedAt = 0
    private sweptAt = 0
    private sweeping = false
    private settleTimer: NodeJS.Timeout | null = null
    private pollTimer: NodeJS.Timeout | null = null
    private stopped = false

    constructor(opts: UsageReporterOptions) {
        this.current = opts.current
        this.family = opts.family ?? (() => undefined)
        this.publish = opts.publish
        this.now = opts.now ?? Date.now
        this.pollEvery = opts.pollMs ?? pollMs
        this.settle = opts.settleMs ?? settleMs
        // DROVER_USAGE_REFRESH=0 turns the going-and-looking off and leaves
        // the reading-what-is-on-disk on. One switch, because the sweep spawns
        // processes on Clay's laptop and a feature that spawns processes needs
        // an off.
        this.sweeper = opts.sweep === undefined
            ? (process.env.DROVER_USAGE_REFRESH === '0'
                ? null
                : (now: number) => sweepUsage({ now: () => now }))
            : opts.sweep
        this.sweepEvery = opts.sweepMs ?? sweepMs
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
            this.maybeSweep(now)
            const stale = now - this.publishedAt >= refreshIntervalMs
            const stamp = this.stampOf()
            if (stamp === this.stamp && !stale) return false
            this.stamp = stamp
            const usage = usageSnapshot(this.current(), now, this.family())
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

    /**
     * Start a sweep if one is due, and never wait for it (DROVE-204).
     *
     * `tick` is synchronous on purpose — a flip calls it and then relaunches —
     * so the sweep cannot be awaited here. It is fired and forgotten; when it
     * lands, the account config files have moved and the very next poll sees
     * new mtimes and publishes. One at a time, because five Claude Code
     * startups on top of each other is a stall Clay would feel.
     */
    private maybeSweep(now: number): void {
        if (!this.sweeper || this.sweeping) return
        if (this.sweptAt !== 0 && now - this.sweptAt < this.sweepEvery) return
        this.sweeping = true
        this.sweptAt = now
        void this.sweeper(now)
            .then((names) => {
                if (names.length) logger.debug('[flip] refreshed usage for ' + names.join(', '))
                // Look again straight away: the sweep is the one thing that
                // MOVED a cache file, so waiting a full poll to notice would
                // leave the phone on the numbers we just replaced.
                if (!this.stopped) this.tick()
            })
            .catch((err) => logger.debug('[flip] usage sweep failed (ignored)', err))
            .finally(() => {
                this.sweeping = false
            })
    }

    /** What could have changed the answer, cheaply: file mtimes and who we are. */
    private stampOf(): string {
        // The family is in the stamp because it changes the ANSWER: a /model
        // from Fable to Opus re-decides which windows bind (DROVE-173), with
        // no file on disk moving.
        const parts: string[] = [this.current() ?? '', this.family() ?? '']
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
