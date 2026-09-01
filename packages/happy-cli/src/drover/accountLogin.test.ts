import { describe, expect, it, vi } from 'vitest'

import {
    accountLoginPath,
    accountLoginSessionName,
    buildAccountLoginArgv,
    buildAccountLoginTmuxArgv,
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
        expect(buildAccountLoginArgv('/d/bin/drover', undefined, 'cursor')).toEqual([
            '/d/bin/drover', 'account', 'login', '--harness', 'cursor',
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
        expect(result).toEqual({ started: true, name: 'alt', harness: 'claude' })
        expect(launch).toHaveBeenCalledWith(
            ['/d/bin/drover', 'account', 'login', 'alt'],
            'login-alt',
        )
    })

    it('lets the login name itself when the phone sent no name', async () => {
        const launch = vi.fn()
        const result = await startAccountLogin(
            {},
            { droverBin: '/d/bin/drover', exists: () => true, launch },
        )
        expect(result).toEqual({ started: true, name: null, harness: 'claude' })
        expect(launch).toHaveBeenCalledWith(
            ['/d/bin/drover', 'account', 'login'],
            'login-new',
        )
    })

    /* --------------------------------------------------------------------- *
     * The second harness (DROVE-270).
     * --------------------------------------------------------------------- */

    it('passes --harness only for cursor, so an older wrapper still works', async () => {
        // `drover account login --harness claude` means the same as no flag on
        // a wrapper that has DROVE-256, and exits 2 on one that does not — into
        // a tmux pane nobody is looking at. The phone cannot see which end it
        // is talking to, so it sends the flag only when it must.
        const launch = vi.fn()
        const result = await startAccountLogin(
            { harness: 'cursor' },
            { droverBin: '/d/bin/drover', exists: () => true, launch },
        )
        expect(result).toEqual({ started: true, name: null, harness: 'cursor' })
        expect(launch).toHaveBeenCalledWith(
            ['/d/bin/drover', 'account', 'login', '--harness', 'cursor'],
            // The slug libexec/drover-cursor-login computes for itself: a cursor
            // account cannot be named after a config dir because it has none.
            'login-cursor',
        )
    })

    it('keeps the name in front of the flag, which the wrapper accepts either way', async () => {
        const launch = vi.fn()
        await startAccountLogin(
            { name: 'jam', harness: 'cursor' },
            { droverBin: '/d/bin/drover', exists: () => true, launch },
        )
        expect(launch).toHaveBeenCalledWith(
            ['/d/bin/drover', 'account', 'login', 'jam', '--harness', 'cursor'],
            'login-jam',
        )
    })

    it('refuses a harness it cannot log in, with a sentence rather than an exit 2', async () => {
        const launch = vi.fn()
        await expect(startAccountLogin(
            { harness: 'gemini' },
            { droverBin: '/d/bin/drover', exists: () => true, launch },
        )).rejects.toThrow(/claude or cursor/)
        expect(launch).not.toHaveBeenCalled()
    })

    it('reads an absent harness as claude, so an older app gets what it always got', async () => {
        const launch = vi.fn()
        const result = await startAccountLogin(
            { name: 'alt', harness: undefined },
            { droverBin: '/d/bin/drover', exists: () => true, launch },
        )
        expect(result.harness).toBe('claude')
        expect(launch.mock.calls[0][0]).not.toContain('--harness')
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

describe('accountLoginSessionName', () => {
    it('is a pure function of the account, because the name IS the lock', () => {
        // Two taps for the same account have to want the same session name, or
        // tmux has nothing to refuse and both logins race for one config dir.
        expect(accountLoginSessionName('alt')).toBe('login-alt')
        expect(accountLoginSessionName('alt')).toBe(accountLoginSessionName('alt'))
    })

    it('spells an email address in what tmux allows in a session name', () => {
        // tmux forbids `.` and `:` in a session name, and an account is named
        // after the address that signed in.
        expect(accountLoginSessionName('clayrisser@gmail.com'))
            .toBe('login-clayrisser-gmail-com')
    })

    it('gives a nameless add a placeholder both taps collide on', () => {
        // Which account-N it lands on is decided inside the shell and renamed
        // to there; until then two nameless adds must not both start.
        expect(accountLoginSessionName()).toBe('login-new')
        expect(accountLoginSessionName('')).toBe('login-new')
        expect(accountLoginSessionName('   ')).toBe('login-new')
        // A nameless CURSOR add is `login-cursor`, matching the slug the cursor
        // login script computes for itself, so the session this daemon opens is
        // already the name the script wants (DROVE-270).
        expect(accountLoginSessionName(null, 'cursor')).toBe('login-cursor')
        expect(accountLoginSessionName('jam', 'cursor')).toBe('login-jam')
    })
})

describe('accountLoginPath', () => {
    it('appends the directory Claude Code installs into', () => {
        // DROVE-212 in one line: ~/.local/bin is on an interactive shell's PATH
        // and not on a launchd job's, so every login from the phone died on
        // `command -v claude` with its stderr pointed at /dev/null.
        const path = accountLoginPath({ HOME: '/', PATH: '/usr/bin:/bin' })
        expect(path.startsWith('/usr/bin:/bin')).toBe(true)
        expect(path.split(':')).toContain('/usr/local/bin')
    })

    it('drops node_modules/.bin, where `claude` is a stub with no shebang', () => {
        const path = accountLoginPath({
            HOME: '/',
            PATH: '/repo/node_modules/.bin:/usr/bin',
        })
        expect(path.split(':')).not.toContain('/repo/node_modules/.bin')
        expect(path.split(':')).toContain('/usr/bin')
    })

    it('adds nothing twice', () => {
        const path = accountLoginPath({ HOME: '/', PATH: '/usr/local/bin:/usr/bin' })
        expect(path.split(':').filter((d) => d === '/usr/local/bin')).toHaveLength(1)
    })
})

describe('buildAccountLoginTmuxArgv', () => {
    it('runs on its own socket so the session is not in anyone\'s picker', () => {
        const argv = buildAccountLoginTmuxArgv({
            argv: ['/d/bin/drover', 'account', 'login'],
            session: 'login-new',
            path: '/usr/bin',
        })
        expect(argv.slice(0, 5)).toEqual(['tmux', '-L', 'drover-login', 'new-session', '-d'])
        expect(argv.slice(-3)).toEqual(['/d/bin/drover', 'account', 'login'])
    })

    it('names the window control, which is how a live login is told from a corpse', () => {
        const argv = buildAccountLoginTmuxArgv({
            argv: ['/d/bin/drover', 'account', 'login'],
            session: 'login-new',
            path: '/usr/bin',
        })
        expect(argv).toContain('control')
        expect(argv).toContain('DROVER_LOGIN_PATH=/usr/bin')
        expect(argv).toContain('DROVER_LOGIN_SESSION=login-new')
    })
})
