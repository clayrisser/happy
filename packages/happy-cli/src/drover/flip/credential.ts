/**
 * Is there a CREDENTIAL behind an account, or only an address? (DROVE-238)
 *
 * Clay, after adding four accounts from his phone: "When I added accounts from
 * the mobile app it actually showed they added but when I tried to flip to
 * them it actually got stuck on these screens and I had to actually
 * authenticate it in the terminal as it wasn't ACTUALLY authenticated."
 *
 * `isLoggedIn` is a presence check on `oauthAccount` in .claude.json, and that
 * key is IDENTITY. On macOS the token is a SECOND write, to the Keychain,
 * under a service named for a hash of the config dir's path — so the file can
 * name an address while the Keychain holds nothing for that path. Measured
 * 2026-08-31 on a config dir carrying an oauthAccount and no Keychain item:
 *
 *     isLoggedIn               true
 *     claude auth status       {"loggedIn": false, "authMethod": "none"}
 *
 * `claude auth status` is Claude Code's own answer and it reads the Keychain
 * the way a real run would. 250ms, measured on both a live account and a dead
 * one, which is what makes it affordable to ask about every account whenever
 * the phone opens the Accounts screen.
 *
 * NO CREDENTIAL PASSES THROUGH HERE. The only field taken off the reply is the
 * `loggedIn` boolean. Nothing is written, and no token is read.
 *
 * WHY THE ANSWER LANDS IN accounts.ts RATHER THAN BEING RETURNED. Every reader
 * that matters is synchronous — `pickTarget`, `usageSnapshot`, `isLoggedIn` —
 * and making them async to carry a 250ms probe would reach the whole flip. So
 * the probe is async, runs where there is already an await, and RECORDS what
 * it found; the sync readers consult that record. A stale record cannot strand
 * an account for long: only an explicit "no" is kept, it expires, and the next
 * probe that says yes clears it.
 */

import { spawn } from 'node:child_process'

import { noteCredentialProbe, readAccounts, type DroverAccount } from './accounts'
import { claudeBinary, usageRefreshEnv } from './refresh'
import { logger } from '@/ui/logger'

/** `yes` it can run, `no` it cannot, `unknown` the probe could not tell. */
export type CredentialState = 'yes' | 'no' | 'unknown'

/** Long enough that a wedged `claude` cannot hold the Accounts screen open. */
const probeTimeoutMs = 10_000

/**
 * What Claude Code says about one account's login.
 *
 * THE BODY DECIDES, NEVER THE EXIT STATUS. `claude auth status` exits 1 when
 * it is not logged in — measured, same run as the header — so judging on the
 * status would call the commonest honest answer a failure. The output is read
 * whatever it exits with, and only a body with no `loggedIn` boolean in it is
 * `unknown`.
 *
 * `unknown` is never treated as `no` by any caller. A machine where this
 * cannot run has to behave the way it did before, not lose every account.
 */
export function probeCredential(
    a: DroverAccount,
    deps: { run?: (account: DroverAccount) => Promise<string> } = {},
): Promise<CredentialState> {
    const run = deps.run ?? runAuthStatus
    return run(a).then(readLoggedIn, (err) => {
        logger.debug('[flip] could not probe the credential for ' + a.name, err)
        return 'unknown' as const
    })
}

/** The `loggedIn` boolean out of an `auth status` reply, or `unknown`. */
export function readLoggedIn(stdout: string): CredentialState {
    try {
        const parsed = JSON.parse(stdout) as { loggedIn?: unknown } | null
        if (parsed && typeof parsed.loggedIn === 'boolean') return parsed.loggedIn ? 'yes' : 'no'
        return 'unknown'
    } catch {
        return 'unknown'
    }
}

function runAuthStatus(a: DroverAccount): Promise<string> {
    return new Promise((resolve, reject) => {
        let child: ReturnType<typeof spawn>
        try {
            child = spawn(claudeBinary(), ['auth', 'status'], {
                env: usageRefreshEnv(a),
                stdio: ['ignore', 'pipe', 'ignore'],
            })
        } catch (err) {
            reject(err)
            return
        }
        let out = ''
        child.stdout?.on('data', (chunk) => { out += String(chunk) })
        const timer = setTimeout(() => child.kill('SIGKILL'), probeTimeoutMs)
        child.on('error', (err) => { clearTimeout(timer); reject(err) })
        // Resolved on close whatever the code, because the code is the answer
        // being asked about and not an error.
        child.on('close', () => { clearTimeout(timer); resolve(out) })
    })
}

/**
 * Probe every account and record what came back, so the synchronous readers
 * stop believing an address is a login.
 *
 * In parallel: six accounts at 250ms each is 1.5s serial and about 300ms this
 * way, and this runs on the path the phone polls while the Accounts screen is
 * open. Nothing here throws — a probe that cannot run leaves the record alone.
 */
export async function refreshCredentialState(
    accounts: DroverAccount[] = readAccounts(),
    deps: { probe?: (a: DroverAccount) => Promise<CredentialState> } = {},
): Promise<void> {
    const probe = deps.probe ?? ((a: DroverAccount) => probeCredential(a))
    await Promise.all(accounts.map(async (a) => {
        const state = await probe(a).catch(() => 'unknown' as const)
        if (state === 'unknown') return
        noteCredentialProbe(a, state === 'yes')
    }))
}
