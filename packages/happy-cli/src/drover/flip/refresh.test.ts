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
    it('is the local /usage command, with no tools and no session left behind', async () => {
        const { usageRefreshArgv } = await mod()
        // `-p /usage` is what was measured to write the cache: zero tokens,
        // zero cost, no model call. A prompt does not, on this version.
        expect(usageRefreshArgv('claude')).toEqual([
            'claude', '-p', '/usage', '--tools', '', '--no-session-persistence',
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
