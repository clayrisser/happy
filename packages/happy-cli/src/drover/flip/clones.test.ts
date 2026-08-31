/**
 * Clone lineage on the session (DROVE-58): ledger in, one metadata block out.
 *
 * What these pin is the contract with the phone. A clone is TWO sessions — a
 * flip is one — so both ends have to read the SAME ledger and each show the
 * other, the still-open row has to render as "not started yet" rather than
 * vanish, and the reporter has to keep looking, because the row naming a
 * session is closed AFTER that session has already started.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CloneReporter, cloneLedgerPath, cloneLineage, readCloneLedger, readSeedPrompt, type CloneRow, type DroverClone } from './clones'

let root: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drover-clone-'))
    process.env.XDG_STATE_HOME = join(root, 'state')
    process.env.DROVER_URL = 'http://127.0.0.1:1'
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

const src = 'aaaaaaaa-0000-0000-0000-000000000000'
const clone = 'bbbbbbbb-0000-0000-0000-000000000000'
const other = 'cccccccc-0000-0000-0000-000000000000'

function writeLedger(rows: CloneRow[]): void {
    const path = cloneLedgerPath()
    mkdirSync(join(root, 'state', 'cattle-drover'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`)
}

const row = (over: Partial<CloneRow> = {}): CloneRow => ({
    id: '20260830T120000Z-1',
    at: '2026-08-30T12:00:00Z',
    from: src,
    to: clone,
    harness: 'claude',
    cwd: '/work',
    ...over,
})

describe('the ledger', () => {
    it('is empty, not an error, when no clone has ever been made', () => {
        expect(readCloneLedger()).toEqual([])
        expect(cloneLineage(src)).toBeUndefined()
    })

    it('is empty when the file is mid-write or hand-edited into nonsense', () => {
        mkdirSync(join(root, 'state', 'cattle-drover'), { recursive: true })
        writeFileSync(cloneLedgerPath(), '[{"id":"a"')
        expect(readCloneLedger()).toEqual([])
    })
})

describe('lineage', () => {
    it('shows the clone where it came from', () => {
        writeLedger([row()])
        expect(cloneLineage(clone)).toEqual<DroverClone>({
            from: { session: src, harness: 'claude', at: '2026-08-30T12:00:00Z' },
        })
    })

    it('shows the source where it went — the other half of the same row', () => {
        writeLedger([row()])
        expect(cloneLineage(src)).toEqual<DroverClone>({
            to: [{ session: clone, harness: 'claude', at: '2026-08-30T12:00:00Z' }],
        })
    })

    it('reports a clone that has not started yet rather than dropping it', () => {
        // `drover clone` writes the row BEFORE the window opens, so this is
        // what the source session sees for the seconds before the clone speaks.
        // Dropping it would make the source look like it was never cloned.
        writeLedger([row({ to: null })])
        expect(cloneLineage(src)).toEqual<DroverClone>({
            to: [{ session: null, harness: 'claude', at: '2026-08-30T12:00:00Z' }],
        })
    })

    it('carries every clone of one conversation, not just the first', () => {
        writeLedger([
            row({ id: '1', harness: 'claude' }),
            row({ id: '2', to: other, harness: 'opencode' }),
        ])
        const lineage = cloneLineage(src)
        expect(lineage?.to?.map((t) => `${t.harness}:${t.session}`)).toEqual([
            `claude:${clone}`,
            `opencode:${other}`,
        ])
    })

    it('says nothing about a session no row names', () => {
        writeLedger([row()])
        expect(cloneLineage(other)).toBeUndefined()
        expect(cloneLineage(null)).toBeUndefined()
    })
})

describe('the reporter', () => {
    function reporter(id: () => string | null) {
        const published: (DroverClone | undefined)[] = []
        const r = new CloneReporter({ current: id, publish: (c) => published.push(c) })
        return { r, published }
    }

    it('publishes once and then stays quiet while nothing moves', () => {
        writeLedger([row()])
        const { r, published } = reporter(() => clone)
        expect(r.tick()).toBe(true)
        expect(r.tick()).toBe(false)
        expect(published).toHaveLength(1)
        expect(published[0]?.from?.session).toBe(src)
    })

    it('keeps looking, because the row is closed AFTER the clone has started', () => {
        // The whole reason this polls. At start-up the row naming this session
        // is still open — the bus closes it from the session's own first hook.
        writeLedger([row({ to: null })])
        const { r, published } = reporter(() => clone)
        expect(r.tick()).toBe(false)
        expect(published).toHaveLength(0)

        writeLedger([row()])
        expect(r.tick()).toBe(true)
        expect(published[0]?.from?.session).toBe(src)
    })

    it('publishes nothing at all for a session with no lineage', () => {
        writeLedger([row()])
        const { r, published } = reporter(() => other)
        expect(r.tick()).toBe(false)
        expect(published).toHaveLength(0)
    })

    it('withdraws the line when the row it was reading is gone', () => {
        writeLedger([row()])
        const { r, published } = reporter(() => clone)
        expect(r.tick()).toBe(true)
        writeLedger([])
        expect(r.tick()).toBe(true)
        expect(published[1]).toBeUndefined()
    })

    it('is quiet before Claude has reported a session id', () => {
        writeLedger([row()])
        const { r, published } = reporter(() => null)
        expect(r.tick()).toBe(false)
        expect(published).toHaveLength(0)
    })

    it('stops when it is stopped', () => {
        writeLedger([row()])
        const { r, published } = reporter(() => clone)
        r.stop()
        expect(r.tick()).toBe(false)
        expect(published).toHaveLength(0)
    })
})

describe('the seed', () => {
    it('is read from the file the path names', () => {
        const seed = join(root, 'seed.md')
        writeFileSync(seed, '# Cloned session\n\nthe whole conversation\n')
        expect(readSeedPrompt(seed)).toContain('the whole conversation')
    })

    it('THROWS when it cannot be read, rather than starting with no context', () => {
        // A session that opens with an empty context and reports success is
        // the failure the whole clone path exists to avoid.
        expect(() => readSeedPrompt(join(root, 'nope.md'))).toThrow(/cannot read/)
    })

    it('THROWS on an empty seed', () => {
        const seed = join(root, 'empty.md')
        writeFileSync(seed, '   \n')
        expect(() => readSeedPrompt(seed)).toThrow(/is empty/)
    })
})
