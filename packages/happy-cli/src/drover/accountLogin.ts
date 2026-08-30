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
 * So this RPC does one thing — start the process and get out of the way. It
 * does NOT wait: a login lasts as long as a human takes, and an RPC that held
 * the socket open for fifteen minutes would time out long before the card was
 * answered.
 *
 * Nothing here handles a credential. It spawns a command; the code never
 * touches this process.
 */

import { spawn } from 'node:child_process'

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

export interface AccountLoginDeps {
    droverBin?: string
    exists?: (path: string) => boolean
    launch?: (argv: string[]) => void
}

/**
 * Start the login and return. The child is detached and its streams go
 * nowhere: it outlives this RPC on purpose, and the only thing anyone needs to
 * see from it is the card it puts on the bus.
 */
function launchDetached(argv: string[]): void {
    const child = spawn(argv[0], argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        env: process.env,
    })
    child.unref()
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
    const launch = deps.launch ?? launchDetached
    launch(argv)
    return { started: true, name: name || null }
}
