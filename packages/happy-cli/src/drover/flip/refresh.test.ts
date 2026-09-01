/**
 * Going and looking, and knowing when it is worth it (DROVE-204).
 *
 * Clay: "I know for a fact it was expired on most of these, so what is wrong
 * with your graphs." Nothing was wrong with the graphs — nothing refreshed the
 * numbers behind them. What these pin down is the decision to spend a process:
 * a reading whose window has already reset is chased, one Claude Code will
 * refuse to rewrite is not, and a logged-out account is never asked.
 *
 * The three cases the ticket names are here as three tests, and they are the
 * whole shape of the fix: OLDER THAN ITS WINDOW, OLD BUT INSIDE ITS WINDOW,
 * and FRESH.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DroverAccount } from './accounts'

let root: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-refresh-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

const now = Date.parse('2026-08-31T18:00:00Z')

interface Row {
    kind: string
    percent: number
    resets_at: string | null
}

function writeAccount(name: string, opts: {
    loggedIn?: boolean
    /**
     * Claude Code's one-time first run settled for this dir (DROVE-246).
     * Defaults TRUE, because a fixture that means "a normal working account"
     * has to look like one; pass false to model the account Clay was stranded
     * on — a real credential in a directory that has never run interactively.
     */
    onboarded?: boolean
    fetchedAtMs?: number | null
    rows?: Row[]
} = {}): void {
    const configDir = join(root, name)
    mkdirSync(configDir, { recursive: true })
    const raw: Record<string, unknown> = {}
    if (opts.onboarded !== false) raw.hasCompletedOnboarding = true
    if (opts.loggedIn !== false) raw.oauthAccount = { emailAddress: `${name}@example.com` }
    if (opts.rows) {
        raw.cachedUsageUtilization = {
            ...(opts.fetchedAtMs === null ? {} : { fetchedAtMs: opts.fetchedAtMs ?? now }),
            utilization: { limits: opts.rows },
        }
    }
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify(raw))
    const registry = JSON.parse(
        (() => {
            try {
                return readFileSync(process.env.DROVER_ACCOUNTS!, 'utf8')
            } catch {
                return '[]'
            }
        })(),
    ) as { name: string; configDir: string }[]
    registry.push({ name, configDir })
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(registry))
}

async function mod() {
    return await import('./refresh')
}

/** An hour before `now`, so age never decides on its own. */
const anHourAgo = now - 60 * 60_000

describe('needsUsageRefresh', () => {
    it('chases a reading whose window has already reset', async () => {
        // The bug in one row: session at 1%, and the five hours it counted
        // ended two hours before anyone looked. Not stale — meaningless.
        writeAccount('risserproperties', {
            fetchedAtMs: anHourAgo,
            rows: [
                { kind: 'session', percent: 1, resets_at: '2026-08-31T16:00:00Z' },
                { kind: 'weekly_all', percent: 58, resets_at: '2026-09-05T19:00:00Z' },
            ],
        })
        const { needsUsageRefresh } = await mod()
        const { readAccounts } = await import('./accounts')
        expect(needsUsageRefresh(readAccounts()[0], now)).toBe(true)
    })

    it('leaves a reading that is old but still inside every window it describes', async () => {
        // Twenty minutes old — past the five-minute floor, under the
        // half-hour mark — with both windows still open. Worth a `stale` label
        // on the sheet, which DROVE-173 gives it, not worth a process.
        writeAccount('jamrizzi', {
            fetchedAtMs: now - 20 * 60_000,
            rows: [
                { kind: 'session', percent: 1, resets_at: '2026-08-31T21:00:00Z' },
                { kind: 'weekly_all', percent: 58, resets_at: '2026-09-05T19:00:00Z' },
            ],
        })
        const { needsUsageRefresh } = await mod()
        const { readAccounts } = await import('./accounts')
        expect(needsUsageRefresh(readAccounts()[0], now)).toBe(false)
    })

    it('leaves a fresh reading alone, however wrong it looks', async () => {
        // Claude Code will not rewrite a cache younger than five minutes, so
        // asking again returns the same bytes and costs a process for nothing.
        writeAccount('main', {
            fetchedAtMs: now - 60_000,
            rows: [{ kind: 'session', percent: 1, resets_at: '2026-08-31T16:00:00Z' }],
        })
        const { needsUsageRefresh } = await mod()
        const { readAccounts } = await import('./accounts')
        expect(needsUsageRefresh(readAccounts()[0], now)).toBe(false)
    })

    it('asks when there is no reading at all, and never asks a logged-out account', async () => {
        writeAccount('never-run')
        writeAccount('nologin', { loggedIn: false })
        const { needsUsageRefresh } = await mod()
        const { readAccounts } = await import('./accounts')
        const [never, nologin] = readAccounts()
        expect(needsUsageRefresh(never, now)).toBe(true)
        // No token to ask with; the child would land in the first-run wizard.
        expect(needsUsageRefresh(nologin, now)).toBe(false)
    })

    it('refreshes a reading past the half-hour mark even with every window open', async () => {
        writeAccount('bitspur.com', {
            fetchedAtMs: now - 31 * 60_000,
            rows: [{ kind: 'weekly_all', percent: 58, resets_at: '2026-09-05T19:00:00Z' }],
        })
        const { needsUsageRefresh } = await mod()
        const { readAccounts } = await import('./accounts')
        expect(needsUsageRefresh(readAccounts()[0], now)).toBe(true)
    })
})

describe('the refresh command', () => {
    it('is the local /usage command, with no tools, no MCP servers and no session left behind', async () => {
        const { usageRefreshArgv } = await mod()
        // `-p /usage` is what was measured to write the cache: zero tokens,
        // zero cost, no model call. A prompt does not, on this version.
        //
        // The MCP flags are DROVE-340 and they are correctness as much as
        // speed. Measured on Clay's machine with 40 servers configured: 9.5s
        // per refresh without them, 6.5s with. At a thirty-second cadence a
        // refresh that booted forty servers would not be a progress bar, it
        // would be a second workload.
        expect(usageRefreshArgv('claude')).toEqual([
            'claude', '-p', '/usage', '--tools', '', '--no-session-persistence',
            '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        ])
    })

    it('never trusts the bare name on PATH, because pnpm shadows it with a stub', async () => {
        const { claudeBinary } = await mod()
        // Measured: happy's own node_modules/.bin/claude is a shebang-less
        // stub, pnpm puts that directory first on PATH, and exec'ing it is
        // ENOEXEC. A refresh that dies there leaves exactly the stale numbers
        // this ticket is about.
        expect(claudeBinary({ DROVER_CLAUDE: '/opt/claude' })).toBe('/opt/claude')
        expect(claudeBinary({ HOME: root })).toBe('claude')
        mkdirSync(join(root, '.local', 'bin'), { recursive: true })
        writeFileSync(join(root, '.local', 'bin', 'claude'), '')
        expect(claudeBinary({ HOME: root })).toBe(join(root, '.local', 'bin', 'claude'))
    })

    it('points at one account, and reaches the ambient one by UNSETTING the variable', async () => {
        const { usageRefreshEnv } = await mod()
        const scoped: DroverAccount = { name: 'jamrizzi', configDir: '/home/c/.claude-accounts/jamrizzi' }
        const ambient: DroverAccount = { name: 'main', configDir: '/home/c/.claude', ambient: true }
        const base = { CLAUDE_CONFIG_DIR: '/somewhere/else', DROVER_ACCOUNT: 'main' }
        expect(usageRefreshEnv(scoped, base).CLAUDE_CONFIG_DIR).toBe('/home/c/.claude-accounts/jamrizzi')
        // Pointing it at ~/.claude is a brand-new, never-logged-in account —
        // see DroverAccount.ambient. It has to be absent, not set.
        expect('CLAUDE_CONFIG_DIR' in usageRefreshEnv(ambient, base)).toBe(false)
        // Not a session, so nothing downstream may read it as one.
        expect(usageRefreshEnv(scoped, base).DROVER_ACCOUNT).toBeUndefined()
    })
})

describe('sweepUsage', () => {
    it('refreshes only the accounts that need it, one at a time', async () => {
        writeAccount('fresh', {
            fetchedAtMs: now - 60_000,
            rows: [{ kind: 'weekly_all', percent: 10, resets_at: '2026-09-05T19:00:00Z' }],
        })
        writeAccount('expired', {
            fetchedAtMs: anHourAgo,
            rows: [{ kind: 'session', percent: 1, resets_at: '2026-08-31T16:00:00Z' }],
        })
        writeAccount('cold')
        const { sweepUsage } = await mod()
        const order: string[] = []
        let inFlight = 0
        let overlapped = false
        const done = await sweepUsage({
            shared: false,
            now: () => now,
            run: async (a) => {
                inFlight += 1
                if (inFlight > 1) overlapped = true
                order.push(a.name)
                await new Promise((r) => setTimeout(r, 1))
                inFlight -= 1
                return true
            },
        })
        expect(order).toEqual(['expired', 'cold'])
        expect(done).toEqual(['expired', 'cold'])
        // Five Claude Code startups at once is a stall Clay would feel.
        expect(overlapped).toBe(false)
    })

    it('reports only what actually refreshed, so a failure is not counted as a look', async () => {
        writeAccount('cold')
        const { sweepUsage } = await mod()
        expect(await sweepUsage({ shared: false, now: () => now, run: async () => false })).toEqual([])
    })
})

describe('the machine-wide sweep marker', () => {
    it('lets one session sweep and the rest read what it wrote', async () => {
        // Several drover sessions each hold a reporter. Without this every one
        // of them wakes, sees the same stale caches and fires the same five
        // processes at once.
        writeAccount('cold')
        const { sweepUsage } = await mod()
        const ran: string[] = []
        const run = async (a: DroverAccount) => {
            ran.push(a.name)
            return true
        }
        expect(await sweepUsage({ now: () => now, run })).toEqual(['cold'])
        expect(await sweepUsage({ now: () => now, run })).toEqual([])
        // Past the floor it is somebody's turn again.
        expect(await sweepUsage({ now: () => now + 5 * 60_000, run })).toEqual(['cold'])
        expect(ran).toEqual(['cold', 'cold'])
    })
})

describe('recording what /usage printed (DROVE-340)', () => {
    /**
     * The measurement the ticket rests on. Claude Code will not rewrite its
     * own cache inside five minutes (pinned on 2.1.257 at 11s, 60s, 120s and
     * 180s gaps; it moved at 330s), but `/usage` fetches live every time. So
     * the paragraph is fresher than the file, and the sheet was reading the
     * file.
     */
    it('keeps the printed number when the vendor cache is frozen behind it', async () => {
        writeAccount('bitspur.com', {
            fetchedAtMs: now - 15 * 60_000,
            rows: [{ kind: 'session', percent: 26, resets_at: '2026-09-01T04:20:00Z' }],
        })
        const { recordUsagePrint } = await mod()
        const { readAccounts, readUsageCache, readVendorUsageCache } = await import('./accounts')
        const account = readAccounts()[0]
        expect(recordUsagePrint(account, 'Current session: 68% used', now)).toBe(true)
        // The vendor's copy is untouched — nothing here writes .claude.json.
        expect(readVendorUsageCache(account)!.rows[0].percent).toBe(26)
        // What every consumer reads is the newer one.
        const merged = readUsageCache(account)!
        expect(merged.fetchedAt).toBe(now)
        expect(merged.rows[0].percent).toBe(68)
    })

    it('leaves the previous reading standing when the print is unreadable', async () => {
        // "We asked and could not read the answer" is not "we asked and it
        // said nothing". Overwriting with an empty reading would erase a real
        // number and report success.
        writeAccount('bitspur.com', {
            fetchedAtMs: now - 15 * 60_000,
            rows: [{ kind: 'session', percent: 26, resets_at: '2026-09-01T04:20:00Z' }],
        })
        const { recordUsagePrint } = await mod()
        const { readAccounts, readUsageCache } = await import('./accounts')
        const account = readAccounts()[0]
        expect(recordUsagePrint(account, 'Please run /login to continue', now)).toBe(false)
        expect(readUsageCache(account)!.rows[0].percent).toBe(26)
    })

    it('borrows the reset the print left off from the vendor cache, never the percent', async () => {
        writeAccount('bitspur.com', {
            fetchedAtMs: now - 15 * 60_000,
            rows: [{ kind: 'session', percent: 26, resets_at: '2026-09-05T04:20:00Z' }],
        })
        const { recordUsagePrint } = await mod()
        const { readAccounts, readUsageCache } = await import('./accounts')
        const account = readAccounts()[0]
        recordUsagePrint(readAccounts()[0], 'Current session: 68% used', now)
        const row = readUsageCache(readAccounts()[0])!.rows[0]
        expect(row.percent).toBe(68)
        expect(row.resets_at).toBe('2026-09-05T04:20:00.000Z')
        expect(account.name).toBe('bitspur.com')
    })
})

describe('refreshActiveAccount (DROVE-340)', () => {
    it('refreshes the named account without asking how old its reading is', async () => {
        // The sweep asks "is this old enough to be wrong", which is right for
        // an account nobody is touching. For the one being spent right now a
        // thirty-second-old reading is exactly the thing worth replacing.
        writeAccount('live', {
            fetchedAtMs: now - 10_000,
            rows: [{ kind: 'session', percent: 5, resets_at: '2026-09-05T19:00:00Z' }],
        })
        const { refreshActiveAccount, needsUsageRefresh } = await mod()
        const { readAccounts } = await import('./accounts')
        expect(needsUsageRefresh(readAccounts()[0], now)).toBe(false)
        const asked: string[] = []
        expect(await refreshActiveAccount('live', {
            shared: false,
            now: () => now,
            run: async (a) => { asked.push(a.name); return true },
        })).toBe(true)
        expect(asked).toEqual(['live'])
    })

    it('never spends a process on a logged-out account, or on no account at all', async () => {
        writeAccount('empty', { loggedIn: false })
        const { refreshActiveAccount } = await mod()
        const run = async () => true
        expect(await refreshActiveAccount('empty', { shared: false, now: () => now, run })).toBe(false)
        expect(await refreshActiveAccount(undefined, { shared: false, now: () => now, run })).toBe(false)
        expect(await refreshActiveAccount('stranger', { shared: false, now: () => now, run })).toBe(false)
    })
})

describe('the per-account refresh claim (DROVE-340)', () => {
    it('lets two sessions on DIFFERENT accounts both refresh, and one of two on the same', async () => {
        // The sweep's marker is one timestamp for the whole machine, which
        // would stop a second session refreshing its own, different account.
        writeAccount('a')
        writeAccount('b')
        const { refreshActiveAccount } = await mod()
        const ran: string[] = []
        const run = async (a: DroverAccount) => { ran.push(a.name); return true }
        expect(await refreshActiveAccount('a', { now: () => now, run })).toBe(true)
        expect(await refreshActiveAccount('b', { now: () => now, run })).toBe(true)
        // A second session on 'a', in the same window, does not spawn again.
        expect(await refreshActiveAccount('a', { now: () => now, run })).toBe(false)
        expect(ran).toEqual(['a', 'b'])
        // Past the floor it is somebody's turn again.
        expect(await refreshActiveAccount('a', { now: () => now + 30_000, run })).toBe(true)
        expect(ran).toEqual(['a', 'b', 'a'])
    })
})
