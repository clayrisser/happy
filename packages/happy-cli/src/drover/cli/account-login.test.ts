/**
 * `drover account login`, measured against the shell (DROVE-315 waves 2b + 4).
 *
 * TWO HALVES, ONE GATE. The decidable half — the URL off a pane, a refused code
 * counted, the card argv, the registry row — is compared against goldens the
 * shell's OWN pipelines produced: `tr … | sed -n … | head -1`,
 * `grep -c -e 'Invalid code' -e 'Login failed'`, and the `jq -n` lifted
 * verbatim out of libexec/drover-account-login. The PANE half (wave 4) is
 * compared against the REAL shell verb, run on the same fixture: the help text,
 * every refusal and its exit code, the guard that fires when `claude` is not on
 * PATH, the ambient login it will not touch, and the directory it lands in.
 *
 * The sentences are checked against the strings tests/login.bats and
 * tests/account-identity.bats assert, because they are read off a phone by a
 * man who is not at the Mac and a paraphrase is a different instruction.
 *
 * NOTHING HERE RUNS A LOGIN. No `claude auth login`, no browser, no live
 * service, no real Keychain, no tmux server. The fixture PATH carries a stub
 * `claude` that answers `--version` and `auth status` and REFUSES anything else
 * with exit 97, and every tmux call on the node side goes through an injected
 * double that throws on a call it does not model — so a branch that reached for
 * Clay's own machine fails the test rather than measuring it. No token, code or
 * credential value appears in any assertion: the only credential-shaped thing in
 * the fixture is an `oauthAccount` address, which is identity.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    type AccountLoginIo, accountDataDir, accountDirLabel, accountRow, ambientRefusal, askFailureWhy,
    countRefusals, duplicateOf, duplicateRefusal, expandHome, isAmbient, loginAskArgv,
    loginPaneTail, nextConfigDir, noCredentialWhy, notifyPayload, parseLoginArgs, readAuthorizeUrl,
    registryWith, relativeRefusal, retryReason, rowConfigOf, run, scanHarness, usage, verifyRefusal,
} from './account-login'
import { droverEnv } from './env'
import { DroverWindow, type WindowIo, loginWindowName } from './harness/droverWindow'

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import (DROVE-336).
 *
 * A bench that did not set it once registered seventy-eight real sessions on
 * Clay's phone, because the fork's entry takes an unknown word to Claude and
 * Claude registers. Nothing in this file goes near the entry, and this is what
 * makes that a fact rather than an intention.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const realHappyHome = path.join(os.homedir(), '.happy')
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'accountlogin-happy-'))
    process.env.HAPPY_HOME_DIR = happyHome
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1'
    return { happyHome, realHappyHome }
})

vi.mock('../../configuration', () => {
    throw new Error('account-login.test: configuration was imported; this verb must not reach the session machinery')
})
vi.mock('../../api/api', () => {
    throw new Error('account-login.test: api/api was imported; this verb must not reach the session machinery')
})

type Env = Record<string, string | undefined>

function refuseRealHappyHome(env: Env, where: string): void {
    const raw = env.HAPPY_HOME_DIR
    const at = raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome)
    if (at === resolve(realHappyHome)) {
        throw new Error(`${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome}. Refusing.`)
    }
}

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

// =============================================================================
// THE PANE HALF (DROVE-315 wave 4), against the real shell verb
// =============================================================================

const droverDir = droverEnv({ ...process.env, DROVER_DIR: process.env.DROVER_DIR }).droverDir
const shellVerb = join(droverDir, 'libexec', 'drover-account-login')
const haveShell = existsSync(shellVerb)

let root = ''
let fixture: Record<string, string> = {}
/** The same fixture with the stub `claude` in front, for the paths past the guard. */
let withClaude: Record<string, string> = {}

/**
 * The fixture, and the two PATHs are the load-bearing part of it.
 *
 * `fixture.PATH` has jq, curl, uname, date and a REFUSING tmux, and DELIBERATELY
 * NO claude — which is what makes the DROVE-212 guard reachable in both
 * implementations without a login existing anywhere. `withClaude.PATH` adds a
 * stub that answers `--version` and `auth status` off the config file and exits
 * 97 on anything else, so a path that actually tried to log in fails loudly.
 *
 * DROVER_URL points at a port nothing listens on, so the wrapper's notices go
 * nowhere and the node side's are recorded instead of posted.
 */
function makeFixture(): Record<string, string> {
    root = mkdtempSync(join(tmpdir(), 'drover-account-login-'))
    const bin = join(root, 'bin')
    const claudeBin = join(root, 'bin-claude')
    const homeDir = join(root, 'home')
    const state = join(root, 'state')
    for (const d of [bin, claudeBin, homeDir, state]) mkdirSync(d, { recursive: true })

    // The REAL jq, resolved while the cwd is still the repo: jq is an asdf shim
    // here and a shim reads its version from the cwd's or $HOME's
    // .tool-versions, and $HOME below is an empty fixture. tests/login.bats
    // carries the same fix, for the same 17-of-28 failure.
    const asdf = spawnSync('asdf', ['which', 'jq'], { encoding: 'utf8' })
    const jq = (asdf.status === 0 ? asdf.stdout.trim() : '')
        || spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim()
    for (const tool of [jq, '/usr/bin/curl', '/usr/bin/uname', '/bin/date']) {
        if (tool === '' || !existsSync(tool)) continue
        try {
            symlinkSync(tool, join(bin, tool.slice(tool.lastIndexOf('/') + 1)))
        } catch {
            // Already linked.
        }
    }
    // A tmux that REFUSES: it exists so the guard passes, and it fails loudly the
    // instant anything runs it. Nothing here does — every tmux call on the node
    // side goes through the injected double.
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho "account-login.test: the REAL tmux was run" >&2\nexit 97\n', { mode: 0o755 })
    // A claude that answers the two read-only questions and REFUSES to log in.
    writeFileSync(join(claudeBin, 'claude'), `#!/bin/sh
if [ "$1" = --version ]; then printf '2.1.251 (Claude Code)\\n'; exit 0; fi
if [ "$1" = auth ] && [ "$2" = status ]; then
    if [ -f "$CLAUDE_CONFIG_DIR/.claude.json" ] && grep -q oauthAccount "$CLAUDE_CONFIG_DIR/.claude.json"; then
        printf '{"loggedIn":true,"authMethod":"claude.ai"}\\n'; exit 0
    fi
    printf '{"loggedIn":false,"authMethod":"none"}\\n'; exit 1
fi
echo "account-login.test: the stub claude was asked to run '$*' — no login runs here" >&2
exit 97
`, { mode: 0o755 })

    // A config dir that IS logged in, for the no-op path.
    mkdirSync(join(homeDir, '.claude-accounts', 'loggedin'), { recursive: true })
    writeFileSync(join(homeDir, '.claude-accounts', 'loggedin', '.claude.json'),
        '{"oauthAccount":{"emailAddress":"who@example.com"},"hasCompletedOnboarding":true}\n')

    const registry = join(root, 'accounts.json')
    writeFileSync(registry, `${JSON.stringify([
        { name: 'main', configDir: 'default' },
        { name: 'alt', configDir: '~/.claude-accounts/a6' },
    ], null, 2)}\n`)

    const base = {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: homeDir,
        STATE_DIR: state,
        DROVER_DIR: droverDir,
        DROVER_ACCOUNTS: registry,
        DROVER_URL: 'http://127.0.0.1:1',
        DROVER_SHARED_STORE: join(root, 'no-shared-store'),
        DROVER_CREDENTIAL_WAIT_S: '0',
        HAPPY_HOME_DIR: happyHome,
        HAPPY_SERVER_URL: 'http://127.0.0.1:1',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
    }
    withClaude = { ...base, PATH: `${claudeBin}:${base.PATH}` }
    return base
}

interface Ran {
    stdout: string
    stderr: string
    code: number
}

/** The REAL shell verb, on the fixture, with nothing of the real world left. */
function shell(args: string[], extra: Env = {}): Ran {
    const env = { ...fixture, ...extra } as Record<string, string>
    refuseRealHappyHome(env, 'account-login.test: spawn')
    const res = spawnSync(shellVerb, args, { env, encoding: 'utf8' })
    if (res.error || res.status === 126 || res.status === 127) {
        throw new Error(`account-login.test: could not run ${shellVerb} (status ${res.status}, ${String(res.error)}) stderr=${res.stderr}`)
    }
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 }
}

function whichIn(path: string, name: string): string | null {
    for (const dir of path.split(':')) {
        if (!dir) continue
        if (existsSync(join(dir, name))) return join(dir, name)
    }
    return null
}

/**
 * The node verb, in this process, with process.env AND the two output streams
 * swapped for the fixture's — the way accounts.test.ts runs one.
 *
 * process.env is swapped and not only io.env, because two things below it read
 * the ambient one: the credential probe spawns `claude auth status`, and the
 * `--harness cursor` delegation builds the sibling's own default io. Both must
 * see the fixture PATH and never Clay's.
 *
 * Every io call that would reach the real machine THROWS unless a test hands in
 * a replacement.
 */
async function node(args: string[], extra: Env = {}, over: Partial<AccountLoginIo> = {}): Promise<Ran & { notices: Record<string, unknown>[] }> {
    const env = { ...fixture, ...extra } as NodeJS.ProcessEnv
    refuseRealHappyHome(env, 'account-login.test: in-process run')
    const notices: Record<string, unknown>[] = []
    const refuse = (what: string) => (): never => {
        throw new Error(`account-login.test: ${what} was reached; this test must not touch the real machine`)
    }
    let stdout = ''
    let stderr = ''
    const saved = process.env
    const outWrite = process.stdout.write.bind(process.stdout)
    const errWrite = process.stderr.write.bind(process.stderr)
    process.env = env
    ;(process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        stdout += c
        return true
    }
    ;(process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        stderr += c
        return true
    }
    const windowIo: WindowIo = {
        env,
        tmux: refuse('tmux'),
        which: (name) => whichIn(env.PATH ?? '', name),
        err: (line) => { stderr += `${line}\n` },
    }
    const io: AccountLoginIo = {
        env,
        cwd: '/tmp/work',
        pid: 4242,
        isTty: () => false,
        out: (line) => { stdout += `${line}\n` },
        err: (line) => { stderr += `${line}\n` },
        window: new DroverWindow(windowIo),
        which: (name) => whichIn(env.PATH ?? '', name),
        now: () => 1_800_000_000,
        sleep: async () => {},
        alive: refuse('kill -0'),
        signal: refuse('kill'),
        mkdtemp: refuse('mkdtemp'),
        rmrf: refuse('rm -rf'),
        notify: async (payload) => { notices.push(payload) },
        ask: refuse('drover ask'),
        selfCommand: (argv) => ['/node', '/entry', 'account-login', ...argv],
        sibling: refuse('a sibling shell verb'),
        onSignal: () => {},
        ...over,
    }
    try {
        const code = await run(args, io)
        return { stdout, stderr, code, notices }
    } finally {
        process.env = saved
        ;(process.stdout as unknown as { write: typeof outWrite }).write = outWrite
        ;(process.stderr as unknown as { write: typeof errWrite }).write = errWrite
    }
}

beforeAll(() => {
    refuseRealHappyHome(process.env, 'account-login.test')
    fixture = makeFixture()
})

afterAll(() => {
    // The pinned happy home is exactly as empty as mkdtemp made it: nothing
    // here registered a session or opened the entry.
    const left = existsSync(happyHome) ? readdirSync(happyHome) : []
    expect(left).toEqual([])
    rmSync(happyHome, { recursive: true, force: true })
    if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe.runIf(haveShell)('login: byte for byte against the shell', () => {
    it('--help is the shell heredoc, and answers before anything is read', async () => {
        const sh = shell(['--help'])
        const nd = await node(['--help'])
        expect(nd.stdout).toBe(sh.stdout)
        expect(nd.code).toBe(sh.code)
        expect(sh.code).toBe(0)
        // Not two empty answers: four sentences that are the whole contract.
        expect(nd.stdout).toContain('THE LOGIN IS STOPPED ON EVERY EXIT')
        expect(nd.stdout).toContain('SUCCESS MEANS THE CREDENTIAL, NOT THE ADDRESS')
        expect(nd.stdout).toContain('ONE AT A TIME, PER ACCOUNT')
        expect(nd.stdout).toContain('login-claude-<account>')
        expect(usage).toContain('Nothing here mints, reads, stores or logs a credential.')
    })

    for (const [what, args] of [
        ['an unknown option', ['--nope']],
        ['a second positional word', ['alt', 'extra']],
        ['a timeout that is not seconds', ['--timeout', 'abc']],
        ['zero tries', ['--tries', '0']],
        ['tries that are not a number', ['--tries', 'many']],
        ['a harness this does not log in', ['--harness', 'bogus']],
        ['--config-dir with nothing after it', ['--config-dir']],
    ] as const) {
        it(`${what} is refused with the shell's sentence and its exit code`, async () => {
            const sh = shell([...args])
            const nd = await node([...args])
            expect(nd.stderr).toBe(sh.stderr)
            expect(nd.code).toBe(sh.code)
            expect(sh.code).toBe(2)
            expect(sh.stderr).not.toBe('')
        })
    }

    it('no claude on PATH exits 5 with the sentence, and puts a card up', async () => {
        // THE GUARD THE PHONE LOGIN WAS DYING ON. `claude` lives in ~/.local/bin,
        // which is on an interactive shell's PATH and not on a launchd job's, so
        // every phone login exited 5 into a stderr the daemon had pointed at
        // /dev/null and the Accounts screen sat on "Waiting for the sign-in
        // link…" forever.
        const sh = shell(['--no-window'])
        const nd = await node(['--no-window'])
        expect(nd.stderr).toBe(sh.stderr)
        expect(nd.code).toBe(sh.code)
        expect(sh.code).toBe(5)
        expect(sh.stderr).toContain('claude is not on PATH, so there is no login to open')
        expect(nd.notices).toHaveLength(1)
        expect(String(nd.notices[0].reason)).toContain('which a launchd daemon does not inherit')
    })

    for (const spelling of ['default', '~/.claude']) {
        it(`the ambient login '${spelling}' is refused, because a phone cannot undo it`, async () => {
            const sh = shell(['--no-window', '--config-dir', spelling], withClaude)
            const nd = await node(['--no-window', '--config-dir', spelling], withClaude)
            expect(nd.stderr).toBe(sh.stderr)
            expect(nd.code).toBe(sh.code)
            expect(sh.code).toBe(2)
            expect(sh.stderr).toContain('is the ambient login (~/.claude)')
            expect(ambientRefusal(spelling)).toBe(sh.stderr.replace('drover account login: ', '').trimEnd())
        })
    }

    it('a relative config dir is refused: a config dir has to be somewhere fixed', async () => {
        const sh = shell(['--no-window', '--config-dir', 'rel/here'], withClaude)
        const nd = await node(['--no-window', '--config-dir', 'rel/here'], withClaude)
        expect(nd.stderr).toBe(sh.stderr)
        expect(nd.code).toBe(sh.code)
        expect(sh.code).toBe(2)
        expect(relativeRefusal('rel/here')).toBe(sh.stderr.replace('drover account login: ', '').trimEnd())
    })

    it('a config dir already logged in is a NO-OP, exit 0, naming who', async () => {
        const args = ['--no-window', '--config-dir', '~/.claude-accounts/loggedin']
        const sh = shell(args, withClaude)
        const nd = await node(args, withClaude)
        expect(nd.stderr).toBe(sh.stderr)
        expect(nd.code).toBe(sh.code)
        expect(sh.code).toBe(0)
        expect(sh.stderr).toContain('is already logged in as who@example.com — nothing to do.')
    })

    it('--harness cursor hands the whole argv to the cursor sibling', async () => {
        // The scan walks the WHOLE argument list, so the name may sit on either
        // side of the flag and both spellings are the same request.
        for (const args of [['jam', '--harness', 'cursor'], ['--harness', 'cursor', 'jam']]) {
            const sh = shell([...args, '--no-window'])
            const nd = await node([...args, '--no-window'])
            expect(nd.stderr).toBe(sh.stderr)
            expect(nd.code).toBe(sh.code)
            // It really reached the sibling: this is the cursor guard, not the
            // claude one.
            expect(sh.stderr).toContain('cursor-agent is not on PATH')
            expect(sh.code).toBe(5)
        }
    })

    it('--harness claude is consumed, not refused', async () => {
        const sh = shell(['--harness', 'claude', '--no-window'])
        const nd = await node(['--harness', 'claude', '--no-window'])
        expect(nd.stderr).toBe(sh.stderr)
        expect(nd.code).toBe(sh.code)
        expect(sh.stderr).toContain('claude is not on PATH')
    })
})

describe('login: which harness, decided before anything else is parsed', () => {
    it('claude is the default, and the scan is positional-free', () => {
        expect(scanHarness([])).toEqual({ harness: 'claude' })
        expect(scanHarness(['jam', '--harness', 'cursor'])).toEqual({ harness: 'cursor' })
        expect(scanHarness(['--harness', 'cursor', 'jam'])).toEqual({ harness: 'cursor' })
        expect(scanHarness(['--harness', 'claude', 'jam'])).toEqual({ harness: 'claude' })
        expect(scanHarness(['--harness', ''])).toEqual({ harness: 'claude' })
        expect(scanHarness(['--harness', 'bogus'])).toEqual({ bad: 'bogus' })
    })

    it('a trailing --harness is left to the option loop, which has the better sentence', () => {
        expect(scanHarness(['--harness'])).toEqual({ harness: 'claude' })
        const parsed = parseLoginArgs(['--harness'])
        expect(parsed).toEqual({ die: '--harness needs a value', code: 2 })
    })
})

describe('login: the option loop', () => {
    it('takes the name in FIRST position only, unlike the cursor sibling', () => {
        expect((parseLoginArgs(['alt']) as { name: string }).name).toBe('alt')
        // Anything else that is not an option reaches the catch-all, which is
        // what tests/login.bats pins.
        expect(parseLoginArgs(['alt', 'extra'])).toEqual({ die: "unknown option 'extra' (try --help)", code: 2 })
    })

    it('defaults are the shell\'s: 900 seconds, two tries, window auto', () => {
        const o = parseLoginArgs([]) as { timeoutS: number; tries: number; wantWindow: boolean | null }
        expect(o.timeoutS).toBe(900)
        expect(o.tries).toBe(2)
        expect(o.wantWindow).toBeNull()
    })

    it('--window and --no-window override the guess, which is what a test needs', () => {
        expect((parseLoginArgs(['--window']) as { wantWindow: boolean | null }).wantWindow).toBe(true)
        expect((parseLoginArgs(['--no-window']) as { wantWindow: boolean | null }).wantWindow).toBe(false)
    })
})

describe('login: the window it would open, which is also the lock', () => {
    it('is login-claude-<name> for a named add', () => {
        expect(loginWindowName('claude', 'alt')).toBe('login-claude-alt')
        expect(loginWindowName('claude', 'clay@example.com')).toBe('login-claude-clay-example-com')
    })

    it('is login-claude-<config dir> for a nameless one, never the placeholder', () => {
        // The launcher opens under `login-claude-new` because it cannot know
        // which account-N this will pick; the claim renames into the real name
        // the moment it does.
        expect(loginWindowName('claude', 'new')).toBe('login-claude-new')
        expect(loginWindowName('claude', 'account-3')).toBe('login-claude-account-3')
    })

    it('with no terminal it re-execs ITSELF into the window and says which', async () => {
        const calls: string[][] = []
        const windowIo: WindowIo = {
            env: { ...withClaude } as NodeJS.ProcessEnv,
            tmux: (_bin, args) => {
                calls.push(args)
                const key = args[2]
                if (key === 'list-sessions') return { status: 0, stdout: '9 9 1 work\n', stderr: '' }
                if (key === 'list-windows') return { status: 0, stdout: 'bash\n', stderr: '' }
                if (key === 'new-window') return { status: 0, stdout: '%5\n', stderr: '' }
                if (key === 'set-option') return { status: 0, stdout: '', stderr: '' }
                throw new Error(`unmodelled tmux: ${args.join(' ')}`)
            },
            which: (name) => (name === 'tmux' ? '/fixture/tmux' : null),
            err: () => {},
        }
        const nd = await node(['alt', '--window'], withClaude, { window: new DroverWindow(windowIo) })
        expect(nd.code).toBe(0)
        expect(nd.stdout).toBe('drover account login: running in work:login-claude-alt\n')

        const created = calls.find((c) => c[2] === 'new-window')!
        expect(created).toContain('-d')
        expect(created[created.indexOf('-n') + 1]).toBe('login-claude-alt')
        // DROVER_LOGIN_WINDOW first, so the run in the window knows the launcher
        // already opened it and puts the LOGIN in a second pane of the same one.
        expect(created).toContain('DROVER_LOGIN_WINDOW=login-claude-alt')
        expect(created).toContain(`DROVER_ACCOUNTS=${withClaude.DROVER_ACCOUNTS}`)
        expect(created).toContain('DROVER_URL=http://127.0.0.1:1')
        // PATH is NOT among them: `-e PATH=` never reaches a pane, so it rides
        // as DROVER_WINDOW_PATH and the bootstrap applies it.
        expect(created.some((a) => a.startsWith('PATH='))).toBe(false)
        expect(created.some((a) => a.startsWith('DROVER_WINDOW_PATH='))).toBe(true)
        const rest = created.slice(created.lastIndexOf('--') + 1)
        expect(rest.slice(-3)).toEqual(['account-login', 'alt', '--window'])
    })
})

describe('login: what the card says when the pane died first', () => {
    for (const pane of ['pane-url', 'pane-refused']) {
        it(`${pane} tails exactly as grep . | tail -3 | tr did`, () => {
            const sh = spawnSync('sh', ['-c', "grep . | tail -3 | tr '\\n' ' '"],
                { input: read(`${pane}.txt`), encoding: 'utf8' })
            expect(loginPaneTail(read(`${pane}.txt`))).toBe(sh.stdout)
        })
    }

    it('an empty pane tails to nothing, so the caller uses its own sentence', () => {
        expect(loginPaneTail('')).toBe('')
    })
})

describe('login: the two refusals that leave NO row', () => {
    it('an unsettled first run names the theme picker and the way out', () => {
        const said = verifyRefusal('first-run', '/h/.claude-accounts/account-1')
        expect(said).toContain('has not been through Claude Code\'s')
        expect(said).toContain('Nothing was added to the registry.')
        expect(said).toContain('drover trust')
    })

    it('a credential that did not land names `claude auth status`', () => {
        const said = verifyRefusal('no-credential', '/h/.claude-accounts/account-1')
        expect(said).toContain('`claude auth status` says no')
        expect(said).toContain('Nothing was added to the registry.')
    })

    it('`unknown` is NOT a refusal, so it never reaches either sentence', () => {
        // A check that did not run must not be read as a check that failed
        // (DROVE-251). The caller only calls this on rc 1.
        expect(verifyRefusal('unknown', '/d')).toContain('does not read /d as')
    })
})

describe('login: the whole loop, over a scripted pane and no login at all', () => {
    /**
     * THE ROUND TRIP, WITHOUT A ROUND TRIP. The pane is a script: it hands back
     * the recorded URL, accepts the pasted code, and writes the `oauthAccount`
     * key Claude Code would have written. Nothing runs `claude auth login`, no
     * browser opens, no tmux server exists, and the stub `claude` on the fixture
     * PATH exits 97 if anything asks it to do more than answer `auth status`.
     *
     * What this measures is every decision between the card and the registry
     * row: the link the phone gets, that the code goes in on a PIPE rather than
     * an argv, that the row is written only after the credential verified, and
     * that the code never reaches a stream or a log.
     */
    it('reads the link, types the code, verifies, and writes ONE row', async () => {
        const code = 'good-code#state'
        const runHome = join(root, 'loop-home')
        const registry = join(root, 'loop-accounts.json')
        mkdirSync(runHome, { recursive: true })
        writeFileSync(registry, `${JSON.stringify([{ name: 'main', configDir: 'default' }], null, 2)}\n`)
        const env = { ...withClaude, HOME: runHome, DROVER_ACCOUNTS: registry }
        const datadir = join(runHome, '.claude-accounts', 'account-1')

        const calls: { args: string[]; input?: string }[] = []
        let pasted = false
        const windowIo: WindowIo = {
            env: env as NodeJS.ProcessEnv,
            tmux: (_bin, args, input) => {
                calls.push({ args, input })
                const key = args[2]
                if (key === 'list-sessions') return { status: 0, stdout: '9 9 1 work\n', stderr: '' }
                // No login window open yet, so the claim is uncontested.
                if (key === 'list-windows') return { status: 0, stdout: 'bash\n', stderr: '' }
                if (key === 'set-option') return { status: 0, stdout: '', stderr: '' }
                if (key === 'new-window') return { status: 0, stdout: '%5\n', stderr: '' }
                if (key === 'capture-pane') return { status: 0, stdout: read('pane-url.txt'), stderr: '' }
                if (key === 'display-message') {
                    // Live until the code lands, dead after — which is what lets
                    // stop_login return on its first look instead of signalling
                    // a pid that has been free to be reused since it exited.
                    return { status: 0, stdout: pasted ? '1\n' : '0\n', stderr: '' }
                }
                if (key === 'load-buffer') return { status: 0, stdout: '', stderr: '' }
                if (key === 'paste-buffer') {
                    // What Claude Code writes when a code is accepted: the
                    // ADDRESS, merged into the config it already has, never a
                    // truncating rewrite.
                    const cfg = join(datadir, '.claude.json')
                    const doc = existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')) as Record<string, unknown> : {}
                    doc.oauthAccount = { emailAddress: 'added@example.com' }
                    writeFileSync(cfg, `${JSON.stringify(doc, null, 2)}\n`)
                    pasted = true
                    return { status: 0, stdout: '', stderr: '' }
                }
                if (key === 'send-keys') return { status: 0, stdout: '', stderr: '' }
                throw new Error(`unmodelled tmux: ${args.join(' ')}`)
            },
            which: (name) => (name === 'tmux' ? '/fixture/tmux' : null),
            err: () => {},
        }
        const raised: string[][] = []
        const siblings: string[] = []
        const nd = await node(['--no-window'], env, {
            window: new DroverWindow(windowIo),
            mkdtemp: () => mkdtempSync(join(root, 'loop-work-')),
            rmrf: () => {},
            ask: (argv) => {
                raised.push(argv)
                return { done: Promise.resolve({ code: 0, text: code }), stop: () => {} }
            },
            sibling: (name) => { siblings.push(name) },
        })

        expect(nd.code).toBe(0)
        expect(nd.stdout).toBe('logged in as added@example.com -> ~/.claude-accounts/account-1\n')
        expect(nd.stderr).toBe('')
        expect(nd.notices).toEqual([])

        // ONE card, carrying the link the shell's own pipeline read off that
        // pane, and the window to watch it in.
        expect(raised).toHaveLength(1)
        expect(raised[0][0]).toBe('Log in to Claude for ~/.claude-accounts/account-1')
        expect(raised[0][4]).toBe(read('pane-url.url').trimEnd())
        expect(raised[0][2]).toContain('Watch it in tmux: work:login-claude-account-1')

        // THE CODE WENT IN ON A PIPE. `load-buffer -` then `paste-buffer -d`,
        // never `send-keys -l`: a code is arbitrary text and send-keys reads a
        // leading dash as a flag, and `-d` drops the buffer as it pastes so the
        // code does not sit in tmux's paste history.
        const loaded = calls.find((c) => c.args[2] === 'load-buffer')!
        expect(loaded.args.slice(2)).toEqual(['load-buffer', '-b', 'drover-login', '-'])
        expect(loaded.input).toBe(code)
        expect(loaded.args).not.toContain(code)
        expect(calls.find((c) => c.args[2] === 'paste-buffer')!.args).toContain('-d')
        // And it reached no stream, no argv anything can list, and no log.
        expect(nd.stdout).not.toContain(code)
        expect(nd.stderr).not.toContain(code)
        expect(calls.filter((c) => c.args.includes(code))).toEqual([])
        expect(raised.flat().join(' ')).not.toContain(code)

        // The window is the one named for the account it decided on, and it was
        // stamped before the login started so the NEXT run can tell a live one
        // from a corpse.
        const created = calls.find((c) => c.args[2] === 'new-window')!
        expect(created.args[created.args.indexOf('-n') + 1]).toBe('login-claude-account-1')
        expect(created.args).toContain(`CLAUDE_CONFIG_DIR=${datadir}`)
        // The Mac's browser stays shut: Clay is not at the desk.
        expect(created.args).toContain('BROWSER=/usr/bin/true')
        expect(calls.some((c) => c.args.includes('@drover-login-pid') && c.args.includes('4242'))).toBe(true)

        // ONE row, appended, and the one that was there is byte-identical.
        const rows = JSON.parse(readFileSync(registry, 'utf8')) as { name: string; configDir: string }[]
        expect(rows).toEqual([
            { name: 'main', configDir: 'default' },
            { name: 'added@example.com', configDir: '~/.claude-accounts/account-1' },
        ])
        // The config dir is onboarded as well as credentialled, so the first
        // flip onto it does not land in the theme picker (DROVE-238/246).
        const cfg = JSON.parse(readFileSync(join(datadir, '.claude.json'), 'utf8')) as Record<string, unknown>
        expect(cfg.hasCompletedOnboarding).toBe(true)
        expect(cfg.oauthAccount).toEqual({ emailAddress: 'added@example.com' })
        // And /flip was re-synced, so the picker sees it now rather than at the
        // account's second run.
        expect(siblings).toEqual(['drover-trust', 'drover-sync-commands'])
    })

    it('a cancelled login leaves no row and no half-made account', async () => {
        const runHome = join(root, 'cancel-home')
        const registry = join(root, 'cancel-accounts.json')
        mkdirSync(runHome, { recursive: true })
        writeFileSync(registry, `${JSON.stringify([{ name: 'main', configDir: 'default' }], null, 2)}\n`)
        const env = { ...withClaude, HOME: runHome, DROVER_ACCOUNTS: registry }
        const datadir = join(runHome, '.claude-accounts', 'account-1')

        const windowIo: WindowIo = {
            env: env as NodeJS.ProcessEnv,
            tmux: (_bin, args) => {
                const key = args[2]
                if (key === 'list-sessions') return { status: 0, stdout: '9 9 1 work\n', stderr: '' }
                if (key === 'list-windows') return { status: 0, stdout: 'bash\n', stderr: '' }
                if (key === 'set-option') return { status: 0, stdout: '', stderr: '' }
                if (key === 'new-window') return { status: 0, stdout: '%5\n', stderr: '' }
                if (key === 'capture-pane') return { status: 0, stdout: read('pane-url.txt'), stderr: '' }
                if (key === 'display-message') return { status: 0, stdout: '1\n', stderr: '' }
                throw new Error(`unmodelled tmux: ${args.join(' ')}`)
            },
            which: () => '/fixture/tmux',
            err: () => {},
        }
        const removed: string[] = []
        const nd = await node(['--no-window'], env, {
            window: new DroverWindow(windowIo),
            mkdtemp: () => mkdtempSync(join(root, 'cancel-work-')),
            rmrf: (path) => { removed.push(path) },
            ask: () => ({ done: Promise.resolve({ code: 0, text: 'cancel' }), stop: () => {} }),
            sibling: () => { throw new Error('a cancelled login must not re-sync /flip') },
        })

        expect(nd.code).toBe(1)
        expect(nd.stderr).toBe('drover account login: cancelled from the phone\n')
        // The phone is told, in the words the card carries.
        expect(nd.notices).toHaveLength(1)
        expect(nd.notices[0].reason).toBe('cancelled from the phone')
        expect(nd.notices[0].title).toBe('Claude login for ~/.claude-accounts/account-1 failed')
        // No row.
        const rows = JSON.parse(readFileSync(registry, 'utf8')) as { name: string }[]
        expect(rows.map((r) => r.name)).toEqual(['main'])
        // And the directory this run made is removed again, because the probe
        // says no credential landed in it.
        expect(removed).toContain(datadir)
    })
})
