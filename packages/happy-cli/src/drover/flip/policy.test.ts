/**
 * The app's read and write path onto the flip policy (DROVE-3).
 *
 * Driven against a stub that speaks the endpoints docs/flip-policy.md
 * documents, so the test pins the CONTRACT — the three layers kept apart, null
 * clearing a key, a 400 coming back as the bus's own sentence — rather than one
 * implementation of it. What it deliberately cannot prove is that the real
 * engine/settings.js agrees; that is checked against a live bus and written on
 * the ticket.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
    PolicyReporter,
    clearSessionPolicy,
    readPolicy,
    writeDefaultPolicy,
    writeSessionPolicy,
    type DroverPolicy,
} from './policy'

const builtIn = {
    onLimit: 'prompt',
    onLimitTimeout: 'auto',
    onLimitPromptTtlMs: 600000,
    onFamilyExhausted: 'stop',
    familyFallback: { fable: ['opus', 'sonnet'] },
}

interface Store {
    defaults: Record<string, unknown>
    sessions: Record<string, Record<string, unknown>>
}

/** Enough of engine/settings.js to hold the contract: merge, null clears, 400s. */
function busStub(store: Store) {
    const calls: { method: string; url: string; by: string | null; body: unknown }[] = []
    const known = Object.keys(builtIn)

    const effective = (id: string) => {
        const own = { ...(store.sessions[id] ?? {}) }
        delete own.updatedAt
        delete own.updatedBy
        return {
            sessionId: id,
            effective: { ...builtIn, ...store.defaults, ...own },
            overrides: own,
            defaults: { ...builtIn, ...store.defaults },
            machine: store.defaults,
            builtIn,
            updatedAt: store.sessions[id]?.updatedAt ?? null,
            updatedBy: store.sessions[id]?.updatedBy ?? null,
        }
    }

    const merge = (into: Record<string, unknown>, patch: Record<string, unknown>) => {
        const out = { ...into }
        for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete out[k]
            else out[k] = v
        }
        return out
    }

    const server = createServer((req, res) => {
        let raw = ''
        req.on('data', (c) => { raw += c })
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null
            calls.push({
                method: req.method ?? '',
                url: req.url ?? '',
                by: (req.headers['x-drover-by'] as string) ?? null,
                body,
            })
            const send = (status: number, payload: unknown) => {
                res.writeHead(status, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(payload))
            }
            const bad = body && Object.keys(body).find((k) => !known.includes(k))
            if (bad) return send(400, { error: `unknown setting '${bad}' (known: ${known.join(', ')})` })

            const session = /^\/v1\/settings\/sessions\/([^/?]+)/.exec(req.url ?? '')
            if (session) {
                const id = decodeURIComponent(session[1])
                if (req.method === 'PATCH') {
                    const next = merge(effective(id).overrides, body ?? {})
                    if (Object.keys(next).length === 0) delete store.sessions[id]
                    else store.sessions[id] = { ...next, updatedAt: 1, updatedBy: (req.headers['x-drover-by'] as string) ?? 'unknown' }
                } else if (req.method === 'DELETE') {
                    delete store.sessions[id]
                }
                return send(200, effective(id))
            }
            if ((req.url ?? '').startsWith('/v1/settings/defaults')) {
                if (req.method === 'PATCH') store.defaults = merge(store.defaults, body ?? {})
                return send(200, { defaults: { ...builtIn, ...store.defaults }, builtIn })
            }
            send(404, { error: 'nope' })
        })
    })
    return { server, calls }
}

describe('flip policy over the bus (DROVE-3)', () => {
    let server: Server
    let calls: { method: string; url: string; by: string | null; body: unknown }[]
    let store: Store
    const previousUrl = process.env.DROVER_URL

    beforeEach(async () => {
        store = { defaults: {}, sessions: {} }
        const stub = busStub(store)
        server = stub.server
        calls = stub.calls
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        process.env.DROVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        if (previousUrl === undefined) delete process.env.DROVER_URL
        else process.env.DROVER_URL = previousUrl
    })

    it('reports the three layers apart, so the app can say which one won', async () => {
        store.defaults = { onLimit: 'auto' }
        store.sessions.abc = { onFamilyExhausted: 'fallback', updatedAt: 7, updatedBy: 'cli' }

        const policy = await readPolicy('abc')

        // effective is the merge; overrides is what THIS session chose. Merged
        // alone cannot tell "you set auto" from "auto is what everyone gets".
        expect(policy.effective.onLimit).toBe('auto')
        expect(policy.effective.onFamilyExhausted).toBe('fallback')
        expect(policy.overrides).toEqual({ onFamilyExhausted: 'fallback' })
        expect(policy.machine).toEqual({ onLimit: 'auto' })
        expect(policy.builtIn.onLimit).toBe('prompt')
        expect(policy.updatedBy).toBe('cli')
        expect(policy.unavailable).toBeUndefined()
    })

    it('reads the defaults when Claude has not named the session yet', async () => {
        store.defaults = { onLimit: 'auto' }
        const policy = await readPolicy(null)
        expect(policy.effective.onLimit).toBe('auto')
        expect(policy.overrides).toEqual({})
        expect(calls.at(-1)?.url).toContain('/v1/settings/defaults')
    })

    it('writes a session override and stamps who asked', async () => {
        const result = await writeSessionPolicy('abc', { onLimit: 'auto' }, 'phone')
        expect(result.ok).toBe(true)
        expect(result.policy.overrides).toEqual({ onLimit: 'auto' })
        expect(calls.at(-1)?.method).toBe('PATCH')
        expect(calls.at(-1)?.by).toBe('phone')
    })

    it('clears one key with null — what "use the default" sends', async () => {
        await writeSessionPolicy('abc', { onLimit: 'auto', onFamilyExhausted: 'fallback' }, 'phone')
        const result = await writeSessionPolicy('abc', { onLimit: null }, 'phone')
        expect(result.policy.overrides).toEqual({ onFamilyExhausted: 'fallback' })
        // Back to whatever the layer below says, not to a value the app chose.
        expect(result.policy.effective.onLimit).toBe('prompt')
    })

    it('drops every override on a clear', async () => {
        await writeSessionPolicy('abc', { onLimit: 'auto' }, 'phone')
        const result = await clearSessionPolicy('abc')
        expect(result.ok).toBe(true)
        expect(result.policy.overrides).toEqual({})
    })

    it('a session override still wins after the machine default moves', async () => {
        await writeSessionPolicy('abc', { onLimit: 'prompt' }, 'phone')
        const result = await writeDefaultPolicy({ onLimit: 'auto' }, 'phone', 'abc')
        expect(result.ok).toBe(true)
        expect(result.policy.defaults.onLimit).toBe('auto')
        expect(result.policy.effective.onLimit).toBe('prompt')
    })

    it('a new session picks the moved default up', async () => {
        await writeDefaultPolicy({ onLimit: 'auto' }, 'phone', null)
        const fresh = await readPolicy('never-seen-before')
        expect(fresh.effective.onLimit).toBe('auto')
        expect(fresh.overrides).toEqual({})
    })

    it("hands back the bus's own words when it refuses a key", async () => {
        const result = await writeSessionPolicy('abc', { onlimit: 'auto' } as never, 'phone')
        expect(result.ok).toBe(false)
        // The exact failure a settings UI hits by sending a typo'd key. Told
        // "it did not work" instead, it cannot be debugged from a phone.
        expect(result.error).toContain("unknown setting 'onlimit'")
    })

    it('says the bus is down rather than reporting built-ins as live', async () => {
        process.env.DROVER_URL = 'http://127.0.0.1:1'
        const policy = await readPolicy('abc')
        expect(policy.unavailable).toBeTruthy()
        expect(policy.effective).toEqual({})
    })

    describe('PolicyReporter', () => {
        it('publishes once and stays quiet while nothing moves', async () => {
            const published: DroverPolicy[] = []
            const reporter = new PolicyReporter({
                sessionId: () => 'abc',
                publish: (p) => published.push(p),
            })
            expect(await reporter.tick()).toBe(true)
            expect(await reporter.tick()).toBe(false)
            expect(published).toHaveLength(1)

            // A change made from the TERMINAL, which the app only ever learns
            // about by this poll.
            store.sessions.abc = { onLimit: 'auto' }
            expect(await reporter.tick()).toBe(true)
            expect(published.at(-1)?.effective.onLimit).toBe('auto')
            reporter.stop()
        })

        it('carries the overrides onto the new id when Claude restarts', async () => {
            store.sessions.old = { onLimit: 'auto' }
            const reporter = new PolicyReporter({ sessionId: () => 'old', publish: () => {} })
            await reporter.tick()

            // A flip resumes, and Claude Code mints a new session id. Without
            // the carry the first thing an auto-flip does is discard the policy
            // that told it to auto-flip.
            await reporter.sessionFound('fresh')
            expect(store.sessions.fresh?.onLimit).toBe('auto')
            reporter.stop()
        })

        it('never overwrites a policy set after the restart', async () => {
            store.sessions.old = { onLimit: 'auto' }
            store.sessions.fresh = { onLimit: 'prompt' }
            const reporter = new PolicyReporter({ sessionId: () => 'old', publish: () => {} })
            await reporter.tick()
            await reporter.sessionFound('fresh')
            expect(store.sessions.fresh?.onLimit).toBe('prompt')
            reporter.stop()
        })
    })
})
