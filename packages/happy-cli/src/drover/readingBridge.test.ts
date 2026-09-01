/**
 * The courier between a terminal and the phone's voice (DROVE-298).
 *
 * Two properties, and both are about what must NOT happen. A command must not
 * be carried after its life is over, because the terminal that sent it has
 * already been told nothing happened and a phone that talks in a pocket long
 * afterwards is the surprise the whole ticket refuses. And a report must not
 * come back wearing the wrong id space, because `drover read` prints these as
 * session names a human typed.
 */

import { describe, expect, it, vi } from 'vitest'

import {
    ackReadingOnBus,
    isReadingCommandFrame,
    readingCommandExpired,
    reportReadingOnBus,
    toDroverIds,
    type ReadingCommandFrame,
    type ReadingSnapshot,
} from './readingBridge'

const cmd = (over: Partial<ReadingCommandFrame> = {}): ReadingCommandFrame => ({
    id: 'rd-1',
    verb: 'pause',
    at: 1_000,
    ttlMs: 8_000,
    ...over,
})

describe('what counts as a reading command', () => {
    it('takes the five verbs the bus knows and nothing else', () => {
        expect(isReadingCommandFrame(cmd())).toBe(true)
        expect(isReadingCommandFrame(cmd({ verb: 'sing' as never }))).toBe(false)
        expect(isReadingCommandFrame({ id: 'x', verb: 'pause' })).toBe(false)
        expect(isReadingCommandFrame(null)).toBe(false)
    })
})

describe('a command past its life is never carried', () => {
    it('expires exactly at the life the terminal gave it', () => {
        // ttlMs is the CLI's own --timeout, so this boundary is the moment the
        // human stopped waiting. One millisecond later there is nobody to tell.
        expect(readingCommandExpired(cmd(), 9_000)).toBe(false)
        expect(readingCommandExpired(cmd(), 9_001)).toBe(true)
    })

    it('treats a command with no life at all as already dead', () => {
        // Never immortal. A frame that lost its ttl on some future wire must
        // fail closed, because the failure mode of failing open is audio.
        expect(readingCommandExpired(cmd({ ttlMs: 0 }), 1_000)).toBe(true)
        expect(readingCommandExpired(cmd({ at: Number.NaN }), 1_000)).toBe(true)
    })
})

describe('the phone answers in ITS ids, the terminal reads its own', () => {
    const state: ReadingSnapshot = {
        global: 'on',
        playing: true,
        sessionId: 'happy-a',
        sentence: 'The lane is green.',
        sessions: [
            { sessionId: 'happy-a', enabled: true, state: 'speaking' },
            { sessionId: 'happy-b', enabled: true, state: 'yielded' },
        ],
    }
    const join: Record<string, string> = { 'happy-a': 'claude-a', 'happy-b': 'claude-b' }

    it('translates every id back into the terminal id space', () => {
        const out = toDroverIds(state, (id) => join[id] ?? null)
        expect(out.sessionId).toBe('claude-a')
        expect(out.sessions.map((r) => r.sessionId)).toEqual(['claude-a', 'claude-b'])
        // and nothing else about the row moves
        expect(out.sessions[1].state).toBe('yielded')
    })

    it('DROPS a row the join cannot name rather than printing a happy id', () => {
        // `drover read` prints these as session names. A name from the wrong id
        // space is worse than a row that is not there: it is a name he could
        // type back and get a refusal for.
        const out = toDroverIds(state, (id) => (id === 'happy-a' ? 'claude-a' : null))
        expect(out.sessions.map((r) => r.sessionId)).toEqual(['claude-a'])
    })

    it('a voice the join cannot name reads as nothing speaking, not as a stray id', () => {
        const out = toDroverIds(state, () => null)
        expect(out.sessionId).toBeNull()
        expect(out.sessions).toEqual([])
    })
})

describe('talking to the bus', () => {
    it('acks a command on its own route and reports state on the reading route', async () => {
        const calls: { url: string; method?: string }[] = []
        const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
            calls.push({ url, method: init?.method })
            return { status: 200 } as Response
        })
        vi.stubGlobal('fetch', fetchMock)
        await ackReadingOnBus('http://127.0.0.1:7970', 'rd-1', { applied: true })
        await reportReadingOnBus('http://127.0.0.1:7970', {
            global: 'on', playing: false, sessionId: null, sessions: [],
        })
        expect(calls[0]).toEqual({ url: 'http://127.0.0.1:7970/v1/reading/commands/rd-1', method: 'POST' })
        // PUT, because a reading state is one indivisible picture of one
        // speaker and half of it merged over the other half is a picture of
        // nothing.
        expect(calls[1]).toEqual({ url: 'http://127.0.0.1:7970/v1/reading', method: 'PUT' })
        vi.unstubAllGlobals()
    })

    it('a bus that is down costs a zero, never a throw', async () => {
        // Fail-open like every other drover producer: this runs inside a socket
        // handler and a rejection there would take the bridge down with it.
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
        await expect(ackReadingOnBus('http://127.0.0.1:1', 'rd-1', { applied: true })).resolves.toBe(0)
        await expect(
            reportReadingOnBus('http://127.0.0.1:1', { global: 'off', playing: false, sessionId: null, sessions: [] }),
        ).resolves.toBe(0)
        vi.unstubAllGlobals()
    })
})
