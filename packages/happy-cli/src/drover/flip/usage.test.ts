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
        writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: `${name}@example.com` } }))
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
            { kind: 'session', percent: 49, resetsAt: Date.parse('2026-08-30T20:20:00.211Z'), scope: null, family: null, usable: true },
            { kind: 'weekly_all', percent: 23, resetsAt: Date.parse('2026-09-05T19:00:00.211Z'), scope: null, family: null, usable: true },
            { kind: 'weekly_scoped', percent: 39, resetsAt: Date.parse('2026-09-05T19:00:00.211Z'), scope: 'Fable', family: 'fable', usable: true },
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

    // The same rule `drover accounts` applies in limits_for (libexec/
    // drover-accounts): no percent is no measurement and the row goes; a
    // percent that is there but is not a number is kept and counts as 0. The
    // two disagreed on both edges once, and then the phone's headroom and the
    // table's could differ on a malformed cache.
    it('counts a malformed row the way drover accounts counts it', async () => {
        const dirs = writeAccounts(['main'])
        const now = Date.parse('2026-08-30T18:00:00Z')
        writeCache(dirs.main, [
            { kind: 'session', percent: null, resets_at: '2026-08-30T21:00:00+00:00', scope: null },
            { kind: 'weekly_all', percent: 'lots', resets_at: '2026-09-03T20:00:00+00:00', scope: null },
            { kind: 'weekly_scoped', percent: 30, resets_at: '2026-09-05T19:00:00+00:00', scope: fable },
        ] as unknown as CacheRow[])
        const { usageSnapshot } = await usageModule()
        const [main] = usageSnapshot('main', now).accounts
        expect(main.limits.map((r) => [r.kind, r.percent])).toEqual([
            ['weekly_all', 0],
            ['weekly_scoped', 30],
        ])
        expect(main.headroom).toBe(70)
        expect(main.cooling).toBeNull()
    })

    it('reads a cache of unreadable percents as measured at nothing used, not as never measured', async () => {
        const dirs = writeAccounts(['main', 'spare'])
        writeCache(dirs.main, [
            { kind: 'session', percent: '49', resets_at: '2026-08-30T21:00:00+00:00', scope: null },
        ] as unknown as CacheRow[])
        // jq's `//` drops false with null; so does the snapshot.
        writeCache(dirs.spare, [
            { kind: 'session', percent: false, resets_at: '2026-08-30T21:00:00+00:00', scope: null },
        ] as unknown as CacheRow[])
        const { usageSnapshot } = await usageModule()
        // Inside the window those rows describe: this test is about parsing a
        // percent, not about a reading whose window has since reset (DROVE-204).
        const [main, spare] = usageSnapshot('main', Date.parse('2026-08-30T18:00:00Z')).accounts
        expect(main.limits).toHaveLength(1)
        expect(main.headroom).toBe(100)
        expect(spare.limits).toEqual([])
        expect(spare.headroom).toBeNull()
    })

    it('clamps headroom to the scale like the table, and leaves the row as the cache wrote it', async () => {
        const dirs = writeAccounts(['main'])
        const now = Date.parse('2026-08-30T18:00:00Z')
        writeCache(dirs.main, [
            { kind: 'session', percent: 120, resets_at: '2026-08-30T21:00:00+00:00', scope: null },
        ])
        const { usageSnapshot } = await usageModule()
        const [main] = usageSnapshot('main', now).accounts
        expect(main.limits[0].percent).toBe(120)
        expect(main.headroom).toBe(0)
        // Over the top is still over the top: the row blocks until it resets.
        expect(main.cooling?.until).toBe(Date.parse('2026-08-30T21:00:00Z'))
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
            sweep: null, active: null,
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
        const reporter = new UsageReporter({ sweep: null, active: null, current: () => where, publish: (u) => published.push(u) })
        reporter.tick()
        where = 'jamrizzi'
        expect(reporter.tick()).toBe(true)
        expect(published[1].accounts.map((a) => [a.name, a.current])).toEqual([
            ['main', false],
            ['jamrizzi', true],
        ])
    })

    // DROVE-173. A mid-session /model from Fable to Opus re-decides which
    // windows bind with no file on disk moving, so the family is in the stamp
    // or the phone keeps the headroom for the model he left.
    it('republishes when the session changes model, with no file having changed', async () => {
        const dirs = writeAccounts(['bitspur.com'])
        writeCache(dirs['bitspur.com'], [
            { kind: 'weekly_all', percent: 58, resets_at: '2026-09-03T03:59:59.603572+00:00', scope: null },
            { kind: 'weekly_scoped', percent: 100, resets_at: '2026-09-03T03:59:59.603838+00:00', scope: fable },
        ])
        let family = 'fable'
        const published: DroverUsage[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter({
            sweep: null, active: null,
            current: () => 'bitspur.com',
            family: () => family,
            publish: (u) => published.push(u),
        })
        reporter.tick()
        expect(published[0].accounts[0].headroom).toBe(0)
        family = 'opus'
        expect(reporter.tick()).toBe(true)
        expect(published[1].modelFamily).toBe('opus')
        expect(published[1].accounts[0].headroom).toBe(42)
    })

    it('re-stamps unchanged data once the snapshot is old enough to misreport freshness', async () => {
        writeAccounts(['main'])
        let clock = Date.parse('2026-08-30T18:00:00Z')
        const published: DroverUsage[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter({ sweep: null, active: null, current: () => 'main', publish: (u) => published.push(u), now: () => clock })
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
        const reporter = new UsageReporter({ sweep: null, active: null, current: () => 'main', publish: (u) => published.push(u), settleMs: 20 })
        reporter.tick()
        writeCache(dirs.main, [{ kind: 'session', percent: 77, resets_at: '2099-01-01T00:00:00+00:00', scope: null }])
        touchLater(join(dirs.main, '.claude.json'), 5)
        for (let i = 0; i < 25; i++) reporter.refresh()
        await new Promise((r) => setTimeout(r, 80))
        expect(published).toHaveLength(2)
        expect(published[1].accounts[0].headroom).toBe(23)
        reporter.stop()
    })
})

/**
 * Headroom for the model this session is actually running (DROVE-173).
 *
 * Clay, with the sheet next to Claude Code's /usage: "bitspur.com · 0% left"
 * on an account whose session was 1% used and whose week had 42% left. The
 * account was out for Fable and he was on Opus, and `100 - max(percent)` over
 * EVERY window read Fable's exhausted week as his wall. At 3:25am the same
 * arithmetic told the flip logic every other account was out of headroom and
 * it stayed on main, which is DROVE-187's half of this.
 */
describe('model-aware headroom', () => {
    // Clay's bitspur.com as measured 2026-08-31, the exact rows behind the
    // screenshot on the ticket.
    const bitspur = [
        { kind: 'session', percent: 1, resets_at: '2026-08-31T12:49:59.603545+00:00', scope: null },
        { kind: 'weekly_all', percent: 58, resets_at: '2026-09-03T03:59:59.603572+00:00', scope: null },
        { kind: 'weekly_scoped', percent: 100, resets_at: '2026-09-03T03:59:59.603838+00:00', scope: fable },
    ]
    const now = Date.parse('2026-08-31T08:00:00Z')

    it('ignores a family window the session is not in', async () => {
        const dirs = writeAccounts(['bitspur.com'])
        writeCache(dirs['bitspur.com'], bitspur)
        const { usageSnapshot } = await usageModule()
        const snap = usageSnapshot('bitspur.com', now, 'opus')
        expect(snap.modelFamily).toBe('opus')
        // The week at 58% used is the wall for Opus, not Fable's dead one.
        expect(snap.accounts[0].headroom).toBe(42)
    })

    it('lets that window bind a session that IS in the family', async () => {
        const dirs = writeAccounts(['bitspur.com'])
        writeCache(dirs['bitspur.com'], bitspur)
        const { usageSnapshot } = await usageModule()
        expect(usageSnapshot('bitspur.com', now, 'fable').accounts[0].headroom).toBe(0)
    })

    it('stays model-blind with no model known, byte for byte what it was', async () => {
        const dirs = writeAccounts(['bitspur.com'])
        writeCache(dirs['bitspur.com'], bitspur)
        const { usageSnapshot } = await usageModule()
        const snap = usageSnapshot('bitspur.com', now)
        expect(snap.modelFamily).toBeNull()
        expect(snap.accounts[0].headroom).toBe(0)
    })

    it('keeps every window on the snapshot, whichever ones it counted', async () => {
        // The rows still all go to the phone: the sheet draws Fable week for
        // an Opus session too, it just does not head the account with it.
        const dirs = writeAccounts(['bitspur.com'])
        writeCache(dirs['bitspur.com'], bitspur)
        const { usageSnapshot } = await usageModule()
        const rows = usageSnapshot('bitspur.com', now, 'opus').accounts[0].limits
        expect(rows.map((r) => r.kind)).toEqual(['session', 'weekly_all', 'weekly_scoped'])
        expect(rows[2]).toMatchObject({ percent: 100, scope: 'Fable', family: 'fable' })
    })
})

describe('headroomOf', () => {
    const rows = [
        { kind: 'session', percent: 1, resetsAt: 1, scope: null, family: null },
        { kind: 'weekly_all', percent: 58, resetsAt: 2, scope: null, family: null },
        { kind: 'weekly_scoped', percent: 100, resetsAt: 3, scope: 'Fable', family: 'fable' },
    ]

    it('is the fullest applying window, and DROVE-187 can ask it directly', async () => {
        const { headroomOf } = await usageModule()
        const { modelDemand, unknownModel, anyModel } = await import('./accounts')
        expect(headroomOf(rows, modelDemand('opus'), 0)).toBe(42)
        expect(headroomOf(rows, modelDemand('fable'), 0)).toBe(0)
        expect(headroomOf(rows, unknownModel, 0)).toBe(0)
        // "is there ANY model left here", the last look before parking: only
        // the unscoped windows count.
        expect(headroomOf(rows, anyModel, 0)).toBe(42)
    })

    it('clamps a cache that overshoots and says nothing with no rows', async () => {
        const { headroomOf } = await usageModule()
        expect(headroomOf([{ kind: 'session', percent: 120, resetsAt: null, scope: null, family: null }])).toBe(0)
        expect(headroomOf([])).toBeNull()
    })

    it('counts an unreadable scope, so a dead account never reads as alive', async () => {
        const { headroomOf } = await usageModule()
        const { modelDemand } = await import('./accounts')
        const odd = [{ kind: 'weekly_scoped', percent: 100, resetsAt: null, scope: 'surface:web', family: null }]
        expect(headroomOf(odd, modelDemand('opus'))).toBe(0)
    })
})

/**
 * A reading older than the window it describes is UNKNOWN, never good news
 * (DROVE-204).
 *
 * Clay's sheet, on five accounts he knew were spent: four marked `stale`,
 * several reading 99% session left. The 99% was real arithmetic on a real row
 * — a `session` row at 1% whose five-hour window had reset three hours
 * earlier. The number described a window that no longer existed.
 *
 * So the rule is not about age, it is about the row's own reset. And it has to
 * bite HEADROOM, not just the label, because headroom is what the flip and
 * DROVE-187's downgrade choose on: "nobody looked" must come out as null, and
 * every reader treats null as not available.
 */
describe('an expired window', () => {
    const capturedAt = Date.parse('2026-08-31T18:00:00Z')
    // Session reset two hours before anyone looked; the week is still open.
    const expiredSession = {
        kind: 'session', percent: 1, resetsAt: Date.parse('2026-08-31T16:00:00Z'), scope: null, family: null,
    }
    const openWeek = {
        kind: 'weekly_all', percent: 58, resetsAt: Date.parse('2026-09-05T19:00:00Z'), scope: null, family: null,
    }

    it('is unusable, and a window still open is not', async () => {
        const { rowUsable } = await usageModule()
        expect(rowUsable(expiredSession, capturedAt)).toBe(false)
        expect(rowUsable(openWeek, capturedAt)).toBe(true)
        // No reset on the row says nothing either way, and says it the same
        // one-way readUsageExhaustion reads the same field.
        expect(rowUsable({ resetsAt: null }, capturedAt)).toBe(true)
    })

    it('makes headroom UNKNOWN rather than the fullest window that survived', async () => {
        const { headroomOf } = await usageModule()
        // 42 is what the open week alone would say, and saying it would send a
        // flip onto an account whose session window nobody has measured.
        expect(headroomOf([expiredSession, openWeek], undefined, capturedAt)).toBeNull()
        expect(headroomOf([openWeek], undefined, capturedAt)).toBe(42)
    })

    it('stops counting once the model in use is not in that window', async () => {
        const { headroomOf } = await usageModule()
        const { modelDemand } = await import('./accounts')
        const expiredFable = {
            kind: 'weekly_scoped',
            percent: 100,
            resetsAt: Date.parse('2026-08-31T16:00:00Z'),
            scope: 'Fable',
            family: 'fable',
        }
        // An Opus session is not in Fable's week, so an expired Fable row is
        // not a hole in what we know about Opus (DROVE-173's rule, unchanged).
        expect(headroomOf([openWeek, expiredFable], modelDemand('opus'), capturedAt)).toBe(42)
        expect(headroomOf([openWeek, expiredFable], modelDemand('fable'), capturedAt)).toBeNull()
    })

    it('marks the row on the wire and empties the account headroom in a snapshot', async () => {
        const dirs = writeAccounts(['risserproperties'])
        writeCache(dirs.risserproperties, [
            { kind: 'session', percent: 1, resets_at: '2026-08-31T16:00:00+00:00', scope: null },
            { kind: 'weekly_all', percent: 58, resets_at: '2026-09-05T19:00:00+00:00', scope: null },
        ])
        const { usageSnapshot } = await usageModule()
        const account = usageSnapshot('risserproperties', capturedAt).accounts[0]
        expect(account.limits.map((r) => r.usable)).toEqual([false, true])
        // The row is still SENT. A limit missing from the one screen Clay is
        // looking at is the older bug; the app draws it with no bar instead.
        expect(account.limits).toHaveLength(2)
        expect(account.headroom).toBeNull()
    })

    it('leaves a reading that is merely old alone', async () => {
        const dirs = writeAccounts(['jamrizzi'])
        writeCache(
            dirs.jamrizzi,
            [
                { kind: 'session', percent: 1, resets_at: '2026-08-31T21:00:00+00:00', scope: null },
                { kind: 'weekly_all', percent: 58, resets_at: '2026-09-05T19:00:00+00:00', scope: null },
            ],
            capturedAt - 3 * 60 * 60_000,
        )
        const { usageSnapshot } = await usageModule()
        const account = usageSnapshot('jamrizzi', capturedAt).accounts[0]
        // Three hours old and every window still open: the figure is a floor
        // rather than a fiction, so it keeps its number and the sheet keeps
        // saying `stale` over it (DROVE-173).
        expect(account.limits.every((r) => r.usable)).toBe(true)
        expect(account.headroom).toBe(42)
    })
})

/**
 * How often the account this session is ON goes and looks (DROVE-340).
 *
 * Clay: "the limit progress cards are constantly out of date, at least the
 * ones for the active session ... I need this more frequent than minutes and
 * minutes." Before this the only thing that went and looked was a ten-minute
 * sweep that treated his account like the four nobody was touching.
 */
describe('the active account cadence', () => {
    function reporterWith(opts: {
        clock: () => number
        asked: { at: number; account: string | undefined }[]
        fresh?: boolean
    }) {
        return {
            sweep: null as null,
            current: () => 'main',
            publish: () => {},
            now: opts.clock,
            active: async (now: number, account: string | undefined) => {
                opts.asked.push({ at: now, account })
                return opts.fresh ?? false
            },
        }
    }

    it('looks every thirty seconds while the transcript is moving', async () => {
        writeAccounts(['main'])
        let clock = Date.parse('2026-09-01T18:00:00Z')
        const asked: { at: number; account: string | undefined }[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter(reporterWith({ clock: () => clock, asked }))

        reporter.tick()
        expect(asked).toHaveLength(1)
        expect(asked[0].account).toBe('main')

        // Inside the floor, even with the transcript moving: one process per
        // thirty seconds, not one per turn.
        clock += 20_000
        reporter.refresh()
        reporter.tick()
        expect(asked).toHaveLength(1)

        // Past it, with activity since the last look: worth a process.
        clock += 15_000
        reporter.refresh()
        reporter.tick()
        expect(asked).toHaveLength(2)
        reporter.stop()
    })

    it('spends nothing on a session that is sitting at a prompt', async () => {
        // The gate that makes thirty seconds affordable. An idle session is
        // burning nothing, so its number cannot have changed, so asking is
        // pure cost — it falls back to the ten-minute sweep, exactly as
        // expensive as it was before this ticket.
        writeAccounts(['main'])
        let clock = Date.parse('2026-09-01T18:00:00Z')
        const asked: { at: number; account: string | undefined }[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter(reporterWith({ clock: () => clock, asked }))
        reporter.tick()
        expect(asked).toHaveLength(1)
        for (let i = 0; i < 20; i++) {
            clock += 60_000
            reporter.tick()
        }
        expect(asked).toHaveLength(1)
        reporter.stop()
    })

    it('counts a long turn as activity all the way through, not only at its first line', async () => {
        // refresh() is called on EVERY transcript line and all but the first
        // return early on the settle guard. If the activity stamp lived below
        // that guard a turn would count as one moment and a long turn would
        // look idle — which is precisely the session Clay watches.
        writeAccounts(['main'])
        let clock = Date.parse('2026-09-01T18:00:00Z')
        const asked: { at: number; account: string | undefined }[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter({
            ...reporterWith({ clock: () => clock, asked }),
            settleMs: 10_000_000,
        })
        reporter.tick()
        expect(asked).toHaveLength(1)
        // One burst of lines schedules one settle; the rest hit the guard.
        for (let i = 0; i < 5; i++) {
            reporter.refresh()
            clock += 10_000
        }
        reporter.tick()
        expect(asked).toHaveLength(2)
        reporter.stop()
    })

    it('publishes the moment a fresh reading lands, without waiting for a poll', async () => {
        // The reading is the thing the phone is waiting for, so the look that
        // produced it ticks again rather than leaving it for thirty seconds.
        const dirs = writeAccounts(['main'])
        writeCache(dirs.main, [{ kind: 'session', percent: 26, resets_at: '2099-01-01T00:00:00+00:00', scope: null }])
        const clock = Date.parse('2026-09-01T18:00:00Z')
        const published: DroverUsage[] = []
        const { UsageReporter } = await usageModule()
        const { readingPath } = await import('./reading')
        const { droverStateDir } = await import('./accounts')
        const reporter = new UsageReporter({
            sweep: null,
            current: () => 'main',
            publish: (u) => published.push(u),
            now: () => clock,
            active: async () => {
                const { writeReading } = await import('./reading')
                writeReading(droverStateDir(), 'main', [
                    { kind: 'session', percent: 68, resets_at: '2099-01-01T00:00:00Z', scope: null },
                ], clock)
                return true
            },
        })
        reporter.tick()
        await new Promise((r) => setTimeout(r, 20))
        // Two publishes: the opening snapshot, then the refreshed one. The
        // second carries the number Claude Code printed but had not written.
        expect(published).toHaveLength(2)
        expect(published[1].accounts[0].headroom).toBe(32)
        expect(readingPath(droverStateDir(), 'main')).toContain('main.json')
        reporter.stop()
    })

    it('never asks when there is no account to ask about', async () => {
        writeAccounts(['main'])
        const clock = Date.parse('2026-09-01T18:00:00Z')
        const asked: { at: number; account: string | undefined }[] = []
        const { UsageReporter } = await usageModule()
        const reporter = new UsageReporter({
            ...reporterWith({ clock: () => clock, asked }),
            current: () => undefined,
        })
        reporter.tick()
        expect(asked).toEqual([])
        reporter.stop()
    })
})
