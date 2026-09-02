/**
 * One MCP server, acted on, from the phone (DROVE-291).
 *
 * `machineMcps.ts` beside this is the LIST, and DROVE-274 shipped it read-only.
 * Clay, holding it: "Shouldn't I be able to click on these and reconnect
 * authenticate etc…". Three verbs, each a daemon RPC to the machine's own
 * drover, which decides everything.
 *
 * NOTHING IS REINTERPRETED HERE. The machine's sentences arrive as sentences
 * and the sheet renders them. The temptation on this path is to turn "answered
 * when the machine last asked" into "online", and that is exactly the claim
 * nothing on the machine is entitled to make: an MCP connection belongs to a
 * SESSION, so a reading is a reading and it always travels with the moment it
 * was taken.
 *
 * NO CREDENTIAL REACHES THIS FILE, in either direction. A re-authenticate
 * answers with the name of a tmux window on the Mac; the sign-in happens there,
 * in a browser, under Clay's hands (DROVE-318). There is no code to type in and
 * no token to hold, which is why this module has no storage of any kind.
 */

import type {
    McpHealthResult,
    McpReauthStarted,
    McpReconnectDone,
} from '@slopus/happy-wire';

import { apiSocket } from './apiSocket';

/** What every one of these takes: which harness, and which of its servers. */
export interface McpServerRef {
    harness: string;
    server: string;
}

/**
 * The machine did not answer at all. Its own sentence rather than a thrown
 * error, because every caller here renders the failure in the sheet and a
 * screen that can only show a spinner or a crash is not a screen.
 */
function unreachable(error: unknown): string {
    return error instanceof Error ? error.message : 'the computer did not answer';
}

export async function machineMcpHealth(machineId: string, ref: McpServerRef): Promise<McpHealthResult> {
    try {
        return await apiSocket.machineRPC<McpHealthResult, McpServerRef>(machineId, 'drover-mcp-health', ref);
    } catch (error) {
        return { ok: false, error: unreachable(error) };
    }
}

export async function machineMcpReconnect(machineId: string, ref: McpServerRef): Promise<McpReconnectDone> {
    try {
        return await apiSocket.machineRPC<McpReconnectDone, McpServerRef>(machineId, 'drover-mcp-reconnect', ref);
    } catch (error) {
        return { ok: false, ...ref, error: unreachable(error) };
    }
}

export async function machineMcpReauth(machineId: string, ref: McpServerRef): Promise<McpReauthStarted> {
    try {
        return await apiSocket.machineRPC<McpReauthStarted, McpServerRef>(machineId, 'drover-mcp-reauth', ref);
    } catch (error) {
        return { ok: false, ...ref, error: unreachable(error) };
    }
}

export {
    mcpHealthTitle,
    mcpHealthTone,
    mcpObservedAgo,
} from './mcpText';
