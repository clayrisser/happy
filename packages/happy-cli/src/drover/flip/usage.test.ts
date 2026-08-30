/**
 * The usage strip's feed (DROVE-47): cache rows in, one snapshot out.
 *
 * What these pin down is the contract with the phone, which cannot be driven
 * from here: `current` marks exactly the account the session is on, `headroom`
 * is the number `drover accounts` prints, a scoped row keeps its family, and
 * the reporter publishes when something moved and stays quiet when nothing did.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DroverUsage } from './usage'

let root: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-usage-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_ACCOUNTS = join(root, 'accounts.json')
    process.env.DROVER_URL = 'http://127.0.0.1:1'
    delete process.env.DROVER_ACCOUNT
    delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

function writeAccounts(names: string[]): Record<string, string> {
    const dirs: Record<string, string> = {}
    const registry = names.map((name) => {
        const configDir = join(root, name)
        dirs[name] = configDir
        mkdirSync(configDir, { recursive: true })
        writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${name}@example.com` } }))
        return { name, configDir }
    })
    writeFileSync(process.env.DROVER_ACCOUNTS!, JSON.stringify(registry))
    return dirs
}

interface CacheRow {
    kind: string
    percent: number
    resets_at: string | null
    scope?: { model?: { id: null; display_name: string } | null; surface?: unknown } | null
}

/** The shape Claude Code writes, fetchedAtMs included. */
function writeCache(configDir: string, limits: CacheRow[], fetchedAtMs = 1_700_000_000_000): void {
    const cfg = join(configDir, '.claude.json')
    const raw = JSON.parse(readFileSync(cfg, 'utf8'))
    raw.cachedUsageUtilization = { fetchedAtMs, utilization: { limits } }
    writeFileSync(cfg, JSON.stringify(raw))
}

/** mtime resolution is coarse; make sure a rewrite reads as a change. */
function touchLater(path: string, seconds: number): void {
    const t = new Date(Date.now() + seconds * 1000)
    utimesSync(path, t, t)
}

const fable = { model: { id: null as null, display_name: 'Fable' } }

async function usageModule() {
    return await import('./usage')
}

describe('the usage snapshot', () => {
    it('carries every registry account, marks the current one, and keeps the rest', async () => {
        const dirs = writeAccounts(['main', 'jamrizzi', 'spare'])
        const now = Date.parse('2026-08-30T18:00:00Z')
        writeCache(dirs.main, [
            { kind: 'session', percent: 4, resets_at: '2026-08-30T21:00:00.193338+00:00', scope: null },
            { kind: 'weekly_all', percent: 100, resets_at: '2026-09-03T20:00:00.193364+00:00', scope: null },
            { kind: 'weekly_scoped', percent: 100, resets_at: '2026-09-03T20:00:00.193630+00:00', scope: fable },
        ])
        writeCache(dirs.jamrizzi, [
            { kind: 'session', percent: 49, resets_at: '2026-08-30T20:20:00.211299+00:00', scope: null },
            { kind: 'weekly_all', percent: 23, resets_at: '2026-09-05T19:00:00.211331+00:00', scope: null },
            { kind: 'weekly_scoped', percent: 39, resets_at: '2026-09-05T19:00:00.211802+00:00', scope: fable },
        ])
        const { usageSnapshot } = await usageModule()
        const snap = usageSnapshot('jamrizzi', now)

        expect(snap.capturedAt).toBe(now)
        expect(snap.accounts.map((a) => a.name)).toEqual(['main', 'jamrizzi', 'spare'])
        expect(snap.accounts.map((a) => a.current)).toEqual([false, true, false])

        const jam = snap.accounts[1]
        // 100 minus the fullest row: session at 49, exactly what the picker sorts on.
        expect(jam.headroom).toBe(51)
        expect(jam.cooling).toBeNull()
        expect(jam.fetchedAt).toBe(1_700_000_000_000)
        expect(jam.limits).toEqual([
            { kind: 'session', percent: 49, resetsAt: Date.parse('2026-08-30T20:20:00.211Z'), scope: null, family: null },
            { kind: 'weekly_all', percent: 23, resetsAt: Date.parse('2026-09-05T19:00:00.211Z'), scope: null, family: null },
            { kind: 'weekly_scoped', percent: 39, resetsAt: Date.parse('2026-09-05T19:00:00.211Z'), scope: 'Fable', family: 'fable' },
        ])

        const main = snap.accounts[0]
        expect(main.headroom).toBe(0)
        // Blocked until the LAST maxed row clears; the account-wide row is
        // what is quoted, and with weekly_all at 100% no family is named.
        expect(main.cooling).toEqual({
            until: Date.parse('2026-09-03T20:00:00.193Z'),
            reason: 'weekly limit at 100% (Claude Code\'s own usage cache)',
        })

        // Never measured is null, not zero and not a hundred.
        const spare = snap.accounts[2]
        expect(spare.headroom).toBeNull()
        expect(spare.fetchedAt).toBeNull()
        expect(spare.limits).toEqual([])
        expect(spare.cooling).toBeNull()
    })

    it('names the family when only one model is out', async () => {
        const dirs = writeAccounts(['main'])
        const now = Date.parse('2026-08-30T18:00:00Z')
        writeCache(dirs.main, [
            { kind: 'session', percent: 2, resets_at: '2026-08-30T21:00:00+00:00', scope: null },
            { kind: 'weekly_all', percent: 60, resets_at: '2026-09-03T20:00:00+00:00', scope: null },
            { kind: 'weekly_scoped', percent: 100, resets_at: '2026-09-04T05:00:00+00:00', scope: fable },
        ])
        const { usageSnapshot } = await usageModule()
        const [main] = usageSnapshot('main', now).accounts
        expect(main.current).toBe(true)
        expect(main.headroom).toBe(0)
        expect(main.cooling).toEqual({
            until: Date.parse('2026-09-04T05:00:00Z'),
            reason: 'Fable weekly limit at 100% (Claude Code\'s own usage cache)',
            family: 'fable',
        })
    })

    it('reads a limit the ledger watched happen, not only what the cache measured', async () => {
        const dirs = writeAccounts(['main'])
        const now = Date.parse('2026-08-30T18:00:00Z')
        writeCache(dirs.main, [{ kind: 'session', percent: 10, resets_at: '2026-08-30T21:00:00+00:00', scope: null }])
        const { setCooldown } = await import('./accounts')
        setCooldown('main', now + 60 * 60 * 1000, "You've reached your Fable 5 limit.", 'fable')
        const { usageSnapshot } = await usageModule()
        const [main] = usageSnapshot('main', now).accounts
        expect(main.headroom).toBe(90)
        expect(main.cooling).toEqual({
            until: now + 60 * 60 * 1000,
            reason: "You've reached your Fable 5 limit.",
            family: 'fable',
        })
    })

    it('marks nothing current when the session is on no registered account', async () => {
        writeAccounts(['main'])
        const { usageSnapshot } = await usageModule()
        expect(usageSnapshot(undefined).accounts.map((a) => a.current)).toEqual([false])
    })
})

describe('the usage reporter', () => {
    it('publishes once on start and stays quiet until something moves', async () => {
        const dirs = writeAccounts(['main', 'jamrizzi'])
        writeCache(dirs.main, [{ kind: 'session', percent: 10, resets_at: '2026-08-30T21:00:00+00:00', scope: null }])
        let clock = Date.parse('2026-08-30T18:00:00Z')
        const published: DroverUsage[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter({
            current: () => 'main',
            publish: (u) => published.push(u),
            now: () => clock,
        })

        expect(reporter.tick()).toBe(true)
        expect(published).toHaveLength(1)
        expect(published[0].accounts.find((a) => a.current)?.name).toBe('main')

        // Nothing changed: same stamp, same answer, no traffic.
        clock += 10_000
        expect(reporter.tick()).toBe(false)
        expect(published).toHaveLength(1)

        // The cache moved (a turn ended somewhere): the new number goes out.
        writeCache(dirs.main, [{ kind: 'session', percent: 42, resets_at: '2026-08-30T21:00:00+00:00', scope: null }])
        touchLater(join(dirs.main, '.claude.json'), 5)
        clock += 10_000
        expect(reporter.tick()).toBe(true)
        expect(published).toHaveLength(2)
        expect(published[1].accounts[0].headroom).toBe(58)

        // A rewrite that changed nothing but the mtime is not news.
        touchLater(join(dirs.main, '.claude.json'), 10)
        clock += 10_000
        expect(reporter.tick()).toBe(false)
        expect(published).toHaveLength(2)

        reporter.stop()
        expect(reporter.tick()).toBe(false)
    })

    it('follows the session to the account a flip moved it to', async () => {
        writeAccounts(['main', 'jamrizzi'])
        let where = 'main'
        const published: DroverUsage[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter({ current: () => where, publish: (u) => published.push(u) })
        reporter.tick()
        where = 'jamrizzi'
        expect(reporter.tick()).toBe(true)
        expect(published[1].accounts.map((a) => [a.name, a.current])).toEqual([
            ['main', false],
            ['jamrizzi', true],
        ])
    })

    it('re-stamps unchanged data once the snapshot is old enough to misreport freshness', async () => {
        writeAccounts(['main'])
        let clock = Date.parse('2026-08-30T18:00:00Z')
        const published: DroverUsage[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter({ current: () => 'main', publish: (u) => published.push(u), now: () => clock })
        reporter.tick()
        clock += 4 * 60_000
        expect(reporter.tick()).toBe(false)
        clock += 2 * 60_000
        expect(reporter.tick()).toBe(true)
        expect(published[1].capturedAt).toBe(clock)
    })

    it('coalesces a burst of refresh requests into one look', async () => {
        const dirs = writeAccounts(['main'])
        const published: DroverUsage[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter({ current: () => 'main', publish: (u) => published.push(u), settleMs: 20 })
        reporter.tick()
        writeCache(dirs.main, [{ kind: 'session', percent: 77, resets_at: '2026-08-30T21:00:00+00:00', scope: null }])
        touchLater(join(dirs.main, '.claude.json'), 5)
        for (let i = 0; i < 25; i++) reporter.refresh()
        await new Promise((r) => setTimeout(r, 80))
        expect(published).toHaveLength(2)
        expect(published[1].accounts[0].headroom).toBe(23)
        reporter.stop()
    })
})
