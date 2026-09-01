/**
 * The reading Claude Code prints but will not write down (DROVE-340).
 *
 * These pin the measurement the whole ticket rests on: `/usage` fetches live
 * every time and prints what it fetched, while it rewrites its own cache at
 * most every five minutes. So the paragraph is routinely fresher than the
 * file, and the sheet was showing the file.
 *
 * The fixtures are the real output, character for character, including the
 * middle dot and the zone Claude Code prints that is not the machine's.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
    fresherReading,
    parseResetClause,
    parseUsagePrint,
    readReading,
    writeReading,
} from './reading'

let root: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-reading-'))
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

/** Measured 2026-09-01 against Claude Code 2.1.257, copied verbatim. */
const printed = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 70% used · resets Sep 2 at 4:20am (Europe/London)',
    'Current week (all models): 14% used · resets Sep 3 at 10am (Europe/London)',
    'Current week (Fable): 24% used · resets Sep 3 at 10am (Europe/London)',
    '',
    "What's contributing to your limits usage?",
    'Last 24h · 31340 requests · 13 sessions',
    '  100% of your usage came from subagent-heavy sessions',
].join('\n')

const now = Date.parse('2026-09-01T22:30:00Z')

describe('parseUsagePrint', () => {
    it('reads the three windows out of what /usage actually printed', () => {
        const rows = parseUsagePrint(printed, now)
        expect(rows).not.toBeNull()
        expect(rows!.map((r) => [r.kind, r.percent])).toEqual([
            ['session', 70],
            ['weekly_all', 14],
            ['weekly_scoped', 24],
        ])
    })

    it('keeps the model name on a scoped row and leaves an unscoped one null', () => {
        // rowBlocks tells "no scope" (binds every model) from "a scope I
        // cannot read" (binds too, for safety). Collapsing the two would make
        // a Fable-only wall stop an Opus session, which is DROVE-173.
        const rows = parseUsagePrint(printed, now)!
        expect(rows[0].scope).toBeNull()
        expect(rows[1].scope).toBeNull()
        expect(rows[2].scope).toEqual({ model: { display_name: 'Fable' } })
    })

    it('resolves the printed reset in the zone Claude Code named, not the machine s', () => {
        // 4:20am Europe/London on Sep 2 is 03:20Z, because London was on BST.
        // DROVE-173 spent a night on exactly this five-hour gap reading as
        // staleness, so it is pinned rather than trusted.
        const rows = parseUsagePrint(printed, now)!
        expect(rows[0].resets_at).toBe('2026-09-02T03:20:00.000Z')
        expect(rows[1].resets_at).toBe('2026-09-03T09:00:00.000Z')
    })

    it('refuses text that carries no row, rather than reporting no limits', () => {
        // A refusal, a first-run wizard or a changed format must not be
        // recorded as "measured, and there are no limits" — the most generous
        // possible lie, and the one that sends a flip at an exhausted account.
        expect(parseUsagePrint('Please run /login to continue', now)).toBeNull()
        expect(parseUsagePrint('', now)).toBeNull()
    })

    it('takes a reset from the previous rows when the print carries none', () => {
        const rows = parseUsagePrint('Current session: 5% used', now, [
            { kind: 'session', percent: 99, resets_at: '2026-09-02T03:20:00.000Z' },
        ])!
        // The fresh percent, the remembered reset. Never the other way round:
        // a remembered percent beside a fresh reset is the bug being fixed.
        expect(rows[0].percent).toBe(5)
        expect(rows[0].resets_at).toBe('2026-09-02T03:20:00.000Z')
    })

    it('leaves a row with no reset anywhere without one, rather than inventing now', () => {
        const rows = parseUsagePrint('Current session: 5% used', now)!
        expect(rows[0].resets_at).toBeUndefined()
    })
})

describe('parseResetClause', () => {
    it('picks the year that puts the reset in the future, across a new year', () => {
        // Printed forms carry no year. On Dec 31 the "Jan 2" a week away is
        // next year's, and only next year's candidate is both future and near.
        const dec = Date.parse('2026-12-31T20:00:00Z')
        expect(parseResetClause('Jan 2 at 4:00am (UTC)', dec))
            .toBe(Date.parse('2027-01-02T04:00:00Z'))
    })

    it('reads an hour with no minutes, and midday either way round', () => {
        expect(parseResetClause('Sep 3 at 10am (UTC)', now)).toBe(Date.parse('2026-09-03T10:00:00Z'))
        expect(parseResetClause('Sep 3 at 12am (UTC)', now)).toBe(Date.parse('2026-09-03T00:00:00Z'))
        expect(parseResetClause('Sep 3 at 12pm (UTC)', now)).toBe(Date.parse('2026-09-03T12:00:00Z'))
    })

    it('gives up rather than guessing at something it cannot read', () => {
        expect(parseResetClause('some time next week', now)).toBeNull()
        expect(parseResetClause(undefined, now)).toBeNull()
    })
})

describe('the reading store', () => {
    it('round-trips what was written', () => {
        writeReading(root, 'bitspur.com', [{ kind: 'session', percent: 70 }], now)
        expect(readReading(root, 'bitspur.com')).toEqual({
            fetchedAt: now,
            rows: [{ kind: 'session', percent: 70 }],
        })
    })

    it('keeps an account whose name is a path apart from one that is not', () => {
        // Registry names are Clay's words, not identifiers — "bitspur.com" and
        // an email address are both in the live registry today.
        writeReading(root, 'a/b', [{ kind: 'session', percent: 1 }], now)
        writeReading(root, 'a', [{ kind: 'session', percent: 2 }], now)
        expect(readReading(root, 'a/b')!.rows[0].percent).toBe(1)
        expect(readReading(root, 'a')!.rows[0].percent).toBe(2)
    })

    it('reads nothing for an account nobody has looked at', () => {
        expect(readReading(root, 'never')).toBeNull()
    })
})

describe('fresherReading', () => {
    const vendor = { fetchedAt: 1000, rows: [{ kind: 'session', percent: 26 }] }
    const ours = { fetchedAt: 2000, rows: [{ kind: 'session', percent: 68 }] }

    it('takes the newer of the two', () => {
        // The measured case: Claude Code's cache said 26% while the number was
        // 68%, because it had declined to rewrite for fifteen minutes.
        expect(fresherReading(vendor, ours)).toBe(ours)
        expect(fresherReading(ours, vendor)).toBe(ours)
    })

    it('falls back to whichever one exists', () => {
        expect(fresherReading(null, ours)).toBe(ours)
        expect(fresherReading(vendor, null)).toBe(vendor)
        expect(fresherReading(null, null)).toBeNull()
    })

    it('never lets an undated reading beat a dated one', () => {
        // Undated means "we cannot say when this was true". Treating that as
        // now is how a day-old number wins an argument it should lose.
        const undated = { fetchedAt: null, rows: [] }
        expect(fresherReading(vendor, undated)).toBe(vendor)
        expect(fresherReading(undated, ours)).toBe(ours)
    })

    it('leaves the vendor cache in front on a tie', () => {
        const tie = { fetchedAt: 1000, rows: [] }
        expect(fresherReading(vendor, tie)).toBe(vendor)
    })
})
