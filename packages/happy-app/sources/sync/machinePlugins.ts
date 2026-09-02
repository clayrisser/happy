/**
 * A machine's plugins, read AND managed from the phone (DROVE-310).
 *
 * Beside machineMcps.ts and for its reasons: the drover surfaces answer
 * `{ ok: false, error }` rather than throwing, so a control that fails says
 * why instead of looking like it worked.
 *
 * NOT read-only, and that is the difference from the MCP view. Clay:
 * "managing the extensions (let's actually call them plugins) should actually
 * support being managed from the mobile app ... enable disable install
 * globally install for a specific harness etc.. all from the mobile app". So
 * every verb the terminal has is here.
 *
 * A PLUGIN is shotgun content and only that: an MCP with the skills and hooks
 * around it. A harness (claude/cursor/codex/opencode/pi) and an OS installer
 * (tmux, node, gum) are NOT plugins — the drover's catalog walk skips them by
 * kind, so the phone never sees one and cannot install one from here. The
 * `harnesses` array on a report is the set a plugin may be SCOPED to.
 *
 * THE WORK IS NOT DONE HERE. cattle-drover's `engine/plugin/ops.js` owns the
 * drover.yaml the choices live in, the catalog they install from, and what may
 * be said out loud; happy-cli's daemon relays it; this asks. One writer, so the
 * terminal and the phone cannot disagree about what is installed.
 *
 * NO CREDENTIAL VALUE CROSSES THIS. A plugin may NAME a credential it needs
 * and NAME the config keys drover.yaml sets for it; the value never leaves the
 * machine and there is no call here that could carry one back. An install
 * source with a token in its url is refused BY THE MACHINE rather than
 * sanitized, so a mistyped url fails loudly instead of half-working.
 *
 * Fetched when the page opens, and again after every write, because a write is
 * the one thing that makes the answer stale. No polling: this is config, it
 * changes when somebody edits a file or presses one of these rows.
 */

import type {
    PluginCatalogResult,
    PluginOpParams,
    PluginOpResult,
    PluginReportResult,
} from '@slopus/happy-wire';

import { apiSocket } from './apiSocket';

export type {
    PluginCapabilities,
    PluginCatalogError,
    PluginCatalogReport,
    PluginFrom,
    PluginHookSummary,
    PluginIdentity,
    PluginInstallSource,
    PluginLinksReport,
    PluginMcpSummary,
    PluginOpOutcome,
    PluginOpParams,
    PluginOpResult,
    PluginOrigin,
    PluginProvides,
    PluginReport,
    PluginRequires,
    PluginScope,
    PluginState,
    PluginSummary,
    PluginVendorSummary,
} from '@slopus/happy-wire';

export type MachinePluginsResult = PluginReportResult;

/**
 * What that machine MANAGES: every drover.yaml entry and every store row.
 *
 * Asked of the DAEMON, like the MCP list, and for the same reason: a plugin
 * belongs to the machine and has to be answerable with nothing running there.
 */
export async function machineDroverPlugins(machineId: string): Promise<MachinePluginsResult> {
    return await ask(machineId, {});
}

/**
 * What the catalog OFFERS, each with its state on this machine.
 *
 * A second call rather than a field on the first: the managed list is the one
 * the page opens with and is usually short, and the catalog is the browse
 * view. Loading both to draw one is the machine spending on a question nobody
 * asked.
 */
export async function machineDroverPluginCatalog(machineId: string): Promise<PluginCatalogResult> {
    return await ask(machineId, { catalog: true });
}

async function ask(machineId: string, params: { catalog?: boolean }): Promise<PluginReportResult> {
    try {
        return await apiSocket.machineRPC<PluginReportResult, { catalog?: boolean }>(
            machineId,
            'drover-plugins',
            params,
        );
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}

/**
 * Enable, disable, install, uninstall — or inspect a source without installing
 * it.
 *
 * Every one is an edit to the user's drover.yaml on that machine and a render
 * of the mirror, done there. The outcome carries the plugin as it now stands
 * and the STALE-SESSIONS count, because a disable does not reach a running
 * session until it restarts (DROVE-220) and the phone has to say so rather
 * than imply the change is live everywhere.
 */
export async function machineDroverPluginOp(
    machineId: string,
    params: PluginOpParams,
): Promise<PluginOpResult> {
    try {
        return await apiSocket.machineRPC<PluginOpResult, PluginOpParams>(
            machineId,
            'drover-plugin-op',
            params,
        );
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}

// The wording lives in pluginText.ts (pure, and testable without a renderer);
// re-exported here so a caller needs one import for the whole surface.
export {
    pluginCountsLine,
    pluginCredentialsLine,
    pluginEmptyReason,
    pluginLinksLine,
    pluginOpDone,
    pluginOpTitle,
    pluginOriginLine,
    pluginProvidesLine,
    pluginReadAgo,
    pluginScopeLine,
    pluginStaleLine,
    pluginTouchesLine,
    pluginVarsLine,
    pluginWhenLine,
} from './pluginText';
export { pluginStateLine } from '@slopus/happy-wire';
