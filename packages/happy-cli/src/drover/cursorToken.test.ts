/**
 * The sixty-day fuse on a cursor login (DROVE-270).
 *
 * What is pinned here is the arithmetic and the vocabulary, because both are
 * copied from `lib/drover-cursor-auth.sh` and a drift between the two would
 * show up as the terminal and the phone quoting different days about the same
 * token. The constants are the shell's: 2000-01-01 for a tombstone, 300
 * seconds for cursor-agent's own "too close", seven days for the warning.
 *
 * And one thing that is not arithmetic at all: no export in that module returns
 * the token. The store holds a live credential and its answers travel to a
 * phone, so "a state and a day count, never the secret" is the property the
 * whole design rests on.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
    cursorAuthStorePath,
    cursorTokenDaysLeftOf,
    cursorTokenStateOf,
    cursorTokenUsable,
    readCursorTokens,
} from './cursorToken'

/** A JWT with the claims we care about. Unsigned: nothing here verifies one,
 *  because the signature is Cursor's to check and this is a countdown on a
 *  screen, not an authorization decision. */
function jwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o))
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature`
}

const now = Date.UTC(2026, 8, 1)
const seconds = Math.floor(now / 1000)
const day = 86400

describe('cursorTokenStateOf', () => {
    it('calls a fresh sixty-day token live', () => {
        // exp - iat is exactly 5184000 on every token drover has minted.
        expect(cursorTokenStateOf(jwt({ exp: seconds + 60 * day }), now)).toBe('live')
    })

    it('warns for the last seven days, and calls that state renew rather than broken', () => {
        // The token WORKS in this window. It is reported apart from live only
        // because the repair needs a human at a browser and there is no refresh
        // flow to try, so the warning has to arrive while it still works.
        expect(cursorTokenStateOf(jwt({ exp: seconds + 6 * day }), now)).toBe('renew')
        expect(cursorTokenStateOf(jwt({ exp: seconds + 8 * day }), now)).toBe('live')
        expect(cursorTokenUsable('renew')).toBe(true)
    })

    it('uses cursor-agent\'s own 300-second margin for "too close to start on"', () => {
        expect(cursorTokenStateOf(jwt({ exp: seconds + 299 }), now)).toBe('expiring')
        expect(cursorTokenStateOf(jwt({ exp: seconds + 301 }), now)).toBe('renew')
    })

    it('calls a past token expired', () => {
        expect(cursorTokenStateOf(jwt({ exp: seconds - 1 }), now)).toBe('expired')
    })

    it('separates a sign-out marker from a lapse', () => {
        // cursor-agent leaves an epoch-expired stub behind when an account signs
        // out. Calling that "expired" blames the calendar for something that
        // happened to the account, and sends Clay to check his clock.
        expect(cursorTokenStateOf(jwt({ exp: 1 }), now)).toBe('tombstone')
        expect(cursorTokenStateOf(jwt({ exp: 946684799 }), now)).toBe('tombstone')
    })

    it('calls an unparseable token unreadable, and still usable', () => {
        // Cursor could change its token format. Refusing every session over a
        // parse failure would be a worse outage than the format change.
        expect(cursorTokenStateOf('not-a-jwt', now)).toBe('unreadable')
        expect(cursorTokenStateOf(jwt({ sub: 'x' }), now)).toBe('unreadable')
        expect(cursorTokenUsable('unreadable')).toBe(true)
    })

    it('calls nothing stored missing, which is not the same as expired', () => {
        expect(cursorTokenStateOf(null, now)).toBe('missing')
        expect(cursorTokenStateOf('', now)).toBe('missing')
        expect(cursorTokenUsable('missing')).toBe(false)
        expect(cursorTokenUsable('expired')).toBe(false)
        expect(cursorTokenUsable('tombstone')).toBe(false)
    })
})

describe('cursorTokenDaysLeftOf', () => {
    it('rounds DOWN, because "1 day left" on eleven hours is what costs the account', () => {
        expect(cursorTokenDaysLeftOf(jwt({ exp: seconds + day + 11 * 3600 }), now)).toBe(1)
        expect(cursorTokenDaysLeftOf(jwt({ exp: seconds + 3 * day + 3600 }), now)).toBe(3)
    })

    it('is zero on the last day rather than negative', () => {
        expect(cursorTokenDaysLeftOf(jwt({ exp: seconds + 3600 }), now)).toBe(0)
        expect(cursorTokenDaysLeftOf(jwt({ exp: seconds - day }), now)).toBe(0)
    })

    it('has no date to count to for a missing, tombstoned or unreadable token', () => {
        expect(cursorTokenDaysLeftOf(null, now)).toBeNull()
        expect(cursorTokenDaysLeftOf(jwt({ exp: 1 }), now)).toBeNull()
        expect(cursorTokenDaysLeftOf('garbage', now)).toBeNull()
    })
})

describe('readCursorTokens', () => {
    const store = (contents: string) => {
        const dir = mkdtempSync(join(tmpdir(), 'cursor-auth-'))
        const file = join(dir, 'cursor-auth.json')
        writeFileSync(file, contents)
        process.env.DROVER_CURSOR_AUTH = file
        return file
    }

    it('reads the override the shell library takes, so both halves move together', () => {
        const file = store('{}')
        expect(cursorAuthStorePath()).toBe(file)
    })

    it('answers per account, and NEVER hands back the token', () => {
        store(JSON.stringify({
            live: { token: jwt({ exp: seconds + 40 * day }), email: 'a@b.c', storedAt: 1 },
            soon: { token: jwt({ exp: seconds + 3 * day }), email: 'd@e.f', storedAt: 1 },
        }))
        const tokens = readCursorTokens(now)
        expect(tokens.get('live')).toEqual({ state: 'live', daysLeft: 40 })
        expect(tokens.get('soon')).toEqual({ state: 'renew', daysLeft: 3 })
        // The property the whole design rests on: these answers ride a session's
        // metadata to the phone, so a token in one would be a credential on the
        // wire.
        for (const reading of tokens.values()) {
            expect(JSON.stringify(reading)).not.toContain('eyJ')
        }
    })

    it('knows nothing rather than throwing when there is no store', () => {
        // No file, an unreadable one, or one this process may not open all mean
        // the same thing to a caller — and a machine with no cursor account
        // never has this file at all.
        process.env.DROVER_CURSOR_AUTH = join(tmpdir(), 'no-such-cursor-auth.json')
        expect(readCursorTokens(now).size).toBe(0)
        store('{ not json')
        expect(readCursorTokens(now).size).toBe(0)
        store('[]')
        expect(readCursorTokens(now).size).toBe(0)
    })

    it('reports a row with no token as missing rather than skipping it', () => {
        store(JSON.stringify({ empty: { email: 'a@b.c', storedAt: 1 } }))
        expect(readCursorTokens(now).get('empty')).toEqual({ state: 'missing', daysLeft: null })
    })
})
