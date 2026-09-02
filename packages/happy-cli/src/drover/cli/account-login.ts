/**
 * `drover account login` — the decidable half, in node (DROVE-238/251/334/338,
 * ported under DROVE-315).
 *
 * WHAT IS HERE AND WHAT IS NOT, because this file is deliberately not the
 * whole of libexec/drover-account-login. That script drives a tmux pane: it
 * opens a window, runs `claude auth login` in it, reads the pane, types a code
 * into it and kills it. The pane-launch path is DROVE-348's, which is moving
 * every interactive flow onto a NAMED window on the user's own tmux server and
 * is editing src/drover/accountLogin.ts to do it. Forking that flow to port it
 * is how a fix lands where nothing runs, so it is left alone and this file
 * carries the parts that are decidable without a pane:
 *
 *   the URL off the pane text        readAuthorizeUrl
 *   a refused code, counted          countRefusals
 *   the card the phone gets          loginAskArgv   (the `drover ask` line)
 *   what a non-answer meant          askFailureWhy
 *   which directory it lands in      nextConfigDir / rowConfigOf
 *   the registry write, AFTER the credential is verified   registryWith
 *   the duplicate refusal, harness-scoped, naming the real dir
 *                                    duplicateRefusal
 *
 * Every sentence below is the shell's, to the byte. They are read off a phone
 * by a man who is not at the Mac, and a paraphrase is a different instruction.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'

import { type Ctx, credentialOk, credentialWait, editContext, settleFirstRun, verifyWait } from './account-edit'
import { accountEmail, accountLoggedIn, jsonRead, jsonWrite, NotJsonError } from './account-store'
import { busPost } from './bus'
import { droverEnv, droverVar } from './env'
import {
    DroverWindow,
    defaultWindowIo,
    loginWindowBootVars,
    loginWindowName,
} from './harness/droverWindow'

export interface AccountRow {
    name: string
    configDir?: string
    harness?: string
    [key: string]: unknown
}

/** lib/drover-json.sh json_is_ambient: the spellings that mean ~/.claude. */
export function isAmbient(configDir: string, home: string = homedir()): boolean {
    switch (configDir) {
        case '':
        case 'default':
        case 'ambient':
        case 'DEFAULT':
        case 'Default':
        case '~':
            return true
    }
    return configDir === '~/.claude' || configDir === `${home}/.claude`
}

/** lib/drover-json.sh json_expand_home. */
export function expandHome(spelling: string, home: string = homedir()): string {
    if (spelling === '~') return home
    if (spelling.startsWith('~/')) return `${home}/${spelling.slice(2)}`
    return spelling
}

/** lib/drover-json.sh json_tilde. */
export function tildeHome(path: string, home: string = homedir()): string {
    if (path === home) return '~'
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
    return path
}

/** lib/drover-json.sh json_account_data_dir: where the config dir really is. */
export function accountDataDir(configDir: string, home: string = homedir()): string {
    return isAmbient(configDir, home) ? `${home}/.claude` : expandHome(configDir, home)
}

/**
 * lib/drover-json.sh json_account_dir_label: the row's spelling resolved and
 * tilde-spelled, "~/.claude (default)" for the ambient one. Never the raw
 * field, which reads "default" for anything that omits it (DROVE-338).
 */
export function accountDirLabel(configDir: string, home: string = homedir()): string {
    if (isAmbient(configDir, home)) return '~/.claude (default)'
    return tildeHome(expandHome(configDir, home), home)
}

/**
 * lib/drover-json.sh json_account_row: the FIRST row with this name AND this
 * harness.
 *
 * The harness half is DROVE-338 and it is load-bearing. `taken` used to be the
 * first row of ANY harness with this name, and the registry held a CURSOR row
 * named clayrisser@gmail.com — a token, no configDir — so a Claude login as
 * that address was refused as a duplicate "registered at default" and its
 * credential stranded, twice in five minutes. A Claude account and a Cursor
 * account may share an address; only another CLAUDE row is a duplicate.
 */
export function accountRow(rows: AccountRow[], name: string, harness: string): AccountRow | null {
    return rows.find((r) => r.name === name && (r.harness ?? 'claude') === harness) ?? null
}

/**
 * The registry spelling for an account that already has a Claude row. Empty
 * when the name is new, which is legal: `drover account login <new name>` is
 * an add.
 */
export function rowConfigOf(rows: AccountRow[], name: string): string {
    const row = accountRow(rows, name, 'claude')
    if (row === null) return ''
    return typeof row.configDir === 'string' ? row.configDir : 'default'
}

/**
 * The serial directory a nameless login gets, and the reason it is a serial
 * and not the address: on macOS the credential lives in a Keychain item named
 * for a hash of the CLAUDE_CONFIG_DIR PATH, so renaming the directory
 * afterwards orphans the login while .claude.json still reads as signed in.
 * The directory is chosen before the login and never moved; only the registry
 * name carries the address.
 *
 * `loggedIn` answers json_account_logged_in for a spelling. A login IN FLIGHT
 * is neither in the registry nor logged in, so two nameless logins pick the
 * SAME account-N. That is not a bug to fix here: it is exactly why they then
 * collide on one session name and the second is refused.
 */
export function nextConfigDir(
    rows: AccountRow[],
    loggedIn: (spelling: string) => boolean,
    home: string = homedir(),
): string | null {
    for (let n = 1; n <= 999; n++) {
        const spelling = `~/.claude-accounts/account-${n}`
        const expanded = expandHome(spelling, home)
        const taken = rows.some((r) => r.configDir === spelling || r.configDir === expanded)
        if (!taken && !loggedIn(spelling)) return spelling
    }
    return null
}

/**
 * The authorize URL off the pane.
 *
 * TWO URLS, and picking the wrong one is a login that can never be completed
 * from a phone. The one Claude Code hands the BROWSER carries
 * redirect_uri=http://localhost:<random>/callback — a loopback server on THIS
 * Mac, which a phone browser cannot reach. The one it PRINTS carries
 * redirect_uri=https://platform.claude.com/oauth/code/callback, which ends on
 * a page showing a code to paste. The printed one is the only one that works
 * from somewhere else, and it is the one this forwards.
 *
 * Matched on the URL itself rather than on the sentence around it: the
 * invariant is an OAuth authorize link on the screen, and "If the browser
 * didn't open, visit:" is wording.
 *
 * The shell is `tr ' \t\r' '\n\n\n'` then a whole-line match, which is what
 * makes "visit: https://…" yield the bare URL. It relies on the capture being
 * `capture-pane -p -J`: tmux has already resolved Claude Code's OSC 8
 * hyperlink to plain text by then, and -J has already rejoined the five lines
 * a 300-character URL wraps onto.
 */
export function readAuthorizeUrl(paneText: string): string {
    for (const token of paneText.split(/[ \t\r\n]+/)) {
        if (token.startsWith('https://') && token.includes('oauth/authorize')) return token
    }
    return ''
}

/**
 * How many times the pane has said a code was no good.
 *
 * Counted rather than matched, because a retry types into the SAME login and
 * the previous refusal is still on the screen — the signal is a NEW one, not
 * the presence of one. `grep -c` counts LINES, so a line carrying both
 * sentences still counts once.
 */
export function countRefusals(paneText: string): number {
    let n = 0
    for (const line of paneText.split('\n')) {
        if (line.includes('Invalid code') || line.includes('Login failed')) n++
    }
    return n
}

export interface LoginCard {
    label: string
    url: string
    timeoutS: number
    session: string
    /** The reason a retry carries, empty on the first ask. */
    again: string
    /**
     * The `Watch it in tmux: <session>:<window>` fragment, empty when there is
     * no window (DROVE-348). ONE FRAGMENT ON THE END OF THE REASON, never a
     * paragraph of its own (DROVE-346): the card's job is still the link and the
     * code field, and this is the answer to "what is it actually doing" for the
     * one person who can walk over to the Mac.
     */
    watch?: string
}

/**
 * The `drover ask` command line the login raises, argument for argument.
 *
 * `--gate account-login` is how the app tells this card apart from an ordinary
 * multiple-choice question and offers a code field and an open-in-browser row
 * instead of Allow and Deny. The URL is the PREVIEW because that is the field
 * every surface renders as the body of the card, and it is what the app hands
 * the browser.
 *
 * ONE URL FOR THE WHOLE RUN. A refused code used to end the login, so a retry
 * had to mint a fresh link and the card the phone already had went dead. In a
 * pane the login survives a refusal and re-prompts, so a retry asks again with
 * the SAME link.
 */
export function loginAskArgv(card: LoginCard): string[] {
    const base = card.again === ''
        ? 'Open this in a browser, sign in, then send back the code it shows.'
        : card.again
    const watch = card.watch ?? ''
    const reason = watch === '' ? base : `${base} ${watch}`
    const argv = [
        `Log in to Claude for ${card.label}`,
        '--reason', reason,
        '--preview', card.url,
        '--option', 'cancel:Cancel the login',
        '--gate', 'account-login',
        '--harness', 'drover',
        '--timeout', String(card.timeoutS),
    ]
    if (card.session !== '') argv.push('--session', card.session)
    return argv
}

/** The retry reason, once a code has been refused. */
export function retryReason(why: string): string {
    return `The last code was refused (${why}). The same link is still open — try again.`
}

/**
 * What a nonzero `drover ask` meant, in the words the card will carry.
 * The codes are drover-ask's: 3 nobody answered, 4 withdrawn, 5 no bus.
 */
export function askFailureWhy(code: number, timeoutS: number): string {
    switch (code) {
        case 3: return `nobody sent the code within ${timeoutS}s`
        case 4: return 'the login prompt was withdrawn'
        case 5: return 'the bus could not be reached, so the URL never left this Mac'
        default: return `the login prompt failed (drover ask exit ${code})`
    }
}

/**
 * SUCCESS MEANS THE CREDENTIAL, NOT THE ADDRESS (DROVE-238).
 *
 * A code Claude Code accepts writes `oauthAccount` into the config dir; the
 * TOKEN is a separate write, to the macOS Keychain, and it does not always
 * land — a login driven from a background daemon is the case that bit. The row
 * used to go in on the first of those, which is how Clay got four accounts
 * that listed fine and stranded every flip.
 */
export function noCredentialWhy(dataDir: string, name: string): string {
    return `the code was accepted and the address was written, but no usable credential landed for ${dataDir}`
        + ' — on macOS the token goes to the Keychain, which a background daemon cannot always write.'
        + ` Nothing was added; run \`drover account login${name === '' ? '' : ` ${name}`}\` again from a terminal on that Mac.`
}

/**
 * The registry row, written only AFTER the code was accepted and the
 * credential verified — which is what makes an abandoned or half-made login
 * leave nothing behind (DROVE-238). Appended, never inserted, so registry
 * order is the order rows were added.
 */
export function registryWith(rows: AccountRow[], name: string, configDir: string): AccountRow[] {
    return [...rows, { name, configDir }]
}

/**
 * A SECOND LOGIN FOR AN ADDRESS THE REGISTRY ALREADY HOLDS (DROVE-251/338).
 *
 * THE EXISTING ROW STANDS. It is not repointed at the fresh directory, for the
 * reason `drover account add` already gives when it refuses the same move: the
 * row may have a session on it this second, the cooldown ledger keys on the
 * name and carries that account's headroom history, and moving a config dir
 * out from under a running subscription to fix a tidiness problem is the worse
 * trade. A second row is refused for the same reason — two rows with one name
 * shadow each other and split one quota's ledger in half.
 *
 * Nothing is deleted. The abandoned directory holds a real credential, and
 * `drover accounts` lists it as an orphan from now on so it stops being
 * invisible.
 */
export function duplicateRefusal(name: string, takenAt: string, dataDir: string, configDir: string): string {
    return `the login worked and it is the account you already have. '${name}' is
  registered at ${takenAt}, so nothing was added — a second row with the same
  name would shadow the first and split its cooldown history in two.
  Use the one that is there:  drover account use ${name}
  This login landed in ${dataDir} instead, and it still holds a credential, so
  \`drover accounts\` now lists it as an orphan. To move the account onto it:
    drover account rm ${name} --harness claude && drover account add ${name} --config-dir ${configDir}`
}

/**
 * Whether a finished login is a duplicate, and of what.
 *
 * BOTH SIDES EXPANDED before they are compared. The registry holds whichever
 * spelling wrote the row — `~/.claude-accounts/account-5` from a nameless add,
 * an absolute path from a hand-passed --config-dir — and a re-login into the
 * directory the row ALREADY points at must fall through silently, not be
 * reported as a duplicate of itself.
 */
export function duplicateOf(
    rows: AccountRow[],
    name: string,
    configDir: string,
    home: string = homedir(),
): { takenAt: string } | null {
    const taken = rowConfigOf(rows, name)
    if (taken === '') return null
    if (accountDataDir(taken, home) === accountDataDir(configDir, home)) return null
    return { takenAt: accountDirLabel(taken, home) }
}

/**
 * The notice card the phone gets when this cannot even start, or when it
 * failed. A notice, fire-and-forget: this is not a question, and blocking on
 * an acknowledgement from a man who has already put his phone down would keep
 * the process alive for nothing. Posted as a `question` with one option
 * because that is the only kind the bridge mirrors into a card today.
 *
 * The TITLE takes a suffix because not every card here is a failure. DROVE-251
 * added one that is not: a login that worked, for an address the registry
 * already holds against another directory. Calling that "failed" is the kind
 * of wording that sent Clay looking for a broken login when the login was fine.
 */
export function notifyPayload(
    label: string,
    reason: string,
    cwd: string,
    session: string,
    suffix: string = 'failed',
): Record<string, unknown> {
    return {
        kind: 'question',
        title: `Claude login for ${label === '' ? 'a new account' : label} ${suffix}`,
        reason,
        preview: reason,
        ttlMs: 300000,
        channel: 'external',
        options: [{ id: 'ok', label: 'OK' }],
        origin: {
            harness: 'drover',
            gate: 'account-login',
            account: null,
            sessionId: session === '' ? null : session,
            cwd,
            surface: null,
        },
    }
}

// =============================================================================
// THE PANE HALF (DROVE-315 wave 4)
// =============================================================================
//
// Everything above is decidable without a tmux window. Everything below drives
// one, and it is here rather than in a second file for the reason the shell
// keeps it in one: the window NAME is the lock, and the thing that computes the
// name has to be the thing that claims it. Two files would be two claims.
//
// IT RUNS IN A NAMED WINDOW ON THE USER'S OWN SERVER, and that is DROVE-348.
// Clay: "I could see a new tmux window and actually watch it do it. Not only
// would that be helpful for debugging, it just sounds like the right way to do
// it." The window is `login-claude-<account>`, opened DETACHED so it never
// steals the view of whoever is attached, and its pane is left OPEN when the
// login exits so the outcome is still there to read. ./harness/droverWindow
// owns all of that, and the cursor login uses the same one — there is exactly
// one window opener here because the shell had exactly one on purpose.
//
// WHAT CLAUDE CODE 2.1.251 DOES IN A PANE, measured 2026-08-31, because it
// decides whether the pane is driveable:
//
//     Opening browser to sign in…
//     If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
//     Paste code here if prompted >
//
// Three things fell out of that measurement and all three are load-bearing.
// `capture-pane -J` returns the URL as PLAIN TEXT, because tmux has already
// resolved the OSC 8 hyperlink by then. A WRONG code no longer ends the login —
// it answers "Invalid code…" and re-prompts on the SAME process, so a retry
// reuses the link the phone already has. And killing the pane ends it.
//
// THE MAC'S BROWSER STAYS SHUT. Claude Code honours $BROWSER, so the login runs
// with BROWSER pointed at /usr/bin/true. Clay is not at the desk; a tab opening
// on an unattended Mac is at best noise and at worst it steals focus on a
// machine he is watching over RustDesk.
//
// PATH IS WHAT WAS ACTUALLY BROKEN. `claude` lives in ~/.local/bin, which is on
// an interactive shell's PATH and NOT on a launchd job's, so every login started
// from the phone died on the `claude` guard, exit 5, with the sentence on a
// stderr the daemon had pointed at /dev/null. The launcher hands this process a
// PATH under DROVER_LOGIN_PATH, and the guards below put a card on the bus
// rather than exiting into silence.
//
// THE CODE IS TYPED INTO A PANE, which is stated rather than hidden.
// `load-buffer` then `paste-buffer` puts the OAuth code on the login's tty, so
// it is briefly on that pane's screen. The pane is on a socket under
// /tmp/tmux-$UID (0700, this user only), it is single-use, and the login is
// stopped the moment it resolves. No credential is written to a file here.
//
// WHAT NODE CHANGES. Every tmux, clock, signal and subprocess call sits behind
// one injectable io, so a test drives every branch without a pane and a double
// that was asked for something unmodelled THROWS. The re-exec into a window
// runs THIS cli rather than `"$0"`. The traps become signal handlers with the
// same exit codes. `drover-trust` and `drover-sync-commands` are still spawned
// from the cattle-drover checkout, because those two verbs have not been ported
// and a second implementation of either would be worse than a spawn.

export const usage = `drover account login — add and log in a Claude account from the phone.

USAGE
  drover account login [name] [options]
      --config-dir <path>   which CLAUDE_CONFIG_DIR to log into. Default: the
                            named account's, or a fresh ~/.claude-accounts/
                            account-N when there is no name.
      --timeout <seconds>   how long the phone has to answer. Default 900.
      --session <id>        attach the prompt to a session, so it shows there
                            as well as in the all-questions view.
      --local               let the Mac's own browser open too. Off by default:
                            this exists to be run while nobody is at the Mac.
      --window              run in a named tmux window on your own server even
                            when you have a terminal, and watch it there.
      --no-window           never open one; run wherever this was started.
      --tries <n>           how many codes to accept before giving up. Default
                            2. A refused code does NOT end the login, so a
                            retry reuses the link the phone already has.

HOW IT RUNS
  It opens a NAMED tmux window on your own server, runs Claude Code's \`claude
  auth login\` in it, reads the URL off the pane, and puts that URL on the bus as
  a question. Whichever surface Clay is on shows it; the code he gets back is
  the answer to that question, and it is typed into the waiting login.

  THE LOGIN IS STOPPED ON EVERY EXIT, and that is the whole list:

    a code that worked        the success path stops it outright
    Cancel on the phone       failure path -> the EXIT trap
    a refused code, a timeout, a withdrawn card, a bus that will not answer
                              same failure path, same trap
    Ctrl-C / Ctrl-\\ / kill    INT, QUIT and TERM traps
    \`drover account rm\`       kills the window, which hangs up this pane; the
                              HUP trap does the rest
    SIGKILL, a reboot         untrappable, so the NEXT run reaps it: a window
                              whose pid is dead and none of whose panes is still
                              running is a corpse, and it is reused rather than
                              stacked beside a second one

  Nothing sweeps on a timer. Every exit is a trap here or the next run's claim.

  THE WINDOW ITSELF OUTLIVES THE LOGIN, on purpose (DROVE-348). What is stopped
  is the login; the pane stays, dead, holding what happened, until you close it
  or start another login for the same account. That is the whole ask: you can
  watch it, and you can read it afterwards.

  Watch one:  switch to the window named login-claude-<account>.

  Nothing here mints, reads, stores or logs a credential. Claude Code does the
  login and Claude Code keeps the token.

WHEN IT FINISHES
  On success the account is CHECKED and only then written to the registry —
  named after the address it logged in as, when you did not name it — and /flip
  is re-synced, so it is in the picker and \`drover accounts\` reads it as ready.

  The check is what "success" now means, and it is not the login exiting well.
  It is: Claude Code's first run is settled for this directory, and \`claude auth
  status\` reads it as signed in. An account that fails it gets a card saying so
  and NO registry row, because a row is a promise that a flip can land there.

  SUCCESS MEANS THE CREDENTIAL, NOT THE ADDRESS (DROVE-238). A code Claude Code
  accepts writes \`oauthAccount\` into the config dir; the TOKEN is a separate
  write, to the macOS Keychain, and it does not always land — a login driven
  from a background daemon is the case that bit. The row used to go in on the
  first of those, which is how Clay got four accounts that listed fine and
  stranded every flip: "it actually showed they added ... it wasn't ACTUALLY
  authenticated." So \`claude auth status\` is asked before anything is written,
  and if it says no the run FAILS: no row, no config dir, and a card that says
  to run it again from a terminal on that Mac. An account this command lists is
  an account that can run.

  On any failure the config dir this command created is removed again, so a
  cancelled login leaves no half-made account, and a card on the phone says
  what went wrong. The login process goes with it, however the run finished —
  a login still waiting on a card nobody holds is the orphan this replaced.

  THE CODE IS ENTERED ON THE ACCOUNTS SCREEN (DROVE-238). The card this posts
  is the mechanism and not the surface: the app draws the same link and the
  same code field inline on the row the login was started from, so the whole
  thing begins and ends in one place. Answering it from the card in the bridge
  thread still works and sends the identical answer.

ONE AT A TIME, PER ACCOUNT
  The tmux window is named for the account being added, so the name IS the
  lock: a second login for the same account is REFUSED, not queued. Two would
  race for the same ~/.claude-accounts/account-N and put two links on one phone
  with nothing to say which code belongs to which. Answer or cancel the first
  one; its card is still there. A window whose run died is REUSED by the next
  one rather than stacked beside it, so a flow started twice leaves one window.
`

// --- arguments ---------------------------------------------------------------

export interface LoginOptions {
    name: string
    configDir: string
    timeoutS: number
    session: string
    localBrowser: boolean
    tries: number
    /** null is the shell's `auto`: a terminal means here, none means a window. */
    wantWindow: boolean | null
    help: boolean
}

export interface LoginParseFailure {
    /** The sentence `die` prints, WITHOUT its `drover account login: ` prefix. */
    die: string
    code: number
}

export function isLoginParseFailure(v: LoginOptions | LoginParseFailure): v is LoginParseFailure {
    return (v as LoginParseFailure).die !== undefined
}

/**
 * WHICH HARNESS, decided before anything else is parsed (DROVE-256).
 *
 * `--harness cursor` is a different login end to end — cursor-agent polls
 * instead of taking a code back, keeps one machine-wide credential instead of
 * one per config dir, and has no config dir at all — so it is a sibling module
 * rather than a branch through this one.
 *
 * Scanned across the WHOLE argument list rather than matched positionally,
 * because `drover account login jam --harness cursor` and `drover account login
 * --harness cursor jam` are the same request and refusing one of them would be a
 * puzzle rather than a rule.
 *
 * Answers: 'claude', 'cursor', or the offending word to refuse. A trailing
 * `--harness` with nothing after it is NOT refused here — the option loop says
 * "--harness needs a value", which is the more useful sentence.
 */
export function scanHarness(argv: readonly string[]): { harness: 'claude' | 'cursor' } | { bad: string } {
    let want = false
    for (const arg of argv) {
        if (want) {
            if (arg === 'cursor') return { harness: 'cursor' }
            if (arg === 'claude' || arg === '') {
                want = false
                continue
            }
            return { bad: arg }
        }
        if (arg === '--harness') want = true
    }
    return { harness: 'claude' }
}

/**
 * The option loop, one for one with the shell's.
 *
 * THE NAME IS FIRST-POSITION ONLY here, unlike the cursor sibling: the shell
 * takes it with a `case "${1:-}"` before the loop, and anything else that is
 * not an option reaches the loop's catch-all and dies as an unknown option.
 * That asymmetry is real and is kept, because `drover account login a b` saying
 * "unknown option 'b'" is what tests/login.bats pins.
 */
export function parseLoginArgs(argv: readonly string[]): LoginOptions | LoginParseFailure {
    const o: LoginOptions = {
        name: '',
        configDir: '',
        timeoutS: 900,
        session: '',
        localBrowser: false,
        tries: 2,
        wantWindow: null,
        help: false,
    }
    let rawTimeout = '900'
    let rawTries = '2'
    const args = [...argv]
    const first = args[0] ?? ''
    if (first !== '' && !first.startsWith('-')) {
        o.name = first
        args.shift()
    }
    const needVal = (flag: string): LoginParseFailure | null =>
        (args.length >= 2 ? null : { die: `${flag} needs a value`, code: 2 })
    while (args.length > 0) {
        const a = args[0]
        if (a === '--config-dir') {
            const bad = needVal(a)
            if (bad) return bad
            o.configDir = args[1]
            args.splice(0, 2)
            continue
        }
        if (a === '--timeout') {
            const bad = needVal(a)
            if (bad) return bad
            rawTimeout = args[1]
            args.splice(0, 2)
            continue
        }
        if (a === '--session') {
            const bad = needVal(a)
            if (bad) return bad
            o.session = args[1]
            args.splice(0, 2)
            continue
        }
        if (a === '--tries') {
            const bad = needVal(a)
            if (bad) return bad
            rawTries = args[1]
            args.splice(0, 2)
            continue
        }
        if (a === '--harness') {
            // Already resolved by the scan above; `cursor` was delegated and
            // only `claude` reaches here. Consumed rather than refused so the
            // flag can be passed unconditionally by a caller that does not care.
            const bad = needVal(a)
            if (bad) return bad
            args.splice(0, 2)
            continue
        }
        if (a === '--window') { o.wantWindow = true; args.shift(); continue }
        if (a === '--no-window') { o.wantWindow = false; args.shift(); continue }
        if (a === '--local') { o.localBrowser = true; args.shift(); continue }
        if (a === '-h' || a === '--help') { o.help = true; return o }
        return { die: `unknown option '${a}' (try --help)`, code: 2 }
    }
    if (rawTimeout === '' || rawTimeout.match(/[^0-9]/)) {
        return { die: '--timeout takes whole seconds', code: 2 }
    }
    o.timeoutS = Number(rawTimeout)
    if (rawTries === '' || rawTries.match(/[^0-9]/) || rawTries === '0' || Number(rawTries) === 0) {
        return { die: '--tries takes a whole number of attempts, at least 1', code: 2 }
    }
    o.tries = Number(rawTries)
    return o
}

/**
 * The refusal for an ambient --config-dir. The ambient login is ~/.claude —
 * Clay's main account — and a remote login into it would replace the account
 * every unwrapped `claude` on this Mac uses, from a phone, with no way to undo
 * it from there.
 */
export function ambientRefusal(configDir: string): string {
    return `'${configDir}' is the ambient login (~/.claude), which this command will not
  touch: replacing your main account from a phone is not undoable from a phone.
  Name a different config dir, or log that one in at the Mac.`
}

/** The refusal for a config dir that is not somewhere fixed. */
export function relativeRefusal(configDir: string): string {
    return `--config-dir '${configDir}' is relative, and a config dir has to be somewhere fixed`
}

/** The two verify failures, which leave NO row and say which half went wrong. */
export function verifyRefusal(why: string, dataDir: string): string {
    if (why === 'first-run') {
        return `the login was accepted, but ${dataDir} has not been through Claude Code's
  first run, so a session there would open the theme picker instead of a
  prompt. Nothing was added to the registry. Run \`drover trust\` and add it
  again.`
    }
    return `the login was accepted, but Claude Code does not read ${dataDir} as
  signed in — \`claude auth status\` says no. The credential did not land where
  a session would look for it. Nothing was added to the registry.`
}

// --- the io -------------------------------------------------------------------

/** A `drover ask` in flight. Blocking here, unlike the cursor login's. */
export interface LoginAsk {
    done: Promise<{ code: number; text: string }>
    stop: () => void
}

export interface AccountLoginIo {
    env: NodeJS.ProcessEnv
    cwd: string
    pid: number
    isTty: () => boolean
    out: (line: string) => void
    err: (line: string) => void
    window: DroverWindow
    which: (name: string) => string | null
    now: () => number
    sleep: (ms: number) => Promise<void>
    alive: (pid: number) => boolean
    signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void
    mkdtemp: (prefix: string) => string
    rmrf: (path: string) => void
    notify: (payload: Record<string, unknown>) => Promise<void>
    ask: (argv: string[], tmp: string) => LoginAsk
    /** The argv the window re-exec runs. `"$0" $login_argv` in the shell. */
    selfCommand: (argv: readonly string[]) => string[]
    /** A sibling shell verb, run for its side effect and never for its status. */
    sibling: (name: string, args: string[]) => void
    onSignal: (handler: (name: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT') => void) => void
}

/** The real process. Never used by a test. */
export function defaultAccountLoginIo(): AccountLoginIo {
    const window = new DroverWindow(defaultWindowIo())
    return {
        env: process.env,
        cwd: process.cwd(),
        pid: process.pid,
        isTty: () => Boolean(process.stdout.isTTY),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        window,
        which: (name) => {
            for (const dir of (process.env.PATH ?? '').split(delimiter)) {
                if (!dir) continue
                const candidate = join(dir, name)
                if (existsSync(candidate)) return candidate
            }
            return null
        },
        now: () => Math.floor(Date.now() / 1000),
        sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.() }),
        alive: (pid) => {
            try {
                process.kill(pid, 0)
                return true
            } catch {
                return false
            }
        },
        signal: (pid, sig) => {
            try {
                process.kill(pid, sig)
            } catch {
                // `kill … 2>/dev/null || :`.
            }
        },
        mkdtemp: (prefix) => mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix)),
        rmrf: (path) => {
            try {
                rmSync(path, { recursive: true, force: true })
            } catch {
                // `rm -rf … 2>/dev/null || :`.
            }
        },
        notify: async (payload) => {
            try {
                await busPost('/v1/events', payload, 5_000)
            } catch {
                // `|| :`. A bus that is down is not a reason to keep a process
                // alive, and the sentence is already going to stderr.
            }
        },
        ask: (argv, tmp) => {
            const entry = process.argv[1] ?? ''
            const child = spawn(process.execPath, [entry, 'ask', ...argv], {
                env: { ...process.env, TMPDIR: tmp },
                stdio: ['ignore', 'pipe', 'inherit'],
            })
            let text = ''
            child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
            const done = new Promise<{ code: number; text: string }>((resolve) => {
                child.on('close', (code) => resolve({ code: code ?? 1, text: text.replace(/\n+$/, '') }))
                child.on('error', () => resolve({ code: 1, text: '' }))
            })
            return {
                done,
                stop: () => {
                    try {
                        child.kill('SIGTERM')
                    } catch {
                        // Already gone.
                    }
                },
            }
        },
        selfCommand: (argv) => [process.execPath, process.argv[1] ?? '', 'account-login', ...argv],
        sibling: (name, args) => {
            const path = join(droverEnv().droverDir, 'libexec', name)
            if (!existsSync(path)) return
            try {
                spawnSync(path, args, { stdio: 'ignore' })
            } catch {
                // `>/dev/null 2>&1 || :` — the login succeeded, and a wizard is
                // a worse outcome than this line not running, not a reason to
                // undo a login that worked.
            }
        },
        onSignal: (handler) => {
            process.on('SIGINT', () => handler('SIGINT'))
            process.on('SIGTERM', () => handler('SIGTERM'))
            process.on('SIGHUP', () => handler('SIGHUP'))
            process.on('SIGQUIT', () => handler('SIGQUIT'))
        },
    }
}

// --- the run ------------------------------------------------------------------

function die(io: AccountLoginIo, why: string, code: number = 2): number {
    io.err(`drover account login: ${why}`)
    return code
}

export async function run(args: string[], io: AccountLoginIo = defaultAccountLoginIo()): Promise<number> {
    const scanned = scanHarness(args)
    if ('bad' in scanned) {
        return die(io, `unknown harness '${scanned.bad}' — this logs in claude or cursor accounts`)
    }
    if (scanned.harness === 'cursor') {
        // `exec "$self/drover-cursor-login" "$@"` — the WHOLE original argv,
        // because the sibling parses `--harness cursor` out for itself and
        // accepts the name on either side of it.
        const { run: cursorLogin } = await import('./cursor-login')
        return cursorLogin(args)
    }

    const parsed = parseLoginArgs(args)
    if (isLoginParseFailure(parsed)) return die(io, parsed.die, parsed.code)
    if (parsed.help) {
        io.out(usage.trimEnd())
        return 0
    }
    const o = parsed

    const env = io.env
    const cfg = droverEnv(env)
    const registry = env.DROVER_ACCOUNTS || cfg.accounts
    const home = env.HOME || homedir()

    let label = ''
    const notifyFailed = async (reason: string, suffix: string = 'failed'): Promise<void> => {
        await io.notify(notifyPayload(label, reason, io.cwd, o.session, suffix))
    }

    // THE PATH THE LAUNCHER MEANT, under a name tmux will actually deliver.
    // `tmux new-window -e PATH=…` does NOT reach the pane (measured on 3.7c:
    // show-environment reports it and the pane's own $PATH is the SERVER's), so
    // the launcher hands the login PATH over under its own name and it is
    // applied here. Without this line the guard below still fails on a login
    // started from the daemon.
    if (env.DROVER_LOGIN_PATH) env.PATH = env.DROVER_LOGIN_PATH

    if (io.which('jq') === null) return die(io, 'jq is required (brew install jq)', 5)

    // See PATH above. This is the guard the phone login was dying on, and the
    // reason it looked like a hang rather than a failure.
    if (io.which('claude') === null) {
        await notifyFailed('claude is not on this process\'s PATH, so there is no login to open. It is usually in ~/.local/bin, which a launchd daemon does not inherit.')
        return die(io, 'claude is not on PATH, so there is no login to open', 5)
    }
    if (io.which('tmux') === null) {
        await notifyFailed('tmux is not on this process\'s PATH, and the login runs in a tmux window.')
        return die(io, 'tmux is required: the login runs in a tmux window', 5)
    }

    // --- INTO A WINDOW YOU CAN WATCH, when nobody is watching this -----------
    //
    // WITH A TERMINAL this runs here, because the terminal IS the window and
    // moving the narration somewhere else would be drover taking a screen away
    // rather than giving one. The login itself still gets its own named window
    // below, which is what he watches.
    //
    // WITHOUT ONE — the daemon, the app, a cron — this re-execs itself into that
    // window, so the wrapper's own output lands somewhere a human can read it.
    //
    // THE PLACEHOLDER NAME. A nameless add does not know which account-N it will
    // land on until the config dir is resolved inside the window, so it opens
    // under `login-claude-new` and the claim renames it the moment it knows.
    // tmux refuses a rename onto a name in use, so the lock holds either way.
    const window = io.window
    const wantWindow = o.wantWindow === null ? !io.isTty() : o.wantWindow
    if (wantWindow && !env.DROVER_LOGIN_WINDOW) {
        const bootWin = loginWindowName('claude', o.name === '' ? 'new' : o.name)
        window.envReset()
        window.envAdd('DROVER_LOGIN_WINDOW', bootWin)
        for (const name of loginWindowBootVars) {
            const value = env[name]
            if (value) window.envAdd(name, value)
        }
        const opened = window.open(bootWin, home, io.selfCommand(args))
        if (opened.status === 0) {
            io.out(`drover account login: running in ${window.target(bootWin) ?? bootWin}`)
            return 0
        }
        // A window that could not be opened is not a reason to refuse a login.
        io.err('drover account login: could not open a tmux window — running here, where only this process can see it.')
    }

    // --- where the login lands -----------------------------------------------
    //
    // Resolved BEFORE the lock, because the lock is named after it. The old lock
    // was a file and could be taken before anybody knew which account was being
    // added; the window name is a pure function of the account, which is what
    // makes it a lock at all.
    let rows: AccountRow[]
    try {
        rows = jsonRead<AccountRow[]>(registry, [])
    } catch (error) {
        if (error instanceof NotJsonError) {
            io.err(error.message)
            return 1
        }
        throw error
    }
    let configdir = o.configDir
    if (configdir === '' && o.name !== '') configdir = rowConfigOf(rows, o.name)
    if (configdir === '') {
        const next = nextConfigDir(rows, (spelling) => accountLoggedIn(spelling, home), home)
        if (next === null) return die(io, 'every ~/.claude-accounts/account-N up to 999 is taken')
        configdir = next
    }

    if (isAmbient(configdir, home)) return die(io, ambientRefusal(configdir))

    const datadir = accountDataDir(configdir, home)
    if (!datadir.startsWith('/')) return die(io, relativeRefusal(configdir))

    if (accountLoggedIn(configdir, home)) {
        const who = accountEmail(configdir, home)
        return die(io, `${datadir} is already logged in${who === undefined ? '' : ` as ${who}`} — nothing to do.`, 0)
    }

    label = o.name === '' ? configdir : o.name

    // --- the tmux window, which is also the lock ------------------------------
    //
    // The window name is a pure function of WHICH account is being added and
    // nothing else — not the pid, not the time, not the caller. That is what
    // makes it the lock. A named add is `login-claude-<name>`; a nameless one is
    // named for the config dir it picked, `login-claude-account-3`.
    const win = loginWindowName('claude', o.name === '' ? basename(datadir) : o.name)
    const inherited = Boolean(env.DROVER_LOGIN_WINDOW)

    if (!claimLoginWindow(io, win, inherited, env.DROVER_LOGIN_WINDOW ?? '')) {
        return die(io, `a login for ${label} is already waiting on this machine.
  Answer or cancel that one first — its card is still on the phone, and the
  Accounts screen shows the link it already has. Watch it in tmux:
      ${window.target(win) ?? win}`, 3)
    }
    stampLoginDriver(io, win)

    const ctx: Ctx = { ...editContext(env), out: io.out, err: io.err }

    // Did WE make this directory? Only then may a failure remove it again. A dir
    // that was already there belongs to somebody else's half-finished add.
    let created = false
    if (!existsSync(datadir)) {
        try {
            mkdirSync(datadir, { recursive: true })
        } catch {
            return die(io, `could not make ${datadir}`, 1)
        }
        created = true
    }

    // Point a brand-new config dir at the shared session store, when there is
    // one, so a flip onto this account can resume a session the others can see
    // (DROVE-40/DROVE-59). A real projects/ directory is never replaced.
    const shareStore = droverVar('DROVER_SHARED_STORE', join(home, '.claude-shared'), env, home)
    if (existsSync(join(shareStore, 'projects')) && !existsSync(join(datadir, 'projects'))) {
        try {
            symlinkSync(join(shareStore, 'projects'), join(datadir, 'projects'))
        } catch {
            // A store that could not be linked is not a reason to refuse a login.
        }
    }

    // SETTLE CLAUDE CODE'S FIRST RUN, before anything opens a pane on this dir.
    //
    // A config dir that has never run interactively opens on the onboarding
    // wizard — the pig, "Let's get started", seven theme options — before it
    // does anything at all. Clay added accounts from the phone, the app said
    // they were added, and every flip onto one landed in a theme picker with
    // nothing to say why.
    //
    // BEFORE the login and not after, for two separate reasons. The login runs
    // `claude auth login` in a pane, so an unsettled dir can put the wizard in
    // front of the login too. And a flip can follow the success card by seconds.
    settleFirstRun(ctx, configdir)

    let work = ''
    let ask: LoginAsk | null = null
    let loginPane = ''
    let started = false

    const dropWork = (): void => {
        if (work === '') return
        io.rmrf(work)
        work = ''
    }
    const stopAsk = (): void => {
        if (ask === null) return
        ask.stop()
        ask = null
    }
    /**
     * Everything this command created, undone. AC: a login that fails or is
     * abandoned leaves no half-made account — no registry row (none is written
     * until the login succeeds) and no directory we made.
     *
     * Never rm -rf a directory that has a WORKING login in it. The test used to
     * be "is there an oauthAccount", and that is how the phantoms survived
     * (DROVE-238): a run whose code was accepted and whose credential never
     * landed left an address behind, this read it as a real login and kept the
     * directory, and the next add then skipped that account-N for the same
     * reason. `could not tell` keeps the directory too — deleting a login
     * because a probe could not run is the one mistake here that cannot be
     * undone from a phone.
     */
    const cleanupFailed = (): void => {
        if (!created) return
        if (credentialOk(ctx, configdir) !== 1) {
            created = false
            return
        }
        try {
            unlinkSync(join(datadir, 'projects'))
        } catch {
            // Not a link, or already gone.
        }
        io.rmrf(datadir)
    }
    /**
     * stop_login — end the login, whatever happened, and LEAVE THE PANE.
     *
     * LIVENESS BEFORE THE SIGNAL, and this is a measured bug rather than an
     * ordering preference. Under remain-on-exit a DEAD pane still answers
     * `#{pane_pid}` with the pid its command had, and that pid has been free to
     * be reused since the moment it exited. Signalling it kills whatever holds
     * it now: the first version of this killed the bats runner itself,
     * reproducibly.
     */
    const stopLogin = async (): Promise<void> => {
        if (!started) return
        started = false
        if (loginPane === '') return
        if (!window.paneLive(loginPane)) return
        const shown = window.tmux(['display-message', '-p', '-t', loginPane, '#{pane_pid}'])
        const raw = shown.stdout.replace(/\n+$/, '')
        if (raw === '' || raw.match(/[^0-9]/)) return
        const pid = Number(raw)
        io.signal(pid, 'SIGTERM')
        for (let n = 0; n < 20; n++) {
            if (!window.paneLive(loginPane)) return
            await io.sleep(100)
        }
        if (!window.paneLive(loginPane)) return
        io.signal(pid, 'SIGKILL')
    }

    // EVERY EXIT, and the list is the point (DROVE-238):
    //
    //   normal end     success, `die`, `fail`, a timeout, a refused code
    //   Ctrl-C         INT  130
    //   `kill`         TERM 143   what a supervisor sends
    //   hang-up        HUP  129   what tmux sends this pane when its window is
    //                             killed, which is a real path: `drover account
    //                             rm` reaps a waiting login that way
    //   Ctrl-\         QUIT 131   the other keystroke that kills a foreground run
    //   SIGKILL        —          untrappable. Covered by the next run's claim.
    io.onSignal((name) => {
        stopAsk()
        void stopLogin()
        dropWork()
        cleanupFailed()
        process.exitCode = name === 'SIGINT' ? 130 : name === 'SIGTERM' ? 143 : name === 'SIGHUP' ? 129 : 131
    })

    const finish = async (code: number): Promise<number> => {
        stopAsk()
        await stopLogin()
        dropWork()
        cleanupFailed()
        return code
    }

    try {
        work = io.mkdtemp('drover-login.')
    } catch {
        return await finish(die(io, 'could not make a working directory', 1))
    }

    let why = ''
    const fail = async (reason: string): Promise<number> => {
        await notifyFailed(reason)
        return await finish(die(io, reason, 1))
    }

    // --- driving the pane ----------------------------------------------------
    //
    // The binary is resolved to an ABSOLUTE path rather than left to the pane's
    // PATH. The pane inherits the tmux SERVER's environment, which is whatever
    // the first client on this socket happened to have, and a login that works
    // or not depending on who opened the server first is the PATH bug wearing a
    // different hat. That matters MORE on the user's own server, not less: it
    // has been up for days and carries whichever terminal started it.
    //
    // An inherited API key authenticates as the metered API and the login then
    // has nothing to do, so both variables are cleared in the pane.
    const paneText = (): string => (loginPane === '' ? '' : window.capture(loginPane))
    const startLogin = (): boolean => {
        const bin = io.which('claude')
        if (bin === null) return false
        window.envReset()
        window.envAdd('CLAUDE_CONFIG_DIR', datadir)
        if (!o.localBrowser) window.envAdd('BROWSER', '/usr/bin/true')
        const command = ['sh', '-c',
            'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; exec "$0" auth login', bin]
        if (inherited) {
            // A SECOND PANE in the window this wrapper is already running in, so
            // one named window holds both halves. $TMUX_PANE is ours by
            // construction here; the window's first pane is the fallback for a
            // launcher that opened the window without running us in it.
            const into = env.TMUX_PANE || window.pane(win) || ''
            if (into === '') return false
            const pane = window.add(into, command)
            if (pane === null) return false
            loginPane = pane
        } else {
            const opened = window.open(win, home, command)
            if (opened.status !== 0) return false
            loginPane = opened.pane
        }
        if (loginPane === '') return false
        started = true
        stampLoginDriver(io, win)
        return true
    }

    /**
     * The code, into the waiting login. `load-buffer` then `paste-buffer` rather
     * than `send-keys -l`, for the same reason engine/sender.js uses it: a code
     * is arbitrary text and send-keys reads a leading dash as a flag. `-d` drops
     * the buffer as it pastes, so the code does not sit in tmux's paste history.
     *
     * The code never reaches this process's stdout or a log. It goes from the
     * card to a tmux buffer to the pane, and the buffer is dropped as it lands.
     */
    const sendCode = (code: string): boolean => {
        const loaded = window.tmux(['load-buffer', '-b', 'drover-login', '-'], code)
        if (loaded.status !== 0) return false
        if (window.tmux(['paste-buffer', '-d', '-b', 'drover-login', '-t', loginPane]).status !== 0) return false
        return window.tmux(['send-keys', '-t', loginPane, 'Enter']).status === 0
    }

    /**
     * THE CREDENTIAL, ONCE THE IDENTITY IS THERE (DROVE-238).
     *
     * The identity and the secret are two separate writes. Claude Code puts
     * `oauthAccount` in .claude.json and the token in the macOS Keychain, and
     * only the first is a file this can see. So the identity appearing is the
     * SIGNAL that the code went through; it is not the ANSWER to whether the
     * account works. `could not tell` (2) is accepted rather than refused: on a
     * machine where the probe cannot run this has to behave the way it did
     * before, not refuse every login.
     *
     * 0 in, 1 the code was no good and another may be worth trying, 2 the code
     * WAS good and the login still cannot run. Two is terminal on purpose:
     * retyping a code Claude Code already accepted changes nothing.
     */
    const verifyCredential = (): 0 | 2 => {
        const { rc } = credentialWait(ctx, configdir, 20)
        if (rc === 0 || rc === 2) return 0
        why = noCredentialWhy(datadir, o.name)
        return 2
    }
    const waitForLogin = async (badBefore: number): Promise<0 | 1 | 2> => {
        for (let n = 0; n < 240; n++) {
            if (accountLoggedIn(configdir, home)) return verifyCredential()
            if (countRefusals(paneText()) > badBefore) {
                why = 'the code was refused — Claude Code says the full code was not copied'
                return 1
            }
            // A pane that has FINISHED still exists under remain-on-exit, so
            // `#{pane_dead}` is the liveness question now (DROVE-348).
            if (!window.paneLive(loginPane)) break
            await io.sleep(250)
        }
        if (accountLoggedIn(configdir, home)) return verifyCredential()
        why = 'the code was accepted but no login was written'
        return 1
    }

    if (!startLogin()) return await fail('could not open the tmux session for the login')

    // Wait for the URL. Claude Code prints it before it prompts, so the URL
    // appearing is also the signal that stdin is about to be read.
    //
    // THE SAME LINK TWICE, 250ms apart, before it is believed. The pane is a
    // live screen and a poll can land in the middle of a repaint, which would
    // hand the phone a truncated authorize URL. That is worse than reading none:
    // it is a card that opens, a page that refuses, and a login that looks
    // broken rather than a read that was.
    let url = ''
    let seen = ''
    for (let waited = 0; waited < 120; waited++) {
        url = readAuthorizeUrl(paneText())
        if (url !== '' && url === seen) break
        seen = url
        if (url === '' && !window.paneLive(loginPane)) {
            const tail = loginPaneTail(paneText())
            return await fail(tail === '' ? 'claude auth login exited before printing a login URL' : tail)
        }
        await io.sleep(250)
    }
    if (url === '') return await fail('claude auth login printed no login URL within 30s')

    // --- the prompt on the phone ---------------------------------------------
    //
    // AND IT SAYS WHERE TO WATCH IT (DROVE-348). One fragment appended to the
    // reason, not a paragraph (DROVE-346): the card's job is still the link and
    // the code field, and the window name is the answer to "what is it actually
    // doing" for the one person who can walk over to the Mac.
    const watch = window.watch(win) ?? ''
    let ok = false
    let again = ''
    for (let n = 0; n < o.tries; n++) {
        const argv = loginAskArgv({ label, url, timeoutS: o.timeoutS, session: o.session, again, watch })
        ask = io.ask(argv, work)
        const answered = await ask.done
        ask = null
        if (answered.code !== 0) {
            why = askFailureWhy(answered.code, o.timeoutS)
            break
        }
        if (answered.text === 'cancel') {
            why = 'cancelled from the phone'
            break
        }
        const badBefore = countRefusals(paneText())
        if (!sendCode(answered.text)) {
            why = 'the login window went away before the code could be typed into it'
            break
        }
        const rc = await waitForLogin(badBefore)
        if (rc === 0) {
            ok = true
            break
        }
        // 2 means the code worked and the credential did not land. Another code
        // cannot fix that, and asking for one would spend Clay's attention on a
        // retry that is already decided (DROVE-238).
        if (rc === 2) break
        again = retryReason(why)
    }

    if (!ok) return await fail(why)

    // THE ROW IS CONDITIONAL ON A REAL CHECK, and this is the other half of
    // DROVE-246. Until now "success" meant Claude Code had written an
    // oauthAccount key into a file, and that is not the same claim as "a session
    // can start on this account".
    //
    // A FAILURE HERE IS LOUD AND LEAVES NO ROW. The directory is NOT removed: at
    // this point the login succeeded, so there is a real credential and a real
    // keychain item behind it, and throwing the directory away would orphan
    // them. `unknown` (exit 2) is not a failure — a check that did not run must
    // not be read as a check that failed.
    const verified = verifyWait(ctx, configdir)
    if (verified.rc === 1) {
        // The directory is NOT removed here by fiat: `finish` runs the same
        // cleanup the shell's EXIT trap does, and that asks Claude Code whether
        // a credential landed before it deletes anything. At this point the
        // login succeeded, so there is a real credential and a real keychain
        // item behind it and the probe keeps the directory — and `could not
        // tell` keeps it too, because deleting a login because a probe could not
        // run is the one mistake here that cannot be undone from a phone.
        return await fail(verifyRefusal(verified.why, datadir))
    }

    // Logged in. Nothing to undo any more, but the login still has to go: it is
    // the one thing on this path that would outlive the card.
    stopAsk()
    await stopLogin()
    dropWork()
    created = false

    const mail = accountEmail(configdir, home)
    const final = o.name !== '' ? o.name : (mail ?? '')
    if (final === '') {
        return die(io, `logged in, but Claude Code recorded no address, so there is
  nothing to name the account after. The config dir is ${datadir} — name it
  yourself:  drover account add <name> --config-dir ${configdir}`, 1)
    }

    // The registry row is written only now — after the code was accepted AND the
    // credential was verified — which is what makes an abandoned or half-made
    // login leave nothing behind (DROVE-238).
    let current: AccountRow[]
    try {
        current = jsonRead<AccountRow[]>(registry, [])
    } catch (error) {
        if (error instanceof NotJsonError) {
            io.err(error.message)
            return 1
        }
        throw error
    }
    // `taken` is the ROW'S SPELLING, not "is there a row", and the difference is
    // the shell's: `.configDir // "default"` leaves an explicitly empty spelling
    // empty, and an empty `taken` appends. Written the shell's way rather than
    // as `accountRow(...) === null`, which would disagree on exactly that row.
    const taken = rowConfigOf(current, final)
    if (taken === '') {
        try {
            jsonWrite(registry, registryWith(current, final, configdir))
        } catch {
            return die(io, `logged in, but could not write ${registry}`, 1)
        }
    } else if (accountDataDir(taken, home) !== datadir) {
        // NAMED BY ITS REAL DIRECTORY (DROVE-338): the row's spelling resolved
        // and tilde-spelled, "~/.claude (default)" for the ambient one. Never
        // the raw field, which reads "default" for anything that omits it.
        const said = duplicateRefusal(final, accountDirLabel(taken, home), datadir, configdir)
        await notifyFailed(said, 'was already an account')
        return die(io, said, 1)
    }

    // AND PRE-ACCEPT THE FIRST-RUN WIZARD, before anything flips onto it
    // (DROVE-238). `claude auth login` does not write `hasCompletedOnboarding`,
    // so the account this just made is credentialled and NOT onboarded, and the
    // first flip onto it lands in the theme picker. It cannot wait for the next
    // `bin/drover`, because a flip is a config-dir swap and a respawn and never
    // re-enters the wrapper.
    //
    // The empty argument means "no project": there is no checkout to trust here,
    // only the account.
    io.sibling('drover-trust', [''])
    // Give the new account /flip straight away rather than at its second run,
    // and make the picker see it now rather than at the next scan (DROVE-59).
    io.sibling('drover-sync-commands', [])

    io.out(`logged in as ${mail ?? final} -> ${configdir}`)
    return 0
}

/**
 * The last three non-empty lines of the pane, space-joined — the shell's
 * `grep . | tail -3 | tr '\n' ' '`, trailing space and all, because these
 * sentences are compared byte for byte and a trimmed one is a different string.
 */
export function loginPaneTail(paneText: string): string {
    const lines = paneText.split('\n').filter((l) => l !== '')
    if (lines.length === 0) return ''
    return `${lines.slice(-3).join(' ')} `
}

/**
 * Is a login already in flight for this account?
 *
 * The whole of the old locking, which was a file holding two pids and a start
 * time, a `lock_live` that re-checked `ps` output so a recycled pid could not
 * get a stranger killed, a TERM-then-KILL reaper, and a truncate-don't-unlink
 * rule. All of it is this, because tmux already owns both halves: the name
 * either exists or it does not, and killing it takes everything inside with it.
 *
 * The launcher cannot know which account-N a nameless add will pick, so on the
 * phone path it opens the window under a placeholder name and this claims the
 * real one by RENAMING into it. tmux refuses a rename onto a name in use, so the
 * claim is atomic either way.
 *
 * Two questions decide whether a name already taken is a live login or a corpse,
 * and the order is the point. The pid on the window answers the first. Whether
 * any pane in it is STILL RUNNING answers the second, and it covers the moment
 * between the launcher opening a window and this stamping its pid on it.
 *
 * A CORPSE IS REUSED, NOT KILLED (DROVE-348).
 */
export function claimLoginWindow(io: AccountLoginIo, win: string, inherited: boolean, opened: string): boolean {
    const window = io.window
    if (inherited) {
        if (win === opened) return true
        const from = window.target(opened)
        if (from === null) return false
        if (window.tmux(['rename-window', '-t', from, win]).status !== 0) return false
        window.stamp(win)
        return true
    }
    if (!window.exists(win)) return true
    const target = window.target(win)
    if (target === null) return false
    const shown = window.tmux(['show-options', '-w', '-t', target, '-qv', '@drover-login-pid'])
    const pid = shown.stdout.replace(/\n+$/, '')
    if (pid !== '' && !pid.match(/[^0-9]/) && io.alive(Number(pid))) return false
    if (!window.idle(win)) return window.kill(win)
    return true
}

/**
 * `@drover-login-pid` — who is driving, stamped the moment the name is ours
 * rather than when the login starts. Between those two this process makes a
 * directory and settles Claude Code's first run, and a window carrying no pid
 * through that window of time reads to the NEXT run as a corpse. It is only ever
 * asked whether it is still there; nothing kills it.
 */
export function stampLoginDriver(io: AccountLoginIo, win: string): void {
    const target = io.window.target(win)
    if (target === null) return
    io.window.tmux(['set-option', '-w', '-t', target, '@drover-login-pid', String(io.pid)])
}
