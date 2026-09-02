/**
 * A worktree's files and a session's pane, read from the machine (DROVE-330).
 *
 * Asked of the DAEMON, like the worktree list and the MCP report, and for the
 * same reason: the worktree Clay tapped may have no session running in it, so
 * there is no session to ask. The daemon relays to cattle-drover, which is
 * the only thing that knows which roots it may look at and which names it
 * must refuse, and re-masks what comes back before it is encrypted
 * (happy-cli/src/drover/machineFiles.ts).
 *
 * Read-only, all three. The desktop's file panel has its own unredacted
 * `readFile` through the session; this is the phone's, and it never writes.
 */

import type {
    DroverFileReadResult,
    DroverFilesListResult,
    DroverFilesRequest,
    DroverPaneRequest,
    DroverPaneResult,
} from '@slopus/happy-wire';

import { apiSocket } from './apiSocket';

export type {
    DroverFileEntry,
    DroverFileRead,
    DroverFileReadResult,
    DroverFilesList,
    DroverFilesListResult,
    DroverPane,
    DroverPaneRequest,
    DroverPaneResult,
} from '@slopus/happy-wire';

const didNotAnswer = 'the computer did not answer';

/** One directory of `root`, `path` relative to it (empty for the root). */
export async function machineDroverFilesList(machineId: string, root: string, path: string): Promise<DroverFilesListResult> {
    try {
        return await apiSocket.machineRPC<DroverFilesListResult, DroverFilesRequest>(machineId, 'drover-files-list', { root, path });
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : didNotAnswer };
    }
}

/** One file of `root`, already through the redactor twice. */
export async function machineDroverFileRead(machineId: string, root: string, path: string): Promise<DroverFileReadResult> {
    try {
        return await apiSocket.machineRPC<DroverFileReadResult, DroverFilesRequest>(machineId, 'drover-files-read', { root, path });
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : didNotAnswer };
    }
}

/** The pane's text, by the harness's session id or by a worktree's path. */
export async function machineDroverPane(machineId: string, request: DroverPaneRequest): Promise<DroverPaneResult> {
    try {
        return await apiSocket.machineRPC<DroverPaneResult, DroverPaneRequest>(machineId, 'drover-pane', request);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : didNotAnswer };
    }
}
