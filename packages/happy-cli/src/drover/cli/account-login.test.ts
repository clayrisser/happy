/**
 * The login's decidable half, measured against the shell (DROVE-315).
 *
 * The `.url` and `.count` goldens beside each pane fixture were produced by
 * the shell's OWN pipelines — `tr … | sed -n … | head -1` and
 * `grep -c -e 'Invalid code' -e 'Login failed'` — and the `.json` ones by the
 * `jq -n` lifted verbatim out of libexec/drover-account-login. The sentences
 * are checked against the strings tests/login.bats and
 * tests/account-identity.bats assert, because they are read off a phone by a
 * man who is not at the Mac and a paraphrase is a different instruction.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
    accountDataDir, accountDirLabel, accountRow, askFailureWhy, countRefusals,
    duplicateOf, duplicateRefusal, expandHome, isAmbient, loginAskArgv, nextConfigDir,
    noCredentialWhy, notifyPayload, readAuthorizeUrl, registryWith, retryReason, rowConfigOf,
} from './account-login'

const fixtures = fileURLToPath(new URL('./__fixtures__/login', import.meta.url))
const read = (name: string): string => readFileSync(join(fixtures, name), 'utf8')

const home = '/Users/tester'

describe('login: the URL off the pane, as the shell read it', () => {
    for (const pane of ['pane-url', 'pane-refused']) {
        it(`${pane} yields the same URL the shell pipeline did`, () => {
            expect(readAuthorizeUrl(read(`${pane}.txt`))).toBe(read(`${pane}.url`).trimEnd())
        })
    }

    it('a pane with no link yet reads as no link, not as a wrong one', () => {
        expect(readAuthorizeUrl('Opening browser to sign in…\n')).toBe('')
    })

    it('the PRINTED link is taken, never the loopback one the browser got', () => {
        // The browser's carries redirect_uri=http://localhost:<random>/callback,
        // which a phone cannot reach. Only the printed one completes remotely.
        const pane = 'visit: https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com\n'
        expect(readAuthorizeUrl(pane))
            .toBe('https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com')
    })
})

describe('login: a refused code is counted, not matched', () => {
    for (const pane of ['pane-url', 'pane-refused']) {
        it(`${pane} counts the same lines grep -c did`, () => {
            expect(countRefusals(read(`${pane}.txt`))).toBe(Number(read(`${pane}.count`).trim()))
        })
    }

    it('a retry sees a NEW refusal, because the old one is still on screen', () => {
        // This is the whole reason it is a count: bad_before is snapshotted
        // before the code is typed and the test is `> bad_before`.
        const before = countRefusals(read('pane-url.txt'))
        const after = countRefusals(read('pane-refused.txt'))
        expect(after).toBeGreaterThan(before)
    })

    it('"Login failed" counts too', () => {
        expect(countRefusals('Login failed\nInvalid code\n')).toBe(2)
    })
})

describe('login: the card the phone gets', () => {
    const card = { label: 'alt', url: 'https://claude.com/cai/oauth/authorize?x=1', timeoutS: 900, session: '', again: '' }

    it('is a `drover ask` with the URL as the preview and one Cancel option', () => {
        expect(loginAskArgv(card)).toEqual([
            'Log in to Claude for alt',
            '--reason', 'Open this in a browser, sign in, then send back the code it shows.',
            '--preview', 'https://claude.com/cai/oauth/authorize?x=1',
            '--option', 'cancel:Cancel the login',
            '--gate', 'account-login',
            '--harness', 'drover',
            '--timeout', '900',
        ])
    })

    it('carries --session only when there is one', () => {
        expect(loginAskArgv({ ...card, session: 'sess-42' }).slice(-2)).toEqual(['--session', 'sess-42'])
        expect(loginAskArgv(card)).not.toContain('--session')
    })

    it('a retry asks again with the SAME link and says why', () => {
        const again = retryReason('the code was refused — Claude Code says the full code was not copied')
        const argv = loginAskArgv({ ...card, again })
        expect(argv[2]).toBe(again)
        expect(argv[2]).toMatch(/refused/)
        // The link the phone already has, not a fresh one.
        expect(argv[4]).toBe(card.url)
    })
})

describe('login: what a non-answer meant', () => {
    it('3 is nobody, and names the budget it waited', () => {
        expect(askFailureWhy(3, 900)).toBe('nobody sent the code within 900s')
    })
    it('4 is withdrawn', () => expect(askFailureWhy(4, 900)).toBe('the login prompt was withdrawn'))
    it('5 is a bus that never carried the URL off the Mac', () =>
        expect(askFailureWhy(5, 900)).toBe('the bus could not be reached, so the URL never left this Mac'))
    it('anything else names the code it got', () =>
        expect(askFailureWhy(7, 900)).toBe('the login prompt failed (drover ask exit 7)'))
})

describe('login: the notice card, byte for byte against the shell', () => {
    it('a failure', () => {
        const got = notifyPayload('~/.claude-accounts/account-1', 'nobody sent the code within 900s', '/tmp/work', '')
        expect(JSON.stringify(got)).toBe(read('notify-failed.json').trimEnd())
    })

    it('a login that WORKED for an address already held is not called a failure', () => {
        const got = notifyPayload(
            'added@example.com', 'the login worked and it is the account you already have.',
            '/tmp/work', 'sess-42', 'was already an account',
        )
        expect(JSON.stringify(got)).toBe(read('notify-already.json').trimEnd())
    })

    it('a nameless add is "a new account"', () => {
        expect(notifyPayload('', 'why', '/tmp/work', '').title).toBe('Claude login for a new account failed')
    })
})

describe('login: which directory it lands in', () => {
    const loggedInNowhere = () => false

    it('a nameless add takes the first free account-N', () => {
        expect(nextConfigDir([], loggedInNowhere, home)).toBe('~/.claude-accounts/account-1')
    })

    it('a row holding either spelling of account-N skips it', () => {
        const rows = [{ name: 'a', configDir: '~/.claude-accounts/account-1' },
            { name: 'b', configDir: `${home}/.claude-accounts/account-2` }]
        expect(nextConfigDir(rows, loggedInNowhere, home)).toBe('~/.claude-accounts/account-3')
    })

    it('a directory already logged in is skipped even with no row', () => {
        const loggedIn = (s: string) => s === '~/.claude-accounts/account-1'
        expect(nextConfigDir([], loggedIn, home)).toBe('~/.claude-accounts/account-2')
    })

    it('a named login reuses the row it already has', () => {
        const rows = [{ name: 'alt', configDir: '~/.claude-accounts/a6' }]
        expect(rowConfigOf(rows, 'alt')).toBe('~/.claude-accounts/a6')
        expect(rowConfigOf(rows, 'nobody')).toBe('')
    })

    it('a row with no configDir field reads as default, not as absent', () => {
        expect(rowConfigOf([{ name: 'me' }], 'me')).toBe('default')
    })
})

describe('login: the ambient login, which a phone cannot undo', () => {
    for (const spelling of ['', 'default', 'ambient', 'DEFAULT', 'Default', '~', '~/.claude', `${home}/.claude`]) {
        it(`'${spelling}' is the ambient login`, () => expect(isAmbient(spelling, home)).toBe(true))
    }
    it('an account dir is not', () => expect(isAmbient('~/.claude-accounts/a6', home)).toBe(false))
    it('the ambient data dir is ~/.claude expanded', () =>
        expect(accountDataDir('default', home)).toBe(`${home}/.claude`))
    it('expandHome only touches a leading tilde', () => {
        expect(expandHome('~/x', home)).toBe(`${home}/x`)
        expect(expandHome('/abs/x', home)).toBe('/abs/x')
        expect(expandHome('~', home)).toBe(home)
    })
})

describe('login: the duplicate refusal is harness-scoped and names the real dir', () => {
    // The cursor row deliberately FIRST, so a first-match-by-name reader would
    // print "default" — which is the bug DROVE-338 is about.
    const rows = [
        { name: 'main', configDir: 'default' },
        { name: 'added@example.com', harness: 'cursor', authId: 'auth0|x' },
        { name: 'added@example.com', configDir: '~/.claude-accounts/keeper' },
    ]

    it('picks the CLAUDE row, never the cursor one that shares the address', () => {
        expect(accountRow(rows, 'added@example.com', 'claude')?.configDir).toBe('~/.claude-accounts/keeper')
        expect(accountRow(rows, 'added@example.com', 'cursor')?.authId).toBe('auth0|x')
    })

    it('an address only a Cursor row holds is not a duplicate', () => {
        const cursorOnly = [rows[0], rows[1]]
        expect(duplicateOf(cursorOnly, 'added@example.com', '~/.claude-accounts/account-1', home)).toBeNull()
    })

    it('a Claude row at another dir IS a duplicate, named by its real directory', () => {
        const dup = duplicateOf(rows, 'added@example.com', '~/.claude-accounts/account-1', home)
        expect(dup?.takenAt).toBe('~/.claude-accounts/keeper')
    })

    it('re-logging into the directory the row already points at falls through silently', () => {
        expect(duplicateOf(rows, 'added@example.com', '~/.claude-accounts/keeper', home)).toBeNull()
        // Both sides expanded, so the absolute spelling compares equal too.
        expect(duplicateOf(rows, 'added@example.com', `${home}/.claude-accounts/keeper`, home)).toBeNull()
    })

    it('the ambient row is named ~/.claude (default), never "default"', () => {
        expect(accountDirLabel('default', home)).toBe('~/.claude (default)')
        expect(accountDirLabel(`${home}/.claude-accounts/a6`, home)).toBe('~/.claude-accounts/a6')
    })

    it('the refusal says where the account is and how to move it, verbatim', () => {
        const said = duplicateRefusal(
            'added@example.com', '~/.claude-accounts/keeper',
            `${home}/.claude-accounts/account-1`, '~/.claude-accounts/account-1',
        )
        // The three sentences tests/login.bats greps for.
        expect(said).toContain('registered at ~/.claude-accounts/keeper')
        expect(said).not.toContain('registered at default')
        expect(said).toContain('drover account rm added@example.com --harness claude')
        expect(said).toContain('drover account use added@example.com')
        expect(said).toContain('lists it as an orphan')
    })
})

describe('login: the registry write is the LAST thing, and only appends', () => {
    it('appends the row, leaving every other row byte-identical', () => {
        const rows = [
            { name: 'main', configDir: 'default' },
            { name: 'added@example.com', harness: 'cursor', authId: 'auth0|x' },
        ]
        const next = registryWith(rows, 'added@example.com', '~/.claude-accounts/account-1')
        expect(next).toHaveLength(3)
        expect(JSON.stringify(next[1])).toBe('{"name":"added@example.com","harness":"cursor","authId":"auth0|x"}')
        expect(next[2]).toEqual({ name: 'added@example.com', configDir: '~/.claude-accounts/account-1' })
    })

    it('a credential that never landed gets the sentence that says to finish it at the Mac', () => {
        const why = noCredentialWhy('/Users/tester/.claude-accounts/account-1', '')
        expect(why).toContain('no usable credential landed')
        expect(why).toContain('from a terminal on that Mac')
        expect(why).toContain('drover account login`')
        expect(noCredentialWhy('/d', 'alt')).toContain('drover account login alt`')
    })
})
