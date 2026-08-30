import { describe, expect, it, vi } from 'vitest'

import {
    buildAccountLoginArgv,
    startAccountLogin,
    validAccountName,
} from './accountLogin'

describe('validAccountName', () => {
    it('takes an email address, because that is what an account is named after', () => {
        // `drover account login` with no name calls the row after the address
        // Claude Code recorded, so @ and . have to be legal in a name.
        expect(validAccountName('clayrisser@gmail.com')).toBe(true)
        expect(validAccountName('bitspur.com')).toBe(true)
        expect(validAccountName('account-1')).toBe(true)
    })

    it('refuses the spellings that break somewhere else in the chain', () => {
        // Each of these is refused for a reason libexec/drover-account-edit
        // spells out: / is the path separator for the config dir, a leading -
        // reads as an option, a leading . hides the directory, and a shell
        // metacharacter is a metacharacter to something in the chain.
        expect(validAccountName('a/b')).toBe(false)
        expect(validAccountName('-flag')).toBe(false)
        expect(validAccountName('.hidden')).toBe(false)
        expect(validAccountName('two words')).toBe(false)
        expect(validAccountName('semi;colon')).toBe(false)
        expect(validAccountName('')).toBe(false)
    })
})

describe('buildAccountLoginArgv', () => {
    it('runs the drover verb, and omits the name when there is none', () => {
        expect(buildAccountLoginArgv('/d/bin/drover')).toEqual([
            '/d/bin/drover', 'account', 'login',
        ])
        expect(buildAccountLoginArgv('/d/bin/drover', 'alt')).toEqual([
            '/d/bin/drover', 'account', 'login', 'alt',
        ])
    })
})

describe('startAccountLogin', () => {
    it('starts the login and returns without waiting for it', async () => {
        // The RPC must not hold the socket open: the login lasts as long as a
        // human takes to open a link and copy a code back, and the card that
        // asks for that arrives over the bus, not over this call.
        const launch = vi.fn()
        const result = await startAccountLogin(
            { name: 'alt' },
            { droverBin: '/d/bin/drover', exists: () => true, launch },
        )
        expect(result).toEqual({ started: true, name: 'alt' })
        expect(launch).toHaveBeenCalledWith(['/d/bin/drover', 'account', 'login', 'alt'])
    })

    it('lets the login name itself when the phone sent no name', async () => {
        const launch = vi.fn()
        const result = await startAccountLogin(
            {},
            { droverBin: '/d/bin/drover', exists: () => true, launch },
        )
        expect(result).toEqual({ started: true, name: null })
        expect(launch).toHaveBeenCalledWith(['/d/bin/drover', 'account', 'login'])
    })

    it('refuses a name that would break, before anything is spawned', async () => {
        const launch = vi.fn()
        await expect(startAccountLogin(
            { name: '../escape' },
            { droverBin: '/d/bin/drover', exists: () => true, launch },
        )).rejects.toThrow(/not a usable account name/)
        expect(launch).not.toHaveBeenCalled()
    })

    it('names the path and the two variables when the wrapper is not there', async () => {
        // The only person who can fix this is at a keyboard somewhere else, so
        // the message has to carry the path and how to move it.
        const launch = vi.fn()
        await expect(startAccountLogin(
            {},
            { droverBin: '/nope/bin/drover', exists: () => false, launch },
        )).rejects.toThrow(/DROVER_BIN/)
        expect(launch).not.toHaveBeenCalled()
    })
})
