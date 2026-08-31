/**
 * The Claude accounts ON THIS MACHINE, read and removed from the phone
 * (DROVE-165).
 *
 * Clay, unprompted, and it is the constraint that makes the whole thing
 * tractable: "I think Claude accounts we add are specific to a machine because
 * that's where they're logged in." An account is a login; the login lives in a
 * `CLAUDE_CONFIG_DIR` on one box; on macOS the credential is a Keychain item
 * keyed to that directory's PATH. None of it travels. So the phone never holds
 * an account list — it asks a machine for its own, and the answer belongs to
 * that machine.
 *
 * DROVE-61 built the ADD half: `drover-account-login` starts a headless
 * `claude auth login` over there and the URL comes back to the phone as a card.
 * What was missing was the rest of a list you can act on — seeing what is
 * already there, per machine, and taking one off.
 *
 * READ IN PROCESS, ON PURPOSE. The registry, the login state, the usage cache
 * and the cooldown ledger all have exactly one reader in this CLI already —
 * `drover/flip/accounts.ts` and `drover/flip/usage.ts`, which is what the flip
 * picker itself decides on. Shelling out to `drover accounts --json` would have
 * been a second reader that can disagree with the picker, and it would make the
 * list fail on a machine whose wrapper is not where the daemon thinks it is.
 * The snapshot returned here is the SAME `DroverUsage` shape the app already
 * parses off a session's metadata, so the phone renders it with the row it
 * already has (DROVE-117 / DROVE-148) rather than a third variant.
 *
 * NO CREDENTIAL PASSES THROUGH THIS FILE, and none can. Every reader below
 * tests `oauthAccount` for PRESENCE and reads `emailAddress` — identity, not a
 * secret. Nothing here opens `.credentials.json`, and nothing here writes a
 * login. Removal takes a ROW out of the registry; the login it pointed at stays
 * in the Keychain until Clay removes it himself, which the answer says out loud
 * rather than quietly doing for him.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { droverBinExists, droverBinPath } from '@/daemon/tmuxSpawn';
import {
    isAmbientSpelling,
    loginEmail,
    readAccounts,
    sameLoginAs,
    type DroverAccount,
} from '@/drover/flip/accounts';
import { usageSnapshot, type AccountUsageSnapshot } from '@/drover/flip/usage';
import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

const execFileAsync = promisify(execFile);

/**
 * One account on this machine: everything the quota row already renders, plus
 * the three facts that only matter once accounts are a LIST you manage rather
 * than a place a session sits.
 */
export interface MachineAccountRow extends AccountUsageSnapshot {
    /** Where the login lives. Absolute; the ambient one is `~/.claude`. */
    configDir: string;
    /**
     * This is the ambient login — the account every unwrapped `claude` on that
     * Mac uses. It is the one row the phone must not offer to remove or log
     * into: replacing it from a phone is not undoable from a phone.
     */
    ambient: boolean;
    /** The address it is logged in as, or null when nothing ever logged in. */
    login: string | null;
    /**
     * Another row holding the SAME claude.ai login, so the two share one quota
     * (DROVE-21). Shown so two rows with identical bars do not read as a bug.
     */
    sameLoginAs: string | null;
}

export type ListMachineAccountsResponse =
    | { ok: true; capturedAt: number; accounts: MachineAccountRow[] }
    | { ok: false; error: string };

export interface RemoveMachineAccountRequest {
    name?: string;
}

export type RemoveMachineAccountResponse =
    | { ok: true; name: string; message: string }
    | { ok: false; error: string };

/**
 * NO ROW IS MARKED `current`, and that is not an omission.
 *
 * `current` means "the account THIS session is running on". It is a session
 * fact — the flip controller stamps it, and the quota sheet under the composer
 * shows it because that sheet belongs to a session. The daemon is not a
 * session: it has no `DROVER_ACCOUNT` and no `CLAUDE_CONFIG_DIR`, so any answer
 * it invented would mark the ambient account current on a Mac where every live
 * session is somewhere else. A machine-wide list has no business guessing, so
 * `usageSnapshot` is asked with no current account and every row comes back
 * false.
 */
export function readMachineAccounts(now = Date.now()): { capturedAt: number; accounts: MachineAccountRow[] } {
    const registry: DroverAccount[] = readAccounts();
    const snapshot = usageSnapshot(undefined, now);
    const byName = new Map(registry.map((a) => [a.name, a]));

    const accounts = snapshot.accounts.map((row): MachineAccountRow => {
        const account = byName.get(row.name);
        return {
            ...row,
            configDir: account?.configDir ?? '',
            ambient: account ? account.ambient === true || isAmbientSpelling(account.configDir) : false,
            login: (account && loginEmail(account)) || null,
            sameLoginAs: (account && sameLoginAs(account, registry)) || null,
        };
    });

    return { capturedAt: snapshot.capturedAt, accounts };
}

export function listMachineAccounts(now = Date.now()): ListMachineAccountsResponse {
    try {
        return { ok: true, ...readMachineAccounts(now) };
    } catch (error) {
        // A registry that will not parse is a real answer, not a crash: the
        // screen says what is wrong with the file and the machine stays in the
        // list. Silently returning an empty array would read as "no accounts
        // here", which is the one thing it must not say.
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * The character set `valid_name` enforces in libexec/drover-account-edit, and
 * the same one `validAccountName` checks before an add. Refusing here means a
 * name that could never have been created never becomes an argument.
 */
export function validRemovableAccountName(name: string): boolean {
    if (name.length === 0 || name.length > 128) return false;
    if (name.startsWith('-') || name.startsWith('.')) return false;
    return /^[A-Za-z0-9._@+-]+$/.test(name);
}

/** Runs the drover wrapper and resolves stdout; rejects when it exits nonzero. */
export type DroverRunner = (args: string[]) => Promise<string>;

export interface RemoveAccountDeps {
    droverBin?: string;
    exists?: (path: string) => boolean;
    run?: DroverRunner;
}

/** stderr if the wrapper wrote any, else whatever the failure calls itself. */
export function describeDroverError(error: unknown): string {
    if (error && typeof error === 'object' && 'stderr' in error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
        if (stderr) return stderr;
    }
    return error instanceof Error ? error.message : String(error);
}

function defaultRunner(droverBin: string): DroverRunner {
    return async (args) => {
        const { stdout } = await execFileAsync(droverBin, args, { maxBuffer: 1024 * 1024 });
        return stdout;
    };
}

/**
 * Take an account off this machine's registry.
 *
 * THE WRAPPER DOES THE REMOVAL, not this file. `drover account rm` carries the
 * three refusals that make removal safe, and re-implementing them here is how
 * the two halves drift: the last account cannot go (a drover with nowhere to
 * run), an account with a live session on it cannot go (the session would point
 * at a name the registry no longer knows and refuse to flip out), and the
 * cooldown ledger entry is deleted with the row so a future account reusing the
 * name does not inherit its cooldown. Its stderr is the answer, verbatim.
 *
 * `--purge` IS NOT PASSED and is not offered from the phone. Purging deletes
 * the config dir — that account's history and settings — and cannot be undone
 * from a phone, while the thing a person actually means by "remove this
 * account", the login itself, is a Keychain item that survives the purge
 * anyway. So the phone removes the ROW: the account stops being a place work
 * can go, and everything it left behind is still on the Mac for Clay to delete
 * at a keyboard with `drover account rm <name> --purge`.
 */
export async function removeMachineAccount(
    request: RemoveMachineAccountRequest,
    deps: RemoveAccountDeps = {},
): Promise<RemoveMachineAccountResponse> {
    const name = typeof request?.name === 'string' ? request.name.trim() : '';
    if (!name) return { ok: false, error: 'Which account? A name is required.' };
    if (!validRemovableAccountName(name)) {
        return { ok: false, error: `'${name}' is not a usable account name, so no account is called that.` };
    }

    const account = readAccounts().find((a) => a.name === name);
    if (account && (account.ambient === true || isAmbientSpelling(account.configDir))) {
        return {
            ok: false,
            error: `'${name}' is the ambient login (~/.claude) — the account every plain `
                + 'claude on that Mac uses. Removing it from a phone is not undoable from a phone.',
        };
    }

    const droverBin = deps.droverBin ?? droverBinPath();
    const exists = deps.exists ?? droverBinExists;
    if (!exists(droverBin)) {
        return {
            ok: false,
            error: `The drover wrapper was not found at ${droverBin}. `
                + 'Point the daemon at your cattle-drover checkout with DROVER_BIN (or DROVER_DIR) and restart it.',
        };
    }

    const run = deps.run ?? defaultRunner(droverBin);
    try {
        const stdout = await run(['account', 'rm', name]);
        return { ok: true, name, message: stdout.trim() || `Removed '${name}'.` };
    } catch (error) {
        return { ok: false, error: describeDroverError(error) };
    }
}

export function registerMachineAccountsHandlers(
    rpcHandlerManager: RpcHandlerManager,
    deps: RemoveAccountDeps = {},
): void {
    rpcHandlerManager.registerHandler<unknown, ListMachineAccountsResponse>(
        'drover-accounts',
        async () => {
            logger.debug('[API MACHINE] Received drover-accounts RPC request');
            return listMachineAccounts();
        },
    );

    rpcHandlerManager.registerHandler<RemoveMachineAccountRequest, RemoveMachineAccountResponse>(
        'drover-account-remove',
        async (request) => {
            logger.debug('[API MACHINE] Received drover-account-remove RPC request');
            return removeMachineAccount(request ?? {}, deps);
        },
    );
}
