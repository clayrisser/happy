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
 * ITS OWN TMUX SERVER, `-L drover-login`. Clay has a screenful of sessions and
 * a login pane sitting among his projects would be its own bug. A private
 * socket is invisible to `tmux ls`, to `prefix + s`, to the pane walk in the
 * bus (engine/registry.js lists panes on the DEFAULT socket) and to `drover
 * sessions`. Nothing in that session runs the drover wrapper, so no
 * SessionStart hook fires and no Happy session is ever minted: the app's own
 * list cannot see it either.
 *
 * Nothing here handles a credential. It starts a session; the code never
 * touches this process.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { droverBinExists, droverBinPath } from '@/daemon/tmuxSpawn'

export interface AccountLoginRequest {
    /** What to call the account. Omitted means it is named after the address
     *  it logs in as, which is the shorter path and the one with nothing to
     *  invent. */
    name?: string
}

export interface AccountLoginResult {
    started: true
    name: string | null
}

/** The tmux server the login runs on, and never the default one. */
export const accountLoginSocket = 'drover-login'

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

/** The argv, split out so the shape is testable without spawning anything. */
export function buildAccountLoginArgv(droverBin: string, name?: string): string[] {
    const argv = [droverBin, 'account', 'login']
    if (name) argv.push(name)
    return argv
}

/**
 * The session name, which is also the lock.
 *
 * A pure function of WHICH account is being added: `login-alt`, or
 * `login-clayrisser-gmail-com` — tmux forbids `.` and `:` in a session name,
 * so everything outside [A-Za-z0-9_-] becomes a dash. The shell side computes
 * the same string from the same rule.
 *
 * A NAMELESS add is `login-new`, and that is a placeholder rather than an
 * answer: which ~/.claude-accounts/account-N it lands on is decided inside
 * `drover account login`, and only then. The shell RENAMES the session to
 * `login-account-3` once it knows, which is also how a nameless add from the
 * phone and one from a terminal end up colliding on one name instead of
 * racing for one directory. `login-new` still does the job here, because two
 * nameless adds from the app both want it and tmux refuses the second.
 */
export function accountLoginSessionName(name?: string | null): string {
    const spelling = (name ?? '').trim()
    if (!spelling) return 'login-new'
    return `login-${spelling.replace(/[^A-Za-z0-9_-]+/g, '-')}`
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
 * The whole tmux command line, split out so the shape is a test rather than a
 * comment.
 *
 * `-n control` names the window this wrapper runs in, and the shell reads that
 * name back: a session that still has a `control` window has a run attached to
 * it, which is how a live login is told from one left behind by a run that was
 * killed outright. `-x 200 -y 50` because with no client attached a pane is
 * 80x24, and the authorize URL is 300-odd characters — `capture-pane -J`
 * rejoins it either way, but a wider pane is fewer joins to get wrong.
 */
export function buildAccountLoginTmuxArgv(opts: {
    argv: string[]
    session: string
    path: string
    socket?: string
    env?: NodeJS.ProcessEnv
}): string[] {
    const socket = opts.socket ?? accountLoginSocket
    const env = opts.env ?? process.env
    const argv = [
        'tmux', '-L', socket,
        'new-session', '-d',
        '-s', opts.session,
        '-n', 'control',
        '-x', '200', '-y', '50',
        // NOT `-e PATH=…`. Measured on tmux 3.7c: a session environment's PATH
        // reaches `show-environment` and never reaches the pane, which keeps
        // the tmux SERVER's. Under its own name it is delivered like any other
        // variable, and libexec/drover-account-login exports it as PATH.
        '-e', `DROVER_LOGIN_PATH=${opts.path}`,
        '-e', `DROVER_LOGIN_SESSION=${opts.session}`,
        '-e', `DROVER_LOGIN_SOCKET=${socket}`,
    ]
    // A tmux SERVER keeps the environment of whoever started it, and a new
    // session on an existing server inherits that rather than ours. The server
    // is short-lived (it dies with its last session), but "short-lived" is not
    // "never", and a login that posted its card to the wrong bus because an
    // older server had a different DROVER_URL would be indistinguishable from
    // no card at all — which is the failure this whole ticket is about. So the
    // few variables that decide WHERE the card goes travel per-session.
    for (const key of droverEnvPassthrough) {
        const value = env[key]
        if (value) argv.push('-e', `${key}=${value}`)
    }
    argv.push(...opts.argv)
    return argv
}

/** The variables that decide which bus, which checkout and which registry. */
export const droverEnvPassthrough = [
    'DROVER_URL', 'DROVER_DIR', 'DROVER_BIN', 'DROVER_ACCOUNTS', 'STATE_DIR',
] as const

export interface AccountLoginDeps {
    droverBin?: string
    exists?: (path: string) => boolean
    launch?: (argv: string[], session: string) => void
}

function tmux(args: string[]): { ok: boolean; out: string } {
    const r = spawnSync('tmux', ['-L', accountLoginSocket, ...args], { encoding: 'utf8' })
    return {
        ok: r.status === 0,
        out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
    }
}

/**
 * Open the session, or say who has it.
 *
 * `new-session` is the claim and it is atomic: tmux refuses a duplicate name,
 * so there is no read-then-write window in which two taps both think they won.
 * A name already taken is only sometimes a live login — a run that was
 * SIGKILLed leaves its session behind with the control window gone — so the
 * one recovery is to check for that window and, when it is missing, take the
 * corpse over with a single kill. That is the whole of what used to be a lock
 * file, two pids, a `ps` re-check and a TERM-then-KILL reaper.
 */
function launchInTmux(argv: string[], session: string): void {
    const cmd = buildAccountLoginTmuxArgv({ argv, session, path: accountLoginPath() })
    const first = tmux(cmd.slice(3))
    if (first.ok) return

    const windows = tmux(['list-windows', '-t', session, '-F', '#{window_name}'])
    if (windows.ok && windows.out.split('\n').some((w) => w.trim() === 'control')) {
        throw new Error(
            'A login is already waiting on this machine. Answer or cancel that one first — '
            + 'its card is still on the phone, and this screen shows the link it already has.',
        )
    }

    // Nobody is driving it. Whatever it left running is ours to end.
    tmux(['kill-session', '-t', session])
    const second = tmux(cmd.slice(3))
    if (second.ok) return
    throw new Error(
        `Cannot start the login: tmux would not open a session for it (${second.out || 'no output'}). `
        + `Look at it with: tmux -L ${accountLoginSocket} ls`,
    )
}

export async function startAccountLogin(
    request: AccountLoginRequest,
    deps: AccountLoginDeps = {},
): Promise<AccountLoginResult> {
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

    const argv = buildAccountLoginArgv(droverBin, name || undefined)
    const session = accountLoginSessionName(name)
    const launch = deps.launch ?? launchInTmux
    launch(argv, session)
    return { started: true, name: name || null }
}
