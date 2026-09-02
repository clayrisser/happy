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

import { homedir } from 'node:os'

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
    const reason = card.again === ''
        ? 'Open this in a browser, sign in, then send back the code it shows.'
        : card.again
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
