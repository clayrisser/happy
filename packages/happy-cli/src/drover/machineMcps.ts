/**
 * The MCP servers configured ON THIS MACHINE, read from the phone (DROVE-274).
 *
 * Clay: "the ability to see its MCPs that are configured ... MCPs are
 * configured differently per harness so I guess under each harness you see the
 * MCPs". Read-only on this pass, explicitly — he deferred the config half, so
 * there is no write verb here and adding one is a decision.
 *
 * THE READING IS NOT DONE HERE, on purpose, and this file is a relay.
 * cattle-drover's `engine/mcp.js` knows where each harness keeps its config and
 * decides what may be said out loud; both routes below call it. That keeps the
 * count at ONE reader, which is the same rule machineAccounts.ts argues for and
 * lands on the opposite answer — accounts are read in process because the flip
 * PICKER already reads them here and a second reader could disagree with the
 * picker. Nothing in this CLI reads an MCP config at all, so the reader that
 * exists is the drover's, and duplicating it in TypeScript would create exactly
 * the divergence that rule is about.
 *
 * TWO ROUTES TO THE SAME MODULE.
 *
 *   1. GET /v1/mcps on the loopback bus. First, because it is one request and
 *      the bus is usually up.
 *   2. `drover mcps --json`. Because the bus is NOT always up, and the moment
 *      you most want to see whether an account still has its servers is while
 *      you are debugging the machine — which is exactly when the bus is the
 *      thing you stopped. A view that goes dark then is a view that is missing
 *      when it is needed.
 *
 * NOTHING CREDENTIAL-SHAPED PASSES THROUGH, and this file does not take that on
 * trust. An MCP definition is mostly secret — `env` holds API keys, `args` holds
 * whatever got pasted on a command line, a remote `url` routinely carries a
 * token — and the drover builds every field it returns rather than copying one
 * out of a config. `mcpReportLeaks` re-checks that HERE, before the payload is
 * encrypted and posted, because the producer is a plain-JS module in another
 * repository on its own release cadence and this process is the last place that
 * can still say no. A report that fails the check is refused outright: the phone
 * gets a sentence, not a filtered payload, because silently stripping a leak
 * teaches nobody that the drover started leaking.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { mcpReportLeaks, type McpReport, type McpReportResult } from '@slopus/happy-wire';

import { droverBinExists, droverBinPath } from '@/daemon/tmuxSpawn';
import { describeDroverError } from '@/drover/machineAccounts';
import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

const execFileAsync = promisify(execFile);

/** Same default as droverBridge.ts and dotPublish.ts: the loopback bus. */
const droverUrl = (): string => process.env.DROVER_URL || 'http://127.0.0.1:7970';

/**
 * Short. This is a page load, not a background sync — a person is looking at a
 * spinner — and the fallback below is a better answer than a long wait.
 */
const BUS_TIMEOUT_MS = 3000;

export interface MachineMcpsDeps {
    fetchBus?: () => Promise<unknown>;
    runCli?: () => Promise<string>;
    droverBin?: string;
    exists?: (path: string) => boolean;
}

async function fetchFromBus(): Promise<unknown> {
    const res = await fetch(`${droverUrl()}/v1/mcps`, {
        signal: AbortSignal.timeout(BUS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the bus answered ${res.status}`);
    return await res.json();
}

/**
 * Shaped like a report, at all. Not a schema — the wire types are structural
 * and a strict parse here would reject a drover that added a field, which is
 * the version skew this whole relay is built to survive. It only refuses the
 * two answers that would render as an empty page: not an object, and no
 * harnesses.
 */
function looksLikeReport(value: unknown): value is McpReport {
    if (!value || typeof value !== 'object') return false;
    return Array.isArray((value as McpReport).harnesses);
}

export async function readMachineMcps(deps: MachineMcpsDeps = {}): Promise<McpReportResult> {
    const attempts: string[] = [];

    let report: unknown = null;
    try {
        report = await (deps.fetchBus ?? fetchFromBus)();
    } catch (error) {
        attempts.push(`the drover bus: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!looksLikeReport(report)) {
        const droverBin = deps.droverBin ?? droverBinPath();
        const exists = deps.exists ?? droverBinExists;
        if (!deps.runCli && !exists(droverBin)) {
            attempts.push(`the wrapper: nothing at ${droverBin}`);
            return {
                ok: false,
                error: `Could not read this machine's MCP config — tried ${attempts.join(', and ')}. `
                    + 'Point the daemon at your cattle-drover checkout with DROVER_BIN (or DROVER_DIR) and restart it.',
            };
        }
        try {
            const stdout = await (deps.runCli ?? (async () => {
                const { stdout } = await execFileAsync(droverBin, ['mcps', '--json'], { maxBuffer: 4 * 1024 * 1024 });
                return stdout;
            }))();
            report = JSON.parse(stdout);
        } catch (error) {
            attempts.push(`the wrapper: ${describeDroverError(error)}`);
        }
    }

    if (!looksLikeReport(report)) {
        return { ok: false, error: `Could not read this machine's MCP config — tried ${attempts.join(', and ')}.` };
    }

    // The gate. Loud and refusing, not quiet and filtering: a leak that gets
    // scrubbed on the way past is a leak nobody fixes.
    const leaks = mcpReportLeaks(report);
    if (leaks.length) {
        logger.debug(`[API MACHINE] refusing to relay an MCP report: ${leaks.join('; ')}`);
        return {
            ok: false,
            error: 'This machine\'s drover returned MCP config carrying credential-shaped fields, so nothing was sent. '
                + `Update cattle-drover. (${leaks.length} field(s): ${leaks.slice(0, 3).join('; ')})`,
        };
    }

    return { ok: true, report };
}

export function registerMachineMcpsHandlers(
    rpcHandlerManager: RpcHandlerManager,
    deps: MachineMcpsDeps = {},
): void {
    rpcHandlerManager.registerHandler<unknown, McpReportResult>(
        'drover-mcps',
        async () => {
            logger.debug('[API MACHINE] Received drover-mcps RPC request');
            return await readMachineMcps(deps);
        },
    );
}
