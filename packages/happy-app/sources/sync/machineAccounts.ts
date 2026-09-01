/**
 * A machine's own Claude accounts, listed and removed from the phone
 * (DROVE-165).
 *
 * Its own module rather than another pair of functions in ops.ts, for the same
 * reason droverPolicy.ts is: the drover surfaces answer `{ ok: false, error }`
 * instead of throwing, because a control that swallows its error is a control
 * that looks like it worked. ops.ts is mostly the throwing kind and mixing the
 * two in one file is how the wrong one gets copied.
 *
 * These are the READ and the REMOVE. The add is `machineDroverAccountLogin` in
 * ops.ts (DROVE-61) and stays there — it is the one call that starts a process
 * rather than answering a question.
 */

import { apiSocket } from './apiSocket';
import type { MachineAccount } from './machineAccountsFlow';

export type { MachineAccount, MachineAccountLimit } from './machineAccountsFlow';

export type MachineAccountsResult =
    | { ok: true; capturedAt: number; accounts: MachineAccount[] }
    | { ok: false; error: string };

export type MachineAccountRemoveResult =
    | { ok: true; name: string; message: string }
    | { ok: false; error: string };

/**
 * What that machine's registry says right now.
 *
 * Asked of the DAEMON, not read off a session, and that is the whole point: an
 * account belongs to the machine it was logged in on, so the list has to come
 * from the machine even when nothing is running there. A session's
 * `droverUsage` stamp carries the same numbers but only exists while a session
 * does, and only for the machine that session is on.
 */
export async function machineDroverAccounts(machineId: string): Promise<MachineAccountsResult> {
    try {
        return await apiSocket.machineRPC<MachineAccountsResult, Record<string, never>>(
            machineId,
            'drover-accounts',
            {},
        );
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}

/**
 * Take an account off that machine.
 *
 * The ROW only. The config dir is left alone and the login stays in that Mac's
 * Keychain, because deleting either cannot be undone from a phone — and the
 * Keychain item survives a `--purge` anyway, so "remove the account" from here
 * has always meant "stop sending work there". The refusals come back from
 * `drover account rm` verbatim: the last account cannot go, and neither can one
 * with a live session on it.
 */
export async function machineDroverAccountRemove(
    machineId: string,
    name: string,
    harness?: string,
): Promise<MachineAccountRemoveResult> {
    try {
        // The harness rides along (DROVE-338): a Claude row and a cursor row
        // may share a name, and the Mac refuses a bare rm of a shared name
        // rather than guess. The row being removed knows which it is.
        return await apiSocket.machineRPC<MachineAccountRemoveResult, { name: string; harness?: string }>(
            machineId,
            'drover-account-remove',
            harness ? { name, harness } : { name },
        );
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}
