import { describe, expect, it, vi } from 'vitest'

import { createOriginRegistry, type RegistryRow } from './originSession'

const claudeId = '9ae61ba4-8a3b-452f-a294-da49d0019c79'
const otherClaudeId = '11111111-2222-4333-8444-555555555555'

const rows: RegistryRow[] = [
    { id: 'happy-bridge', claudeSessionId: null },
    { id: 'happy-a', claudeSessionId: claudeId },
    { id: 'happy-b', claudeSessionId: otherClaudeId },
]

function clock(start = 1_000_000) {
    let t = start
    return { now: () => t, tick: (ms: number) => { t += ms } }
}

describe('createOriginRegistry', () => {
    // DROVE-94. The push used to carry the bridge session, so a tap opened
    // the mirror thread and not the agent that stopped. This is the join from
    // the bus event's origin.sessionId (a Claude uuid) to the happy id.
    it('maps a known Claude session uuid to its happy session id', async () => {
        const read = vi.fn(async () => rows)
        const registry = createOriginRegistry(read)
        await expect(registry.happySessionIdFor(claudeId)).resolves.toBe('happy-a')
        await expect(registry.happySessionIdFor(otherClaudeId)).resolves.toBe('happy-b')
    })

    it('answers null for an origin the registry does not know', async () => {
        const read = vi.fn(async () => rows)
        const registry = createOriginRegistry(read)
        await expect(registry.happySessionIdFor('not-registered')).resolves.toBeNull()
    })

    it('answers null with no origin at all, without reading', async () => {
        const read = vi.fn(async () => rows)
        const registry = createOriginRegistry(read)
        await expect(registry.happySessionIdFor(undefined)).resolves.toBeNull()
        await expect(registry.happySessionIdFor(null)).resolves.toBeNull()
        expect(read).not.toHaveBeenCalled()
    })

    it('serves a burst of gates off one read', async () => {
        const read = vi.fn(async () => rows)
        const c = clock()
        const registry = createOriginRegistry(read, { now: c.now })
        await Promise.all([
            registry.happySessionIdFor(claudeId),
            registry.happySessionIdFor(otherClaudeId),
            registry.happySessionIdFor(claudeId),
        ])
        c.tick(1_000)
        await expect(registry.happySessionIdFor(claudeId)).resolves.toBe('happy-a')
        expect(read).toHaveBeenCalledTimes(1)
    })

    it('rereads on a miss once the miss grace has passed, so a new session is found', async () => {
        const read = vi.fn<() => Promise<RegistryRow[]>>()
            .mockResolvedValueOnce(rows.slice(0, 1))
            .mockResolvedValueOnce(rows)
        const c = clock()
        const registry = createOriginRegistry(read, { now: c.now, missGraceMs: 5_000 })
        await expect(registry.happySessionIdFor(claudeId)).resolves.toBeNull()
        // Inside the grace: the miss is trusted, no second read.
        c.tick(1_000)
        await expect(registry.happySessionIdFor(claudeId)).resolves.toBeNull()
        expect(read).toHaveBeenCalledTimes(1)
        c.tick(5_000)
        await expect(registry.happySessionIdFor(claudeId)).resolves.toBe('happy-a')
        expect(read).toHaveBeenCalledTimes(2)
    })

    it('rereads a hit once the cache has aged out', async () => {
        const read = vi.fn(async () => rows)
        const c = clock()
        const registry = createOriginRegistry(read, { now: c.now, ttlMs: 60_000 })
        await registry.happySessionIdFor(claudeId)
        c.tick(61_000)
        await expect(registry.happySessionIdFor(claudeId)).resolves.toBe('happy-a')
        expect(read).toHaveBeenCalledTimes(2)
    })

    it('treats a failed read as an empty registry rather than throwing', async () => {
        const read = vi.fn(async (): Promise<RegistryRow[]> => { throw new Error('offline') })
        const registry = createOriginRegistry(read)
        await expect(registry.happySessionIdFor(claudeId)).resolves.toBeNull()
    })
})
