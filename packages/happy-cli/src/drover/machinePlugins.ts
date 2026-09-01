/**
 * The plugins ON THIS MACHINE, managed from the phone (DROVE-310).
 *
 * Clay: "managing the extensions (let's actually call them plugins) should
 * actually support being managed from the mobile app ... enable disable install
 * globally install for a specific harness etc.. all from the mobile app". So
 * unlike the MCP relay (DROVE-274), which only reads, this carries WRITES too:
 * `drover-plugins` reads, `drover-plugin-op` enables/disables/installs/
 * uninstalls/inspects.
 *
 * THE WORK IS NOT DONE HERE, on purpose, and this file is a relay.
 * cattle-drover's `engine/plugins.js` owns the drover.yaml the user's choices
 * live in and the catalog they install from, and decides what may be said out
 * loud. Keeping the reader and the writer THERE keeps the count at one, the same
 * rule machineMcps.ts follows: the terminal (`drover plugins`) and the phone
 * cannot disagree because they call the same module.
 *
 * READ HAS A FALLBACK; WRITE DOES NOT. A read tries the loopback bus, then
 * `drover plugins --json` — because the moment you most want to see your plugins
 * is while debugging the machine, which is exactly when the bus is the thing you
 * stopped. A mutation needs the bus (the CLI view is read-only), so a write with
 * the bus down is an honest error, not a silent no-op. And the bus is a THIRD
 * process: these routes 404 until it is kickstarted, not just the daemon.
 *
 * NOTHING CREDENTIAL-SHAPED PASSES THROUGH, and this file does not take that on
 * trust. A plugin manifest is somebody else's file and an install source is
 * where a token hides. The drover sanitizes before it answers, and
 * `pluginReportLeaks` re-checks HERE — before the payload is encrypted and
 * posted — because the producer is a plain-JS module in another repo on its own
 * cadence and this process is the last place that can still say no. A report
 * that fails is refused outright: the phone gets a sentence, not a filtered
 * payload, because silently stripping a leak teaches nobody the drover leaked.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
    pluginReportLeaks,
    type PluginCatalogResult,
    type PluginOpOutcome,
    type PluginOpParams,
    type PluginOpResult,
    type PluginReport,
    type PluginReportResult,
} from '@slopus/happy-wire';

import { droverBinExists, droverBinPath } from '@/daemon/tmuxSpawn';
import { describeDroverError } from '@/drover/machineAccounts';
import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

const execFileAsync = promisify(execFile);

/** Same default as machineMcps.ts and droverBridge.ts: the loopback bus. */
const droverUrl = (): string => process.env.DROVER_URL || 'http://127.0.0.1:7970';

/** Short: a person is looking at a spinner, and the fallback beats a long wait. */
const BUS_TIMEOUT_MS = 3000;
/** Longer: an install may clone a repo or pull a tarball. */
const OP_TIMEOUT_MS = 60_000;

export interface MachinePluginsDeps {
    fetchBus?: (path: string) => Promise<unknown>;
    postBus?: (path: string, body: unknown) => Promise<unknown>;
    runCli?: (args: string[]) => Promise<string>;
    droverBin?: string;
    exists?: (path: string) => boolean;
}

async function fetchFromBus(path: string): Promise<unknown> {
    const res = await fetch(`${droverUrl()}${path}`, { signal: AbortSignal.timeout(BUS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`the bus answered ${res.status}`);
    return await res.json();
}

async function postToBus(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${droverUrl()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(OP_TIMEOUT_MS),
    });
    // A 400/404 still carries a JSON reason the phone should see.
    const text = await res.text();
    let parsed: unknown = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    if (!res.ok && (!parsed || typeof parsed !== 'object')) {
        throw new Error(`the bus answered ${res.status}`);
    }
    return parsed;
}

/**
 * Shaped like a report, at all — not a schema. A strict parse would reject a
 * drover that added a field, which is the version skew this relay exists to
 * survive. It refuses only the answer that would render as an empty page.
 */
function looksLikeReport(value: unknown): value is PluginReport {
    if (!value || typeof value !== 'object') return false;
    return Array.isArray((value as PluginReport).plugins);
}

/**
 * The leak gate over any shape carrying plugins — a report, a catalog, or an op
 * outcome's `plugin`/`manifest`. Passes the plugins into the array the leak
 * walker allow-lists, and the whole object into the forbidden-key walk, so a
 * token hung anywhere is caught before the payload is encrypted.
 */
function leaksIn(value: unknown, plugins: unknown[]): string[] {
    return pluginReportLeaks({ ...(value as object), plugins: plugins.filter(Boolean) });
}

export async function readMachinePlugins(
    deps: MachinePluginsDeps = {},
    opts: { catalog?: boolean } = {},
): Promise<PluginReportResult | PluginCatalogResult> {
    const path = opts.catalog ? '/v1/plugins/catalog' : '/v1/plugins';
    const cliArgs = opts.catalog ? ['plugins', '--catalog', '--json'] : ['plugins', '--json'];
    const attempts: string[] = [];

    let report: unknown = null;
    try {
        report = await (deps.fetchBus ?? fetchFromBus)(path);
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
                error: `Could not read this machine's plugins — tried ${attempts.join(', and ')}. `
                    + 'Point the daemon at your cattle-drover checkout with DROVER_BIN (or DROVER_DIR) and restart it.',
            };
        }
        try {
            const stdout = await (deps.runCli ?? (async (args: string[]) => {
                const { stdout } = await execFileAsync(droverBin, args, { maxBuffer: 4 * 1024 * 1024 });
                return stdout;
            }))(cliArgs);
            report = JSON.parse(stdout);
        } catch (error) {
            attempts.push(`the wrapper: ${describeDroverError(error)}`);
        }
    }

    if (!looksLikeReport(report)) {
        return { ok: false, error: `Could not read this machine's plugins — tried ${attempts.join(', and ')}.` };
    }

    const leaks = leaksIn(report, (report as PluginReport).plugins);
    if (leaks.length) {
        logger.debug(`[API MACHINE] refusing to relay a plugin report: ${leaks.join('; ')}`);
        return {
            ok: false,
            error: 'This machine\'s drover returned plugin metadata carrying credential-shaped fields, so nothing was sent. '
                + `Update cattle-drover. (${leaks.length} field(s): ${leaks.slice(0, 3).join('; ')})`,
        };
    }

    // Both PluginReport and PluginCatalogReport are `{ ok: true, report }`.
    return { ok: true, report: report as PluginReport } as PluginReportResult;
}

/** The bus route and body one op maps to. */
function routeFor(params: PluginOpParams): { path: string; body: unknown } {
    switch (params.op) {
        case 'install':
            return { path: '/v1/plugins/install', body: { source: params.source, scope: params.scope, enabled: params.enabled } };
        case 'inspect':
            return { path: '/v1/plugins/inspect', body: { source: params.source } };
        case 'enable':
            return { path: `/v1/plugins/${encodeURIComponent(params.name ?? '')}/enable`, body: { scope: params.scope } };
        case 'disable':
            return { path: `/v1/plugins/${encodeURIComponent(params.name ?? '')}/disable`, body: {} };
        case 'uninstall':
            return { path: `/v1/plugins/${encodeURIComponent(params.name ?? '')}/uninstall`, body: {} };
        default:
            throw new Error(`unknown plugin op: ${(params as PluginOpParams).op}`);
    }
}

export async function runPluginOp(params: PluginOpParams, deps: MachinePluginsDeps = {}): Promise<PluginOpResult> {
    if ((params.op === 'enable' || params.op === 'disable' || params.op === 'uninstall') && !params.name) {
        return { ok: false, error: `a ${params.op} needs a plugin name` };
    }
    if ((params.op === 'install' || params.op === 'inspect') && !params.source) {
        return { ok: false, error: `an ${params.op} needs a source` };
    }

    let route: { path: string; body: unknown };
    try {
        route = routeFor(params);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    let outcome: unknown;
    try {
        outcome = await (deps.postBus ?? postToBus)(route.path, route.body);
    } catch (error) {
        // A mutation has no CLI fallback — the terminal view is read-only, and
        // the bus is a third process the ship loop restarts.
        return {
            ok: false,
            error: `Could not reach this machine's drover bus to ${params.op} — ${error instanceof Error ? error.message : String(error)}. `
                + 'The bus is a separate process; make sure it is running (kickstart com.bitspur.cattle-drover.bus).',
        };
    }

    if (!outcome || typeof outcome !== 'object') {
        return { ok: false, error: `The drover bus gave no answer to ${params.op}.` };
    }
    const o = outcome as PluginOpOutcome;
    if (o.ok === false) {
        return { ok: false, error: o.error ?? `the ${params.op} failed` };
    }

    // The same gate as the read: never relay an outcome carrying a
    // credential-shaped field, whichever of plugin/manifest/source it is on.
    const leaks = leaksIn(o, [o.plugin, o.manifest]);
    if (leaks.length) {
        logger.debug(`[API MACHINE] refusing to relay a plugin op result: ${leaks.join('; ')}`);
        return {
            ok: false,
            error: 'This machine\'s drover returned plugin metadata carrying credential-shaped fields, so nothing was sent. '
                + `Update cattle-drover. (${leaks.length} field(s): ${leaks.slice(0, 3).join('; ')})`,
        };
    }

    return { ok: true, outcome: o };
}

export function registerMachinePluginsHandlers(
    rpcHandlerManager: RpcHandlerManager,
    deps: MachinePluginsDeps = {},
): void {
    rpcHandlerManager.registerHandler<{ catalog?: boolean } | undefined, PluginReportResult | PluginCatalogResult>(
        'drover-plugins',
        async (params) => {
            logger.debug('[API MACHINE] Received drover-plugins RPC request');
            return await readMachinePlugins(deps, { catalog: params?.catalog === true });
        },
    );
    rpcHandlerManager.registerHandler<PluginOpParams, PluginOpResult>(
        'drover-plugin-op',
        async (params) => {
            logger.debug(`[API MACHINE] Received drover-plugin-op RPC request: ${params?.op}`);
            return await runPluginOp(params, deps);
        },
    );
}
