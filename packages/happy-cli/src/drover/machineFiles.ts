/**
 * A worktree's files and a session's pane, read from the phone (DROVE-330).
 *
 * Clay, from his phone: "another tab that opens the terminal, and another tab
 * that lets us browse the files; and if I click on a specific worktree it
 * opens the terminal in that worktree, or lets me browse the files in that
 * worktree." Read-only, all three verbs, and this file is a relay.
 *
 * THE READING IS NOT DONE HERE, on purpose, for the reason machineMcps.ts
 * gives: cattle-drover's `engine/files.js` decides which roots may be looked
 * at (a known session's cwd, or a worktree of its repo), which names are
 * refused before they are opened (.env, *.pem, id_rsa, .git/), and runs every
 * line it does serve through the DROVE-304 vocabulary. Reading files in this
 * process as well would be a second reader with a second opinion about what
 * `.env.local` is, and the two would drift. The daemon already has `readFile`
 * and `listDirectory` handlers for a SESSION's own cwd (registerCommonHandlers);
 * those are unredacted and stay for the desktop's file panel. The phone's
 * worktree browser goes through the drover, because a tapped worktree may
 * have no session at all.
 *
 * ONE ROUTE, NOT TWO. machineMcps falls back to `drover mcps --json` when the
 * bus is down, because MCP config is worth seeing while you debug the bus.
 * There is no fallback here: a pane is a fact about the bus's registry, and a
 * file listing without the bus's containment is exactly the read this relay
 * exists to avoid. The bus being down is an answer, and it is said plainly.
 *
 * NOTHING CREDENTIAL-SHAPED PASSES THROUGH, and this file does not take that on
 * trust. Two checks before the payload is encrypted and posted:
 *
 *   1. The SHAPE. `droverFilesListLeaks` and its siblings refuse an extra key
 *      outright, the way `mcpReportLeaks` does: a drover that started attaching
 *      an absolute path or a symlink target is refused, not filtered, because a
 *      leak that gets scrubbed on the way past is a leak nobody fixes.
 *   2. The TEXT. `redactSecretsInText` runs over every content string and pane
 *      line AGAIN. This one edits rather than refuses, because a source file
 *      that mentions `token: "…"` is a source file, not a leak. Anything it
 *      changes means the two vocabularies have drifted: the count goes on the
 *      payload and a line goes in the log, and the phone gets the masked text.
 */

import {
    droverFileReadLeaks,
    droverFilesListLeaks,
    droverPaneLeaks,
    redactTextCounting,
    type DroverFileRead,
    type DroverFileReadResult,
    type DroverFilesList,
    type DroverFilesListResult,
    type DroverFilesRequest,
    type DroverPane,
    type DroverPaneRequest,
    type DroverPaneResult,
} from '@slopus/happy-wire';

import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

/** Same default as droverBridge.ts, dotPublish.ts and machineMcps.ts. */
const droverUrl = (): string => process.env.DROVER_URL || 'http://127.0.0.1:7970';

/**
 * A page load with a person watching a spinner, like the MCP read. The pane
 * is polled every couple of seconds while the Terminal tab is up, so a slow
 * answer is better dropped than queued behind the next one.
 */
const BUS_TIMEOUT_MS = 4000;

/** What a bus call hands back: the status and the parsed body, whatever it was. */
export interface BusAnswer {
    status: number;
    body: unknown;
}

export interface MachineFilesDeps {
    /** GET <bus><pathAndQuery>. Injected by the tests; the real one is `fetch`. */
    fetchBus?: (pathAndQuery: string) => Promise<BusAnswer>;
}

async function fetchFromBus(pathAndQuery: string): Promise<BusAnswer> {
    const res = await fetch(`${droverUrl()}${pathAndQuery}`, { signal: AbortSignal.timeout(BUS_TIMEOUT_MS) });
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        body = null;
    }
    return { status: res.status, body };
}

/**
 * The sentence for a bus that did not answer 200. The bus's own `error` is
 * relayed when it is one of ours (a refusal names a KIND, never a value), and
 * a connection failure is named for what it is rather than as "not found".
 */
function busTrouble(answer: BusAnswer | null, failure: unknown): string {
    if (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (/ECONNREFUSED/.test(message)) return 'The drover bus is not running on this machine (drover bus).';
        if (/Timeout|abort/i.test(message)) return 'The drover bus is up but did not answer in time.';
        return `The drover bus could not be reached: ${message}`;
    }
    const body = answer?.body as { error?: unknown; reason?: unknown } | null;
    const error = typeof body?.error === 'string' ? body.error : `the bus answered ${answer?.status}`;
    const reason = typeof body?.reason === 'string' ? `: ${body.reason}` : '';
    if (answer?.status === 404 && error === 'not found') {
        // The route itself is missing: a bus from before DROVE-330. Said so,
        // because "not found" reads as "no such file".
        return 'This machine\'s drover bus is older than the Files tab. Restart it (kickstart com.bitspur.cattle-drover.bus) after updating cattle-drover.';
    }
    return `${error}${reason}`;
}

function encode(value: string): string {
    return encodeURIComponent(value);
}

async function ask(deps: MachineFilesDeps, pathAndQuery: string): Promise<{ answer: BusAnswer | null; failure: unknown }> {
    try {
        return { answer: await (deps.fetchBus ?? fetchFromBus)(pathAndQuery), failure: null };
    } catch (failure) {
        return { answer: null, failure };
    }
}

/** A refused shape, in the words the phone shows. Never the offending value. */
function refused(what: string, problems: string[]): string {
    logger.debug(`[API MACHINE] refusing to relay a drover ${what}: ${problems.join('; ')}`);
    return `This machine's drover returned a ${what} with fields the phone must not receive, so nothing was sent. `
        + `Update cattle-drover. (${problems.length} problem(s): ${problems.slice(0, 3).join('; ')})`;
}

export async function readMachineFilesList(request: DroverFilesRequest, deps: MachineFilesDeps = {}): Promise<DroverFilesListResult> {
    const { answer, failure } = await ask(deps, `/v1/files?root=${encode(request.root)}&path=${encode(request.path ?? '')}`);
    if (!answer || answer.status !== 200) return { ok: false, error: busTrouble(answer, failure) };
    const problems = droverFilesListLeaks(answer.body);
    if (problems.length) return { ok: false, error: refused('listing', problems) };
    return { ok: true, listing: answer.body as DroverFilesList };
}

export async function readMachineFile(request: DroverFilesRequest, deps: MachineFilesDeps = {}): Promise<DroverFileReadResult> {
    const { answer, failure } = await ask(deps, `/v1/files/read?root=${encode(request.root)}&path=${encode(request.path ?? '')}`);
    if (!answer || answer.status !== 200) return { ok: false, error: busTrouble(answer, failure) };
    const problems = droverFileReadLeaks(answer.body);
    if (problems.length) return { ok: false, error: refused('file', problems) };
    const file = answer.body as DroverFileRead;
    if (typeof file.content !== 'string') return { ok: true, file };
    // The net. Zero is the expected count; anything else is drift between the
    // drover's vocabulary and this one, worth a line here and a number there.
    const net = redactTextCounting(file.content);
    if (net.count) {
        logger.debug(`[API MACHINE] the daemon masked ${net.count} span(s) in ${file.path} the drover had let through`);
    }
    return { ok: true, file: { ...file, content: net.text, redacted: file.redacted + net.count } };
}

export async function readMachinePane(request: DroverPaneRequest, deps: MachineFilesDeps = {}): Promise<DroverPaneResult> {
    const target = 'sessionId' in request
        ? `session=${encode(request.sessionId)}`
        : `cwd=${encode(request.cwd)}`;
    const lines = request.lines ? `&lines=${Math.max(1, Math.floor(request.lines))}` : '';
    const { answer, failure } = await ask(deps, `/v1/pane?${target}${lines}`);
    if (!answer || answer.status !== 200) return { ok: false, error: busTrouble(answer, failure) };
    const problems = droverPaneLeaks(answer.body);
    if (problems.length) return { ok: false, error: refused('pane', problems) };
    const pane = answer.body as DroverPane;
    let caught = 0;
    const cleaned = pane.lines.map((line) => {
        const net = redactTextCounting(line);
        caught += net.count;
        return net.text;
    });
    if (caught) logger.debug(`[API MACHINE] the daemon masked ${caught} span(s) on pane ${pane.pane} the drover had let through`);
    return { ok: true, pane: { ...pane, lines: cleaned, redacted: pane.redacted + caught } };
}

/**
 * On the DAEMON, beside `drover-mcps` and for the same reason: a worktree
 * belongs to the machine, and the one Clay tapped may have no session running
 * in it to ask.
 */
export function registerMachineFilesHandlers(rpcHandlerManager: RpcHandlerManager, deps: MachineFilesDeps = {}): void {
    rpcHandlerManager.registerHandler<DroverFilesRequest, DroverFilesListResult>(
        'drover-files-list',
        async (request) => {
            logger.debug('[API MACHINE] Received drover-files-list RPC request');
            if (!request || typeof request.root !== 'string') return { ok: false, error: 'a listing needs a root' };
            return await readMachineFilesList(request, deps);
        },
    );
    rpcHandlerManager.registerHandler<DroverFilesRequest, DroverFileReadResult>(
        'drover-files-read',
        async (request) => {
            logger.debug('[API MACHINE] Received drover-files-read RPC request');
            if (!request || typeof request.root !== 'string' || typeof request.path !== 'string') {
                return { ok: false, error: 'a read needs a root and a path' };
            }
            return await readMachineFile(request, deps);
        },
    );
    rpcHandlerManager.registerHandler<DroverPaneRequest, DroverPaneResult>(
        'drover-pane',
        async (request) => {
            logger.debug('[API MACHINE] Received drover-pane RPC request');
            const r = request as Partial<{ sessionId: string; cwd: string }> | null;
            if (!r || (typeof r.sessionId !== 'string' && typeof r.cwd !== 'string')) {
                return { ok: false, error: 'a pane needs a sessionId or a cwd' };
            }
            return await readMachinePane(request, deps);
        },
    );
}
