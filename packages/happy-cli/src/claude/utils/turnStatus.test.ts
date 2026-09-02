import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { createTurnStatusReader, turnStatusOf } from './turnStatus'

/**
 * The record Claude Code actually writes, copied field for field off Clay's own
 * live session on 2026-09-01 (claude 2.1.257, native installer):
 *
 *   {"pid":9710,"sessionId":"db93e97b-…","cwd":"…","startedAt":1788304531936,
 *    "version":"2.1.257","kind":"interactive","entrypoint":"cli",
 *    "tmux":"cattle-drover:@1.%1","status":"busy","statusUpdatedAt":1788304532680}
 *
 * The two fields this reader lives on are `status` and `statusUpdatedAt`, and
 * the second one is why the mtime is not used: on that session `statusUpdatedAt`
 * read 23:15:32 while the wall clock was 23:28, because Claude Code rewrites
 * the record on a TRANSITION and leaves it alone in between. Thirteen minutes
 * of one unbroken turn, with the turn's own start time sitting in the field.
 */
const record = (over: Record<string, unknown> = {}) => JSON.stringify({
    pid: 9710,
    sessionId: 'sess-1',
    cwd: '/Users/clay/Projects/x',
    startedAt: 1788304531936,
    version: '2.1.257',
    kind: 'interactive',
    entrypoint: 'cli',
    tmux: 'cattle-drover:@1.%1',
    status: 'busy',
    statusUpdatedAt: 1788304532680,
    ...over,
})

describe('turnStatusOf', () => {
    it('reads `busy` as inside a turn, with the turn start off statusUpdatedAt', () => {
        expect(turnStatusOf({ status: 'busy', statusUpdatedAt: 1788304532680 }))
            .toEqual({ active: true, phase: 'busy', since: 1788304532680 })
    })

    it('reads `shell` as inside a turn too, because a bash tool is work', () => {
        // The state the fd 3 counter is provably wrong about: measured
        // 2026-08-31, a `sleep 150` in the pane looked quiet to fetch tracking
        // for every second of it while the registry said `shell` throughout.
        expect(turnStatusOf({ status: 'shell', statusUpdatedAt: 5 })?.active).toBe(true)
    })

    it('reads `idle` as between turns, which is the only word that means that', () => {
        expect(turnStatusOf({ status: 'idle', statusUpdatedAt: 7 }))
            .toEqual({ active: false, phase: 'idle', since: 7 })
    })

    it('treats a word it has never seen as work, not as idle', () => {
        // A status this reader does not know is Claude Code naming a phase we
        // have not met. A phase we have not met is far likelier to be work than
        // to be the empty prompt, which is the one state it spells out.
        expect(turnStatusOf({ status: 'compacting', statusUpdatedAt: 1 })?.active).toBe(true)
    })

    it('is null with no status at all, which is unknown and never working', () => {
        expect(turnStatusOf({})).toBeNull()
        expect(turnStatusOf(null)).toBeNull()
        expect(turnStatusOf({ status: '   ' })).toBeNull()
    })

    it('reports no clock rather than 1970 when the record carries no statusUpdatedAt', () => {
        // An older Claude writes the status without the timestamp. Zero is the
        // caller's signal to fall back to a transcript-derived start; treating
        // it as an epoch would draw a 56-year turn timer.
        expect(turnStatusOf({ status: 'busy' })?.since).toBe(0)
    })
})

describe('createTurnStatusReader', () => {
    let root: string
    let configDir: string
    let sessionId: string | null

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'drove344-'))
        configDir = join(root, 'config')
        mkdirSync(join(configDir, 'sessions'), { recursive: true })
        sessionId = 'sess-1'
    })

    afterEach(() => {
        rmSync(root, { recursive: true, force: true })
    })

    const reader = () => createTurnStatusReader({
        configDir: () => configDir,
        sessionId: () => sessionId,
    })

    it('reads nothing until it has been polled, so `read` never blocks a tick', () => {
        writeFileSync(join(configDir, 'sessions', '9710.json'), record())
        expect(reader().read()).toBeNull()
    })

    it('finds the record for this session and caches what it said', async () => {
        writeFileSync(join(configDir, 'sessions', '9710.json'), record())
        writeFileSync(join(configDir, 'sessions', '4242.json'), record({ sessionId: 'other', status: 'idle' }))
        const r = reader()
        await r.poll()
        expect(r.read()).toEqual({ active: true, phase: 'busy', since: 1788304532680 })
    })

    it('follows the record from busy to idle when the turn ends', async () => {
        const path = join(configDir, 'sessions', '9710.json')
        writeFileSync(path, record())
        const r = reader()
        await r.poll()
        expect(r.read()?.active).toBe(true)
        writeFileSync(path, record({ status: 'idle', statusUpdatedAt: 1788304999000 }))
        await r.poll()
        expect(r.read()).toEqual({ active: false, phase: 'idle', since: 1788304999000 })
    })

    it('is null on a config dir with no sessions registry, so an older Claude changes nothing', async () => {
        rmSync(join(configDir, 'sessions'), { recursive: true, force: true })
        const r = reader()
        await r.poll()
        expect(r.read()).toBeNull()
    })

    it('is null rather than stale when the record for this session disappears', async () => {
        const path = join(configDir, 'sessions', '9710.json')
        writeFileSync(path, record())
        const r = reader()
        await r.poll()
        expect(r.read()?.active).toBe(true)
        rmSync(path)
        await r.poll()
        // Keeping the last answer would pin the dot blue for the rest of the
        // session on one bad read. Unknown is not working.
        expect(r.read()).toBeNull()
    })

    it('skips a half-written record instead of failing the whole read', async () => {
        writeFileSync(join(configDir, 'sessions', 'torn.json'), '{"sessionId":"sess-1","stat')
        writeFileSync(join(configDir, 'sessions', '9710.json'), record())
        const r = reader()
        await r.poll()
        expect(r.read()?.active).toBe(true)
    })

    it('is null while nothing has named the session id yet', async () => {
        writeFileSync(join(configDir, 'sessions', '9710.json'), record())
        sessionId = null
        const r = reader()
        await r.poll()
        expect(r.read()).toBeNull()
    })

    it('drops the cached answer when the config dir moves under a flip', async () => {
        writeFileSync(join(configDir, 'sessions', '9710.json'), record())
        const r = reader()
        await r.poll()
        expect(r.read()?.active).toBe(true)
        // Cattle Drover carried the session into another account's dir, and
        // that account has no record for it yet. The old account's answer is
        // about a process that is no longer the one running.
        const moved = join(root, 'other')
        mkdirSync(join(moved, 'sessions'), { recursive: true })
        configDir = moved
        await r.poll()
        expect(r.read()).toBeNull()
    })

    it('drops the cached answer when the session id changes', async () => {
        writeFileSync(join(configDir, 'sessions', '9710.json'), record())
        const r = reader()
        await r.poll()
        expect(r.read()?.active).toBe(true)
        sessionId = 'sess-2'
        await r.poll()
        expect(r.read()).toBeNull()
    })
})
