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
    type DroverAccount,
} from './accounts'

/**
 * Claude Code will not rewrite the cache it just wrote for five minutes
 * (`Ten = 300000` in the 2.1.251 bundle, the guard in front of the config
 * write). So a reading younger than that CANNOT be improved by asking again,
 * and asking is a wasted process. This is the floor, not a target.
 */
export const usageRefreshFloorMs = 5 * 60_000

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
    return [claudeBin, '-p', '/usage', '--tools', '', '--no-session-persistence']
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
}

/**
 * Ask Claude Code what this account's headroom is, and let it write its own
 * cache. Resolves true when the process exited cleanly.
 *
 * The child's output goes nowhere. `/usage` prints a paragraph for a human;
 * the value is entirely the side effect on `.claude.json`, which every reader
 * here already knows how to parse. Parsing the paragraph as well would be a
 * second parser of the same fact, which is the thing readUsageCache exists to
 * prevent.
 *
 * cwd is the temp dir on purpose: a refresh must not be attributed to whatever
 * project the session happens to be in, and must not trip a trust prompt.
 */
function spawnUsageRefresh(a: DroverAccount, deps: UsageRefreshDeps): Promise<boolean> {
    const argv = usageRefreshArgv(deps.claudeBin ?? 'claude')
    const timeout = deps.timeoutMs ?? usageRefreshTimeoutMs
    return new Promise<boolean>((resolve) => {
        let child: ReturnType<typeof spawn>
        try {
            child = spawn(argv[0], argv.slice(1), {
                cwd: tmpdir(),
                stdio: 'ignore',
                env: usageRefreshEnv(a),
            })
        } catch (err) {
            logger.debug('[flip] could not start a usage refresh for ' + a.name, err)
            resolve(false)
            return
        }
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
            resolve(code === 0)
        })
    })
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
