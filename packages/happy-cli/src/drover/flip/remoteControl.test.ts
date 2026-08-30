/**
 * Who a flip is about to silence (DROVE-37).
 *
 * The case that produced the ticket is the first test: an UNMANAGED session,
 * which the bus reports with `account: null`, on a machine flipping to a named
 * account. A filter that only compares named accounts misses exactly that one
 * — and it is the one Clay actually lost.
 */

import { describe, expect, it } from 'vitest'

import { sessionsAtRisk, warningFor, type BusSession } from './remoteControl'

const s = (over: Partial<BusSession> & { id: string }): BusSession => ({
    state: 'live-interactive',
    ...over,
})

describe('which sessions a flip will knock off Remote Control', () => {
    it('counts an UNMANAGED session, which reports no account at all', () => {
        // Clay's actual case: `employees` was started outside the drover
        // wrapper, so the bus has account: null. It runs on the ambient login,
        // which is main, and a flip to jamrizzi takes it down.
        const at = sessionsAtRisk({
            sessions: [
                s({ id: 'self', account: 'main', title: 'drover' }),
                s({ id: 'emp', account: null, title: 'employees' }),
            ],
            target: 'jamrizzi',
            selfId: 'self',
        })
        expect(at).toHaveLength(1)
        expect(at[0]).toMatchObject({ id: 'emp', label: 'employees', account: 'main' })
    })

    it('never warns about the session doing the flipping', () => {
        const at = sessionsAtRisk({
            sessions: [s({ id: 'self', account: 'main', title: 'drover' })],
            target: 'jamrizzi',
            selfId: 'self',
        })
        expect(at).toEqual([])
    })

    it('leaves out a session already on the target account', () => {
        // Its binding is the one being renewed, so it is not disturbed.
        const at = sessionsAtRisk({
            sessions: [
                s({ id: 'a', account: 'jamrizzi', title: 'already there' }),
                s({ id: 'b', account: 'bitspur.com', title: 'elsewhere' }),
            ],
            target: 'jamrizzi',
            selfId: 'self',
        })
        expect(at.map((x) => x.id)).toEqual(['b'])
    })

    it('leaves out sessions that are not running', () => {
        const at = sessionsAtRisk({
            sessions: [
                s({ id: 'idle', account: 'main', state: 'idle', title: 'idle one' }),
                s({ id: 'ended', account: 'main', state: 'ended', title: 'ended one' }),
                s({ id: 'live', account: 'main', state: 'live-interactive', title: 'live one' }),
            ],
            target: 'jamrizzi',
            selfId: 'self',
        })
        expect(at.map((x) => x.id)).toEqual(['live'])
    })

    it('falls back to the directory when a session has no title, with $HOME collapsed', () => {
        const at = sessionsAtRisk({
            sessions: [s({ id: 'x', account: 'main', cwd: '/Users/clayrisser/employees' })],
            target: 'alt',
            selfId: 'self',
        })
        expect(at[0].label).toBe('~/employees')
    })

    it('says nothing at all when nothing is at risk', () => {
        // A warning that fires on every flip is one nobody reads.
        expect(warningFor([], 'jamrizzi')).toBeNull()
    })

    it('names the sessions and the remedy', () => {
        const at = sessionsAtRisk({
            sessions: [
                s({ id: 'emp', account: null, title: 'employees' }),
                s({ id: 'shc', account: 'bitspur.com', title: 'shc' }),
            ],
            target: 'jamrizzi',
            selfId: 'self',
        })
        const msg = warningFor(at, 'jamrizzi')!
        expect(msg).toContain('employees (main)')
        expect(msg).toContain('shc (bitspur.com)')
        expect(msg).toContain('2 other live sessions')
        expect(msg).toContain('/remote-control')
    })

    it('reads as singular for one session', () => {
        const at = sessionsAtRisk({
            sessions: [s({ id: 'emp', account: null, title: 'employees' })],
            target: 'jamrizzi',
            selfId: 'self',
        })
        const msg = warningFor(at, 'jamrizzi')!
        expect(msg).toContain('1 other live session on this machine')
        expect(msg).not.toContain('sessions')
    })
})
