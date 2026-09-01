/**
 * Going and LOOKING at an account's headroom, instead of reading whatever the
 * last session happened to leave on disk (DROVE-204).
 *
 * Clay, with the sheet open on five accounts he knew were spent: "I know for a
 * fact it was expired on most of these, so what is wrong with your graphs."
 *
 * Nothing was wrong with the graphs. `readUsageCache` reads Claude Code's own
 * `cachedUsageUtilization`, and NOTHING refreshes it. Measured 2026-08-31 on
 * this machine, against `claude -p /usage` a minute later:
 *
 *     risserproperties  cache 41.8h old  weekly_all 89%  ->  actually 100%
 *     jamrizzi          cache  7.9h old  Fable      93%  ->  actually 100%
 *     account-1         cache  9.0h old  weekly_all 73%  ->  actually  78%
 *     main              no cache at all
 *
 * So an account he had not launched in two days was reported at 11% headroom
 * while it was refusing turns, and every account's `session` row described a
 * five-hour window that had already reset — 99% left on a window that no
 * longer existed.
 *
 * WHAT ACTUALLY REFRESHES IT. Measured against the installed 2.1.251, not
 * assumed:
 *
 *   - `claude doctor`                       does not write the cache
 *   - `claude -p '<prompt>'`                does not write it, even on a turn
 *     that succeeds — print mode never asks
 *   - an interactive TUI, 45s, with a turn  does not write it either, so the
 *     old comment in accounts.ts ("refreshes as every session starts") is not
 *     true of this version
 *   - `claude -p '/usage'`                  DOES write it
 *
 * `/usage` is a local command: `total_cost_usd: 0`, `duration_api_ms: 0`, zero
 * tokens in and out, one GET to /api/oauth/usage, about five seconds wall,
 * nearly all of it CLI startup. It also answers on an account that is at its
 * wall, which a prompt cannot. That is the lighter refresh the ticket asked us
 * to look for, and it means the rest of this is scheduling.
 *
 * Nothing here reads a credential. It spawns Claude Code pointed at an
 * account's config dir and lets Claude Code do what it already does with its
 * own token; drover still never talks to Anthropic.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { logger } from '@/ui/logger'
import {
    droverStateDir,
    isLoggedIn,
    readAccounts,
    readUsageCache,
    readVendorUsageCache,
    type DroverAccount,
} from './accounts'
import { parseUsagePrint, writeReading } from './reading'

/**
 * How often an IDLE account is worth a process.
 *
 * This used to be described as Claude Code's own rewrite floor, and the floor
 * is real -- it will not rewrite `cachedUsageUtilization` inside five minutes
 * of writing it (measured at 11s, 60s and 120s gaps on 2.1.257; the same bytes
 * come back). But it is no longer a CEILING on how fresh a reading can be,
 * because `/usage` fetches live every time and drover now keeps what it
 * printed (DROVE-340, reading.ts). So this is a politeness floor on spawning a
 * six-second process for an account nobody is using, not a limit on accuracy.
 */
export const usageRefreshFloorMs = 5 * 60_000

/**
 * How often the account a session is RUNNING ON is worth a process.
 *
 * Clay: "I need this more frequent than minutes and minutes." Thirty seconds,
 * and the arithmetic is the justification. One refresh is about 6.5s of wall
 * clock with MCP loading off (9.5s with it on), zero tokens, zero cost, one
 * GET -- so a session burning turns costs roughly a fifth of one background
 * process, for exactly one account. It is also gated on ACTIVITY: an idle
 * session spawns nothing at all and falls back to the sweep, so the cost is
 * paid only while there is something to measure.
 */
export const activeRefreshFloorMs = 30_000

/**
 * How old a usable reading may get before it is refreshed anyway.
 *
 * Claude Code's own reader throws its cache away at an hour (`wen = 3600000`),
 * which is the strongest statement available about how long the vendor thinks
 * one of these numbers means anything. Half of that leaves room for a sweep to
 * be late without a reading ever crossing the line the vendor drew.
 */
export const usageRefreshAfterMs = 30 * 60_000

/** How long one `claude -p /usage` gets before it is given up on. */
export const usageRefreshTimeoutMs = 45_000

/**
 * WHICH `claude` to run.
 *
 * Not the bare name off PATH, and that is not caution — it was measured to
 * fail. The happy checkout carries `node_modules/.bin/claude`, a stub that
 * says "claude native binary not installed" and has NO SHEBANG, so exec'ing it
 * is `ENOEXEC`. Anything running under pnpm has that directory at the FRONT of
 * PATH, which is every `pnpm test`, every script, and the daemon whenever it
 * was started from the repo. A refresh that silently fails there would leave
 * exactly the stale numbers this ticket is about, and leave them looking like
 * nobody had tried.
 *
 * So: the explicit override, then the native install Claude Code puts in
 * ~/.local/bin, then the bare name for a machine that keeps it elsewhere.
 */
export function claudeBinary(env: NodeJS.ProcessEnv = process.env): string {
    const named = env.DROVER_CLAUDE?.trim()
    if (named) return named
    const installed = join(env.HOME || homedir(), '.local', 'bin', 'claude')
    if (existsSync(installed)) return installed
    return 'claude'
}

/**
 * The command, split out so the shape is a test rather than a comment.
 *
 * `--tools ''` because a slash command needs none and loading them is most of
 * the startup. `--no-session-persistence` so a refresh does not litter the
 * transcript store with five empty sessions an hour — the resume picker is a
 * surface Clay uses.
 */
export function usageRefreshArgv(claudeBin = claudeBinary()): string[] {
    return [
        claudeBin, '-p', '/usage',
        '--tools', '',
        '--no-session-persistence',
        // A usage refresh must not start the account's MCP servers. Measured
        // on this machine, with 40 of them configured: 9.5s without these two
        // flags, 6.5s with. Correctness as much as speed -- a background
        // process that boots forty servers every thirty seconds is not a
        // progress bar, it is a second workload.
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ]
}

/**
 * The environment that points Claude Code at ONE account.
 *
 * The ambient account is reached by UNSETTING the variable, never by pointing
 * it at ~/.claude — see DroverAccount.ambient, where that mistake costs a
 * login wizard. DROVER_ACCOUNT is dropped because this child is not a session
 * and must not be mistaken for one by anything that reads the stamp.
 */
export function usageRefreshEnv(
    a: DroverAccount,
    base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base }
    delete env.DROVER_ACCOUNT
    if (a.ambient) delete env.CLAUDE_CONFIG_DIR
    else env.CLAUDE_CONFIG_DIR = a.configDir
    return env
}

/**
 * Is it worth spending a process on this account right now?
 *
 * Three answers, in this order, and the order is the point:
 *
 *   - a logged-out account is never worth it: there is no token to ask with
 *     and the child would land in the first-run wizard
 *   - a reading younger than the floor cannot be improved, however wrong it
 *     looks — Claude Code will hand back the same bytes
 *   - otherwise: refresh when there is no reading at all, when any row of it
 *     describes a window that has already reset (the reading is not old, it is
 *     MEANINGLESS), or when the whole thing is older than `after`
 */
export function needsUsageRefresh(
    a: DroverAccount,
    now = Date.now(),
    opts: { after?: number; floor?: number } = {},
): boolean {
    if (!isLoggedIn(a)) return false
    const after = opts.after ?? usageRefreshAfterMs
    const floor = opts.floor ?? usageRefreshFloorMs
    const cache = readUsageCache(a)
    if (!cache) return true
    const fetchedAt = cache.fetchedAt
    if (fetchedAt === null) return true
    const age = now - fetchedAt
    if (age < floor) return false
    if (age >= after) return true
    // A row whose own reset has passed is the case that made an exhausted
    // account read as wide open, so it is chased before the age rule. Parsed
    // here rather than through usage.ts's rowUsable, because usage.ts imports
    // the sweep below and the two files must not import each other.
    return cache.rows.some((row) => {
        const resets = Date.parse(String(row?.resets_at ?? ''))
        return Number.isFinite(resets) && resets <= now
    })
}

export interface UsageRefreshDeps {
    /** Overridden in tests; the default spawns Claude Code. */
    run?: (a: DroverAccount) => Promise<boolean>
    claudeBin?: string
    timeoutMs?: number
    now?: () => number
}

/**
 * Ask Claude Code what this account's headroom is, and KEEP WHAT IT SAID.
 * Resolves true when the process exited cleanly and a reading was recorded.
 *
 * The child's stdout used to go nowhere, on the argument that the value was
 * entirely the side effect on `.claude.json` and that parsing the paragraph
 * would be a second parser of the same fact. Measured, it is not the same
 * fact (DROVE-340, reading.ts): `/usage` fetches live and prints what it
 * fetched, but rewrites its cache at most every five minutes, so the paragraph
 * is routinely minutes fresher than the file. On the account a session is
 * burning down that gap was 15 minutes and 42 percentage points.
 *
 * So the paragraph is parsed and stored as drover's own reading, in the same
 * row shape, and readUsageCache merges the two by age. Still one shape and one
 * reader downstream; the second parser buys the only fresh number available.
 *
 * cwd is the temp dir on purpose: a refresh must not be attributed to whatever
 * project the session happens to be in, and must not trip a trust prompt.
 */
function spawnUsageRefresh(a: DroverAccount, deps: UsageRefreshDeps): Promise<boolean> {
    const argv = usageRefreshArgv(deps.claudeBin ?? 'claude')
    const timeout = deps.timeoutMs ?? usageRefreshTimeoutMs
    const now = deps.now ?? Date.now
    return new Promise<boolean>((resolve) => {
        let child: ReturnType<typeof spawn>
        try {
            child = spawn(argv[0], argv.slice(1), {
                cwd: tmpdir(),
                stdio: ['ignore', 'pipe', 'ignore'],
                env: usageRefreshEnv(a),
            })
        } catch (err) {
            logger.debug('[flip] could not start a usage refresh for ' + a.name, err)
            resolve(false)
            return
        }
        // Capped, because this is a paragraph and anything much larger is a
        // wizard, a stack trace, or a Claude Code that decided to answer the
        // slash command with prose. None of those parse, and none of them
        // should be able to grow a background process's memory.
        let out = ''
        child.stdout?.on('data', (chunk: Buffer | string) => {
            if (out.length < 64_000) out += String(chunk)
        })
        const timer = setTimeout(() => {
            logger.debug('[flip] usage refresh for ' + a.name + ' timed out')
            child.kill('SIGKILL')
        }, timeout)
        timer.unref?.()
        child.on('error', (err) => {
            clearTimeout(timer)
            logger.debug('[flip] usage refresh failed for ' + a.name, err)
            resolve(false)
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            if (code !== 0) {
                resolve(false)
                return
            }
            resolve(recordUsagePrint(a, out, now()))
        })
    })
}

/**
 * Store what the child printed, falling back to Claude Code's own cache when
 * the paragraph carried no rows.
 *
 * The VENDOR cache is the fallback source for a reset the print left off, not
 * `readUsageCache`, because that one already merges in the reading being
 * replaced and would let a stale reset outlive the window it describes.
 *
 * A print that parses to nothing is NOT recorded and the refresh reports
 * false. That keeps "we asked and it said 0%" apart from "we asked and could
 * not read the answer": the second must leave the previous reading in place
 * and let it age honestly, never overwrite it with an empty one.
 */
export function recordUsagePrint(a: DroverAccount, text: string, now: number): boolean {
    const rows = parseUsagePrint(text, now, readVendorUsageCache(a)?.rows ?? [])
    if (!rows) {
        logger.debug('[flip] usage refresh for ' + a.name + ' printed nothing readable')
        return false
    }
    writeReading(droverStateDir(), a.name, rows, now)
    return true
}

export async function refreshUsage(a: DroverAccount, deps: UsageRefreshDeps = {}): Promise<boolean> {
    const run = deps.run ?? ((account: DroverAccount) => spawnUsageRefresh(account, deps))
    return run(a)
}

/**
 * When a sweep last STARTED, on this machine, whoever started it.
 *
 * Several drover sessions run at once and each holds its own reporter, so
 * without this every one of them wakes up, sees the same stale caches, and
 * fires the same five processes. The per-account floor would make four of the
 * five sweeps no-ops eventually, but only after they had all started, which is
 * the stall it exists to avoid. One file, one timestamp, best effort: a
 * corrupt or unwritable one means the sweep goes ahead, because a duplicated
 * sweep is a waste and a skipped one is a wrong number.
 */
function sweepMarkerPath(): string {
    return join(droverStateDir(), 'usage-sweep.json')
}

function sweptRecently(now: number, floor: number): boolean {
    try {
        const at = Number(JSON.parse(readFileSync(sweepMarkerPath(), 'utf8'))?.at)
        return Number.isFinite(at) && now - at >= 0 && now - at < floor
    } catch {
        return false
    }
}

function markSweep(now: number): void {
    try {
        const path = sweepMarkerPath()
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, JSON.stringify({ at: now }))
    } catch (err) {
        logger.debug('[flip] could not record the usage sweep marker', err)
    }
}

export interface UsageSweepOptions extends UsageRefreshDeps {
    now?: () => number
    after?: number
    floor?: number
    accounts?: () => DroverAccount[]
    /** Skip the one-sweep-per-machine marker; set in tests. */
    shared?: boolean
}

/**
 * Refresh every account that is worth refreshing, ONE AT A TIME.
 *
 * Serial rather than parallel, and that is deliberate: five Claude Code
 * startups at once on a laptop that is also running the session is a
 * noticeable stall, and there is nothing to race for — the whole sweep costs
 * about twenty-five seconds of a background process and it happens twice an
 * hour. `now` is asked again between accounts so the floor still applies to an
 * account another session refreshed while this sweep was walking.
 *
 * Returns the names actually refreshed, which is what the log line prints.
 */
export async function sweepUsage(opts: UsageSweepOptions = {}): Promise<string[]> {
    const now = opts.now ?? Date.now
    const list = opts.accounts ?? readAccounts
    const floor = opts.floor ?? usageRefreshFloorMs
    if (opts.shared !== false) {
        if (sweptRecently(now(), floor)) return []
        markSweep(now())
    }
    const done: string[] = []
    for (const a of list()) {
        if (!needsUsageRefresh(a, now(), { after: opts.after, floor })) continue
        const ok = await refreshUsage(a, opts)
        if (ok) done.push(a.name)
    }
    return done
}

/**
 * When THIS account was last asked, on this machine, by whoever asked.
 *
 * The sweep's marker is one timestamp for the whole machine, which is right
 * for a sweep and wrong here: two sessions on two different accounts must both
 * be allowed to refresh their own, and two sessions on the SAME account must
 * not both spawn. So the claim is per account, and the account is the key.
 */
function accountMarkerPath(name: string): string {
    return join(droverStateDir(), 'usage-refresh', encodeURIComponent(name) + '.json')
}

/**
 * Take the right to refresh this account for the next `floor` ms, or say no.
 *
 * Written BEFORE the process starts rather than after it finishes, so the
 * six seconds a refresh takes are covered by the claim. A corrupt or
 * unwritable marker means the refresh goes ahead: a duplicated process is
 * waste, a skipped one is a wrong number on Clay's phone, and the ticket is
 * about the second.
 */
export function claimAccountRefresh(name: string, now: number, floor: number): boolean {
    const path = accountMarkerPath(name)
    try {
        const at = Number(JSON.parse(readFileSync(path, 'utf8'))?.at)
        if (Number.isFinite(at) && now - at >= 0 && now - at < floor) return false
    } catch {
        // No marker, or an unreadable one. Either way nobody holds it.
    }
    try {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, JSON.stringify({ at: now }))
    } catch (err) {
        logger.debug('[flip] could not record the usage refresh claim for ' + name, err)
    }
    return true
}

export interface ActiveRefreshOptions extends UsageRefreshDeps {
    now?: () => number
    floor?: number
    accounts?: () => DroverAccount[]
    /** Skip the per-account claim; set in tests. */
    shared?: boolean
}

/**
 * Refresh ONE account -- the one this session is running on (DROVE-340).
 *
 * Separate from `sweepUsage` because it answers a different question. The
 * sweep asks "is any account's reading old enough to be wrong", which is about
 * the flip picker and can afford ten minutes. This asks "is the number Clay is
 * LOOKING AT the number that is true", which cannot.
 *
 * It deliberately does NOT consult `needsUsageRefresh`. That helper's job is
 * to avoid a wasted process, and it decides by the age of the reading -- which
 * is right for an account nobody is touching and wrong for the one being spent
 * right now, where a thirty-second-old reading is exactly the thing worth
 * replacing. The claim above is what stops the waste instead.
 *
 * Returns true when a fresh reading was written.
 */
export async function refreshActiveAccount(
    name: string | undefined,
    opts: ActiveRefreshOptions = {},
): Promise<boolean> {
    if (!name) return false
    const now = opts.now ?? Date.now
    const list = opts.accounts ?? readAccounts
    const account = list().find((a) => a.name === name)
    // A logged-out account has no token to ask with, and the child would land
    // in the first-run wizard rather than printing a paragraph.
    if (!account || !isLoggedIn(account)) return false
    if (opts.shared !== false && !claimAccountRefresh(name, now(), opts.floor ?? activeRefreshFloorMs)) {
        return false
    }
    return refreshUsage(account, opts)
}
