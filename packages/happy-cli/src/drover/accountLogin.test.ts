import { describe, expect, it, vi } from 'vitest'

import {
    accountLoginPath,
    accountLoginSocket,
    accountLoginWindowName,
    buildAccountLoginArgv,
    buildAccountLoginEnv,
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
            'login-claude-alt',
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
            'login-claude-new',
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
            'login-cursor-new',
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
            'login-cursor-jam',
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

describe('accountLoginWindowName', () => {
    it('is a pure function of the harness and the account, because the name IS the lock', () => {
        // Two taps for the same account have to want the same window name, or
        // tmux has nothing to refuse and both logins race for one config dir.
        expect(accountLoginWindowName('alt')).toBe('login-claude-alt')
        expect(accountLoginWindowName('alt')).toBe(accountLoginWindowName('alt'))
    })

    it('spells an email address in what tmux allows in a window name', () => {
        // tmux forbids `.` and `:` in a name, and an account is named after the
        // address that signed in.
        expect(accountLoginWindowName('clayrisser@gmail.com'))
            .toBe('login-claude-clayrisser-gmail-com')
    })

    it('carries the harness, because these names are read in a window list now', () => {
        // On the old private socket `login-alt` was unambiguous; beside a day's
        // work it is not (DROVE-348).
        expect(accountLoginWindowName('jam', 'cursor')).toBe('login-cursor-jam')
        expect(accountLoginWindowName('jam', 'claude')).toBe('login-claude-jam')
    })

    it('gives a nameless add a placeholder both taps collide on', () => {
        // Which account-N it lands on is decided inside the shell and renamed
        // to there; until then two nameless adds must not both start.
        expect(accountLoginWindowName()).toBe('login-claude-new')
        expect(accountLoginWindowName('')).toBe('login-claude-new')
        expect(accountLoginWindowName('   ')).toBe('login-claude-new')
        expect(accountLoginWindowName(null, 'cursor')).toBe('login-cursor-new')
    })

    it('is the string libexec/drover-login-session.sh builds', () => {
        // login_window_name <harness> <slug> — one rule, two readers, and a
        // drift here is a lock that does not lock.
        expect(accountLoginWindowName('account-3', 'claude')).toBe('login-claude-account-3')
    })
})

describe('accountLoginSocket', () => {
    it('is the USER\'S server, which is what a bare tmux reaches', () => {
        // DROVE-348 reversed the private `drover-login` socket: a login Clay
        // cannot see is a login he cannot watch.
        expect(accountLoginSocket({})).toBe('default')
    })

    it('follows DROVER_TMUX_SOCKET, the same variable the shell reads', () => {
        expect(accountLoginSocket({ DROVER_TMUX_SOCKET: 'work' })).toBe('work')
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

describe('buildAccountLoginEnv', () => {
    it('hands the PATH over under its own name, which is the whole of DROVE-212', () => {
        // ~/.local/bin is on an interactive shell's PATH and not on a launchd
        // job's, so `command -v claude` failed with its stderr on /dev/null.
        const env = buildAccountLoginEnv('/usr/bin:/home/u/.local/bin', { HOME: '/home/u' })
        expect(env.DROVER_LOGIN_PATH).toBe('/usr/bin:/home/u/.local/bin')
    })

    it('keeps the rest of the environment, which decides which bus the card goes to', () => {
        const env = buildAccountLoginEnv('/usr/bin', { DROVER_URL: 'http://127.0.0.1:7970' })
        expect(env.DROVER_URL).toBe('http://127.0.0.1:7970')
    })
})
