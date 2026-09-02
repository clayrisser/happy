/**
 * Starting a Claude account login on the Mac, from the phone (DROVE-61).
 *
 * Adding a subscription was terminal-only. `drover account add` runs Claude
 * Code's login IN the terminal and blocks on it, so the one moment Clay
 * actually needs another account — away from the desk, out of headroom — was
 * the one moment he could not add one.
 *
 * `drover account login` is the headless half of that, and this is the button
 * that starts it. Everything after the start happens on the bus: the URL
 * Claude Code prints arrives on the phone as a question carrying
 * `origin.gate = "account-login"`, and the code is that question's text answer.
 * So this RPC does one thing — start the login and get out of the way. It does
 * NOT wait: a login lasts as long as a human takes, and an RPC that held the
 * socket open for fifteen minutes would time out long before the card was
 * answered.
 *
 * IT STARTS IN A TEMPORARY TMUX SESSION, and that is Clay's ruling on
 * DROVE-212: "why doesn't it open a temporary tmux session to do this?". What
 * it replaces was this —
 *
 *     spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' })
 *
 * with a comment saying the child's streams could go nowhere because "the only
 * thing anyone needs to see from it is the card it puts on the bus". That
 * assumption is what made this ticket take three passes. WHEN THE CARD DOES
 * NOT ARRIVE THERE IS NOTHING TO LOOK AT, so every diagnosis had to reproduce
 * the login by hand in a terminal — where it worked, because a terminal is the
 * one environment that does not have the bug.
 *
 * THE BUG, measured 2026-08-31 against the running bridge's own environment:
 * `claude` lives in ~/.local/bin, and that directory is on an interactive
 * shell's PATH and NOT on a launchd job's. So `drover account login` reached
 * its `command -v claude` guard, exited 5 with "claude is not on PATH", and
 * put the sentence on a stderr this function had pointed at /dev/null. The
 * phone's Accounts screen sat on "Waiting for the sign-in link…" because from
 * where it stood nothing had happened at all. src/cursor/cursorBin.ts carries
 * the identical finding about cursor-agent, which is why the login PATH below
 * is built the way it is rather than left to inheritance.
 *
 * In a tmux session both halves stop being invisible: the pane holds the
 * wrapper's output AND `claude auth login`'s, `tmux capture-pane` is how the
 * shell reads the authorize URL back, `tmux kill-window` reaps the whole
 * process group without a pid file, and the session NAME is the lock on a
 * second concurrent login.
 *
 * AND THE WRAPPER NOW OPENS ITS OWN WINDOW (DROVE-348), which is why this file
 * got smaller. It used to build the whole `tmux -L drover-login new-session`
 * command line here, on a PRIVATE socket chosen so a login pane would never
 * appear among Clay's projects. He overruled that: "I could see a new tmux
 * window and actually watch it do it. Not only would that be helpful for
 * debugging, it just sounds like the right way to do it."
 *
 * So the login lives in a named window on the USER'S server, and the shell
 * wrapper puts itself there: started with no terminal — which is exactly what a
 * daemon spawn is — `drover account login` re-execs into
 * `login-<harness>-<account>` and runs the login in a second pane of the same
 * window. One implementation of "which window", in the file that also owns the
 * lock, instead of two that have to agree across a language boundary.
 *
 * What is left here is a plain detached spawn and ONE question asked of tmux
 * before it: is a window for this account already open with something running
 * in it? That is worth keeping in TypeScript because the answer has to reach
 * the phone as a sentence, and this RPC is the only thing on the path that can
 * still return one — the wrapper's own refusal (exit 3) goes to a process
 * nobody is waiting on.
 *
 * Nothing here handles a credential. It starts a process; the code never
 * touches this process.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { droverBinExists, droverBinPath } from '@/daemon/tmuxSpawn'

export interface AccountLoginRequest {
    /** What to call the account. Omitted means it is named after the address
     *  it logs in as, which is the shorter path and the one with nothing to
     *  invent. */
    name?: string
    /**
     * WHICH SUBSCRIPTION to add — 'claude' (the default) or 'cursor'
     * (DROVE-270).
     *
     * The wrapper takes `--harness cursor` and execs a sibling script for it,
     * because the two logins are not the same shape: `claude auth login`
     * prints a URL and then BLOCKS on a code typed back in, while
     * `cursor-agent login` prints a URL and then polls its own API until a
     * browser approves it. There is no code in a cursor login and nothing to
     * send back, which is why the phone's status wording is harness-aware.
     *
     * Absent means claude, so an older app asking for a login gets exactly
     * what it always got.
     */
    harness?: string
}

export interface AccountLoginResult {
    started: true
    name: string | null
    /** Which subscription was started, echoed so the phone can be sure. */
    harness: AccountLoginHarness
}

/**
 * The tmux server the login runs on: the USER'S (DROVE-348), which is what
 * `default` means to tmux and therefore what a bare `tmux` reaches.
 * DROVER_TMUX_SOCKET moves it, and it is the same variable
 * lib/drover-tmux-entry.sh reads, so the daemon and the wrapper cannot disagree
 * about which server they are talking about.
 */
export function accountLoginSocket(env: NodeJS.ProcessEnv = process.env): string {
    return env.DROVER_TMUX_SOCKET || 'default'
}

/**
 * The same character set `valid_name` enforces in libexec/drover-account-edit,
 * checked here so a bad name fails immediately with a sentence rather than as
 * a nonzero exit from a process nobody is watching.
 *
 * `@` and `.` are legal on purpose: an account named clayrisser@gmail.com is
 * the point. `/` is refused because the name becomes a path component, a
 * leading `-` because it reads as an option, and a leading `.` because it
 * would hide the config dir.
 */
export function validAccountName(name: string): boolean {
    if (name.length === 0 || name.length > 128) return false
    if (name.startsWith('-') || name.startsWith('.')) return false
    return /^[A-Za-z0-9._@+-]+$/.test(name)
}

/**
 * The harnesses this can log in. Anything else is refused with a sentence
 * rather than handed to the wrapper, which would exit 2 into a pane nobody is
 * looking at.
 */
export const accountLoginHarnesses = ['claude', 'cursor'] as const
export type AccountLoginHarness = (typeof accountLoginHarnesses)[number]

/** The harness asked for, defaulting to claude. Null when it is not one. */
export function accountLoginHarness(raw: unknown): AccountLoginHarness | null {
    if (raw === undefined || raw === null) return 'claude'
    if (typeof raw !== 'string') return null
    const key = raw.trim().toLowerCase()
    if (!key) return 'claude'
    return (accountLoginHarnesses as readonly string[]).includes(key)
        ? key as AccountLoginHarness
        : null
}

/**
 * The argv, split out so the shape is testable without spawning anything.
 *
 * `--harness` is passed only for cursor. `drover account login --harness
 * claude` is accepted by the wrapper and means the same as no flag, but a
 * daemon that always sent it would fail against a wrapper predating DROVE-256
 * — and the phone cannot see which wrapper is on the other end.
 */
export function buildAccountLoginArgv(
    droverBin: string,
    name?: string,
    harness: AccountLoginHarness = 'claude',
): string[] {
    const argv = [droverBin, 'account', 'login']
    if (name) argv.push(name)
    if (harness !== 'claude') argv.push('--harness', harness)
    return argv
}

/**
 * The window name, which is also the lock.
 *
 * A pure function of WHICH HARNESS and WHICH account are being added:
 * `login-claude-alt`, `login-cursor-clayrisser-gmail-com` — tmux forbids `.`
 * and `:` in a name, so everything outside [A-Za-z0-9_-] becomes a dash. The
 * shell computes the same string from the same rule, in
 * lib/drover-login-session.sh.
 *
 * THE HARNESS IS IN THE NAME (DROVE-348) where it used not to be. On a private
 * socket holding nothing else `login-alt` was unambiguous; in a session beside
 * a day's work it is not, and these names are read in a window list now.
 *
 * A NAMELESS add is `login-<harness>-new`, and that is a placeholder rather
 * than an answer: which ~/.claude-accounts/account-N it lands on is decided
 * inside `drover account login`, and only then. The shell RENAMES the window to
 * `login-claude-account-3` once it knows, which is also how a nameless add from
 * the phone and one from a terminal end up colliding on one name instead of
 * racing for one directory.
 */
export function accountLoginWindowName(
    name?: string | null,
    harness: AccountLoginHarness = 'claude',
): string {
    const spelling = (name ?? '').trim() || 'new'
    return `login-${harness}-${spelling.replace(/[^A-Za-z0-9_-]+/g, '-')}`
}

/**
 * The PATH the login runs with.
 *
 * Two rules, and each is a measured failure rather than a precaution:
 *
 *  - the user's own bin directories are APPENDED, because ~/.local/bin is
 *    where Claude Code's installer puts `claude` and a launchd job does not
 *    inherit it. That is the whole of DROVE-212. Appended, not prepended, so
 *    nothing the daemon deliberately put in front is shadowed.
 *  - every `node_modules/.bin` is DROPPED. The happy checkout carries a
 *    `claude` stub there with no shebang, so exec'ing it is ENOEXEC, and
 *    anything started under pnpm has that directory at the FRONT of PATH. The
 *    same trap is written up in drover/flip/refresh.ts. A login has no
 *    business resolving anything out of a project's node_modules.
 */
export function accountLoginPath(env: NodeJS.ProcessEnv = process.env): string {
    const home = env.HOME || homedir()
    const kept = (env.PATH || '').split(':')
        .filter((d) => d.length > 0 && !d.includes('node_modules/.bin'))
    const seen = new Set(kept)
    for (const dir of [
        join(home, '.local', 'bin'),
        join(home, 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
    ]) {
        if (seen.has(dir) || !existsSync(dir)) continue
        kept.push(dir)
        seen.add(dir)
    }
    return kept.join(':')
}

/**
 * The environment the detached wrapper runs with, split out so the shape is a
 * test rather than a comment.
 *
 * DROVER_LOGIN_PATH and NOT PATH, and that is DROVE-212's measurement rather
 * than a preference: a launchd job's PATH has no ~/.local/bin, where Claude
 * Code's installer puts `claude`, so the wrapper's `command -v claude` guard
 * failed and exited into a stderr pointed at /dev/null. It travels under its own
 * name because libexec/drover-account-login applies it deliberately, before it
 * hands itself to a tmux window that would otherwise inherit the tmux SERVER's
 * PATH.
 */
export function buildAccountLoginEnv(
    path: string,
    env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    return { ...env, DROVER_LOGIN_PATH: path }
}

export interface AccountLoginDeps {
    droverBin?: string
    exists?: (path: string) => boolean
    launch?: (argv: string[], window: string) => void
}

function tmux(args: string[]): { ok: boolean; out: string } {
    const r = spawnSync('tmux', ['-L', accountLoginSocket(), ...args], { encoding: 'utf8' })
    return {
        ok: r.status === 0,
        out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
    }
}

/**
 * Is a login for this account already open with something running in it?
 *
 * `list-windows -a` is every window on the server, and `#{pane_dead}` is the
 * liveness question rather than "does the window exist" — a finished login
 * leaves its window behind ON PURPOSE now, holding what it said, and that
 * corpse must not read as a login in flight. The format puts the flag first so
 * a window name containing a space still parses.
 *
 * This is advisory and the wrapper refuses again for itself. It exists so the
 * refusal can be a SENTENCE on the phone: this RPC is the last thing on the path
 * that can return one, since the wrapper's own exit 3 goes to a process nobody
 * is waiting on.
 */
export function accountLoginBusy(window: string): boolean {
    const windows = tmux(['list-windows', '-a', '-F', '#{pane_dead} #{window_name}'])
    if (!windows.ok) return false
    return windows.out.split('\n').some((line) => {
        const trimmed = line.trim()
        return trimmed.startsWith('0 ') && trimmed.slice(2) === window
    })
}

/**
 * Start the wrapper and get out of the way.
 *
 * `detached` plus `unref` so the daemon can be restarted without taking the
 * login with it, and stdio on /dev/null because the wrapper's output does not
 * belong here — it re-execs into `login-<harness>-<account>` on the user's own
 * server and narrates THERE, which is the whole of DROVE-348. The pre-window
 * guards (no tmux, no `claude`) still put a card on the bus rather than exiting
 * into silence, which is what DROVE-212 asked of them.
 */
function launchDetached(argv: string[], window: string): void {
    if (accountLoginBusy(window)) {
        throw new Error(
            'A login is already waiting on this machine. Answer or cancel that one first — '
            + 'its card is still on the phone, and this screen shows the link it already has.',
        )
    }
    const child = spawn(argv[0]!, argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        env: buildAccountLoginEnv(accountLoginPath()),
    })
    child.unref()
}

export async function startAccountLogin(
    request: AccountLoginRequest,
    deps: AccountLoginDeps = {},
): Promise<AccountLoginResult> {
    const harness = accountLoginHarness(request?.harness)
    if (!harness) {
        throw new Error(
            `'${String(request?.harness)}' is not a subscription this can log in. `
            + `It adds ${accountLoginHarnesses.join(' or ')} accounts.`,
        )
    }
    const name = typeof request?.name === 'string' ? request.name.trim() : ''
    if (name && !validAccountName(name)) {
        throw new Error(
            `'${name}' is not a usable account name. Letters, digits and . _ - @ + only `
            + '(an email address is fine), and it may not start with a dot or a dash.',
        )
    }

    const droverBin = deps.droverBin ?? droverBinPath()
    const exists = deps.exists ?? droverBinExists
    if (!exists(droverBin)) {
        // Same sentence shape as a spawn that cannot find the wrapper: name the
        // path and the two variables that move it, because the only person who
        // can fix this is at a keyboard somewhere else.
        throw new Error(
            `Cannot add an account: the drover wrapper was not found at ${droverBin}. `
            + 'Point the daemon at your cattle-drover checkout with DROVER_BIN (or DROVER_DIR) and restart it.',
        )
    }

    const argv = buildAccountLoginArgv(droverBin, name || undefined, harness)
    const window = accountLoginWindowName(name, harness)
    const launch = deps.launch ?? launchDetached
    launch(argv, window)
    return { started: true, name: name || null, harness }
}
