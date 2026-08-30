/**
 * Who a flip is about to silence (DROVE-37).
 *
 * The case that produced the ticket is the first test: an UNMANAGED session,
 * which the bus reports with `account: null`, on a machine flipping to a named
 * account. A filter that only compares named accounts misses exactly that one
 * — and it is the one Clay actually lost.
 */

import { describe, expect, it } from 'vitest'

import { remoteControlWarning, sessionsAtRisk, warningFor, type BusSession } from './remoteControl'

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

/**
 * DROVE-63: the warning's remedy used to be "run /remote-control there", which
 * is the one thing Clay cannot do from the phone. It still says that — the
 * terminal is right there for whoever is at the keyboard — but it now also
 * points at the app's toggle, and it carries the ids that toggle needs.
 */
describe('the warning hands the app something to put a button on', () => {
    it('returns the named sessions alongside the sentence', async () => {
        const result = await remoteControlWarning({
            target: 'jamrizzi',
            selfId: 'self',
            listSessions: async () => [
                s({ id: 'emp', account: null, title: 'employees' }),
                s({ id: 'shc', account: 'bitspur.com', title: 'shc' }),
                s({ id: 'self', account: 'main', title: 'the one flipping' }),
            ],
        })

        expect(result!.atRisk).toEqual([
            { id: 'emp', label: 'employees', account: 'main' },
            { id: 'shc', label: 'shc', account: 'bitspur.com' },
        ])
        // The ids are what the app writes `remoteControl: 'on'` against, so
        // they have to be the bus's session ids and not the labels.
        expect(result!.text).toContain('employees (main)')
        expect(result!.text).toContain('in the app')
    })

    it('is null when nothing is at risk, so nothing is written and nothing is said', async () => {
        const result = await remoteControlWarning({
            target: 'jamrizzi',
            selfId: 'self',
            listSessions: async () => [s({ id: 'other', account: 'jamrizzi', title: 'already there' })],
        })
        expect(result).toBeNull()
    })
})
