/**
 * One MCP server, acted on, relayed from the phone (DROVE-291).
 *
 * `machineMcps.ts` is the LIST and it is read-only by design — DROVE-274 shipped
 * seeing and stopped there. Clay, holding that list on his phone: "Shouldn't I
 * be able to click on these and reconnect authenticate etc…". These three verbs
 * are that, and each one is a thin relay to a cattle-drover route that does the
 * deciding.
 *
 * THE HONESTY CONSTRAINT TRAVELS WITH THE PAYLOAD. An MCP connection belongs to
 * a SESSION, so nothing in this file may turn "the machine asked and got an
 * answer" into "the server is up". `observedAt` is required on the wire type
 * and the phone always renders it. Nothing here summarises, rounds or
 * reinterprets what the machine said; the sentences are the machine's.
 *
 * BUS ONLY, NO CLI FALLBACK, the same line `machineProviders.ts` draws and for
 * the same reason. A read falling back to `drover mcps --json` is better than a
 * blank page; a RECONNECT or a REAUTH falling back to spawning a binary is a
 * second way to start a process on Clay's Mac, on a path with different
 * argument handling, reachable exactly when the daemon cannot talk to its own
 * loopback. If the bus is down the honest answer is that the machine is not
 * ready.
 *
 * NO CREDENTIAL, IN EITHER DIRECTION. The reauth answer is one string — the
 * name of a tmux window — because the OAuth dance happens between the harness
 * on the Mac and the server's own login page (DROVE-318). No code, no token, no
 * redirect url passes through this process. The leak gate below runs on health
 * before it is relayed, for the reason `machineMcps.ts` gives: catch it on the
 * machine, before it is encrypted and posted, rather than on the phone.
 *
 * These routes 404 until the BUS is kickstarted, not just the daemon, so that
 * failure gets its own sentence rather than "the bus answered 404" — which is
 * true and useless.
 */

import {
    mcpHealthLeaks,
    type McpHealth,
    type McpHealthResult,
    type McpReauthStarted,
    type McpReconnectDone,
} from '@slopus/happy-wire';

import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

/** Same default as machineMcps.ts and machineProviders.ts: the loopback bus. */
const droverUrl = (): string => process.env.DROVER_URL || 'http://127.0.0.1:7970';

/**
 * Longer than the list read's 3000ms, and deliberately so: a health probe
 * really opens a connection to the server, and two of the five harnesses answer
 * for all forty of theirs at once. The machine caps its own probe at six
 * seconds and answers "still asking" rather than hanging, so this only has to
 * outlast that plus the round trip.
 */
const BUS_TIMEOUT_MS = 12000;

export interface MachineMcpHealthDeps {
    /** Injected in tests. Real calls go over loopback to the drover bus. */
    callBus?: (method: string, path: string) => Promise<{ status: number; json: unknown }>;
}

async function callBus(method: string, path: string): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${droverUrl()}${path}`, {
        method,
        signal: AbortSignal.timeout(BUS_TIMEOUT_MS),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * A server name is one path segment and is encoded as one. Real names on this
 * machine include `claude-ai-Google-Drive` and `chrome-devtools`; a name with a
 * slash in it would otherwise route as a third segment and 404 confusingly.
 */
function routeFor(harness: string, server: string, action?: string): string {
    const base = `/v1/mcps/${encodeURIComponent(harness)}/${encodeURIComponent(server)}`;
    return action ? `${base}/${action}` : base;
}

const staleDrover = 'This machine\'s drover has no MCP health routes yet — restart the drover on it and try again.';

function unreachable(error: unknown): string {
    const said = error instanceof Error ? error.message : String(error);
    return `Could not reach the drover on this machine (${said}) — start it and try again.`;
}

/**
 * A drover that predates this ticket answers 404 on every route here, and a
 * server that is genuinely not configured ALSO answers 404 — with a body that
 * names it. The body is what tells them apart, so the sentence is chosen on the
 * body and not on the status alone.
 */
function said(body: Record<string, unknown> | null, status: number): string {
    if (body && typeof body.error === 'string') return body.error;
    if (status === 404) return staleDrover;
    return `the bus answered ${status}`;
}

export async function readMcpHealth(
    harness: string,
    server: string,
    deps: MachineMcpHealthDeps = {},
): Promise<McpHealthResult> {
    let result: { status: number; json: unknown };
    try {
        result = await (deps.callBus ?? callBus)('GET', routeFor(harness, server));
    } catch (error) {
        return { ok: false, error: unreachable(error) };
    }
    const body = result.json as Record<string, unknown> | null;
    if (result.status !== 200 || !body) return { ok: false, error: said(body, result.status) };

    // The gate, on the machine, before this is encrypted and posted. It REFUSES
    // rather than filters: a health answer carrying a key that can hold a
    // credential is a bug in the producer, and quietly deleting the field would
    // hide it until the next payload leaked something the filter did not know.
    const leaks = mcpHealthLeaks(body);
    if (leaks.length > 0) {
        logger.debug(`[API MACHINE] refusing to relay MCP health: ${leaks.join('; ')}`);
        return {
            ok: false,
            error: 'This machine\'s drover offered an MCP health answer that could carry a credential, so it was not sent.',
        };
    }
    return { ok: true, health: body as unknown as McpHealth };
}

export async function reconnectMcp(
    harness: string,
    server: string,
    deps: MachineMcpHealthDeps = {},
): Promise<McpReconnectDone> {
    let result: { status: number; json: unknown };
    try {
        result = await (deps.callBus ?? callBus)('POST', routeFor(harness, server, 'reconnect'));
    } catch (error) {
        return { ok: false, harness, server, error: unreachable(error) };
    }
    const body = result.json as Record<string, unknown> | null;
    if (body && typeof body.ok === 'boolean') return body as unknown as McpReconnectDone;
    return { ok: false, harness, server, error: said(body, result.status) };
}

export async function reauthMcp(
    harness: string,
    server: string,
    deps: MachineMcpHealthDeps = {},
): Promise<McpReauthStarted> {
    let result: { status: number; json: unknown };
    try {
        result = await (deps.callBus ?? callBus)('POST', routeFor(harness, server, 'reauth'));
    } catch (error) {
        return { ok: false, harness, server, error: unreachable(error) };
    }
    const body = result.json as Record<string, unknown> | null;
    if (body && typeof body.ok === 'boolean') return body as unknown as McpReauthStarted;
    return { ok: false, harness, server, error: said(body, result.status) };
}

interface ServerRef {
    harness?: unknown;
    server?: unknown;
}

/** A request that names neither is a bug on the phone, not a reason to guess. */
function refOf(req: ServerRef | null | undefined): { harness: string; server: string } | null {
    const harness = typeof req?.harness === 'string' ? req.harness.trim() : '';
    const server = typeof req?.server === 'string' ? req.server.trim() : '';
    if (!harness || !server) return null;
    return { harness, server };
}

export function registerMachineMcpHealthHandlers(
    rpcHandlerManager: RpcHandlerManager,
    deps: MachineMcpHealthDeps = {},
): void {
    rpcHandlerManager.registerHandler<ServerRef, McpHealthResult>('drover-mcp-health', async (req) => {
        const ref = refOf(req);
        if (!ref) return { ok: false, error: 'no MCP server was named' };
        logger.debug(`[API MACHINE] drover-mcp-health ${ref.harness}/${ref.server}`);
        return await readMcpHealth(ref.harness, ref.server, deps);
    });

    rpcHandlerManager.registerHandler<ServerRef, McpReconnectDone>('drover-mcp-reconnect', async (req) => {
        const ref = refOf(req);
        if (!ref) return { ok: false, harness: '', server: '', error: 'no MCP server was named' };
        // The verb and the server, which is the vocabulary answerLogLine
        // settled on for the bridge: what happened, never what was in it.
        logger.debug(`[API MACHINE] drover-mcp-reconnect ${ref.harness}/${ref.server}`);
        return await reconnectMcp(ref.harness, ref.server, deps);
    });

    rpcHandlerManager.registerHandler<ServerRef, McpReauthStarted>('drover-mcp-reauth', async (req) => {
        const ref = refOf(req);
        if (!ref) return { ok: false, harness: '', server: '', error: 'no MCP server was named' };
        logger.debug(`[API MACHINE] drover-mcp-reauth ${ref.harness}/${ref.server}`);
        return await reauthMcp(ref.harness, ref.server, deps);
    });
}
