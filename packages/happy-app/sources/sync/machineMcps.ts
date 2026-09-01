/**
 * A machine's configured MCP servers, per harness, read from the phone
 * (DROVE-274).
 *
 * Beside machineAccounts.ts and for its reasons: the drover surfaces answer
 * `{ ok: false, error }` rather than throwing, so a control that fails says
 * why instead of looking like it worked.
 *
 * READ ONLY. Clay deferred configuring MCPs from here — "in the future we
 * might build on top of that to have essentially global MCP that we can
 * configure but yeah we want to start with harness" — so there is no write
 * call in this file and adding one is a decision, not a follow-up.
 *
 * Fetched when the page opens and never again. This is CONFIG: it changes when
 * somebody edits a file, not on a timer, so polling it would spend the machine
 * on a question whose answer is already on screen. `readAt` is what makes that
 * honest — the page says when it looked rather than implying it is live.
 */

import type { McpReport, McpReportResult } from '@slopus/happy-wire';

import { apiSocket } from './apiSocket';

export type { McpReport, McpHarnessReport, McpScope, McpServerSummary, McpTransport } from '@slopus/happy-wire';

export type MachineMcpsResult = McpReportResult;

/**
 * What that machine's harnesses are configured with right now.
 *
 * Asked of the DAEMON, like the accounts list, and for the same reason: MCP
 * config belongs to the machine and has to be answerable with nothing running
 * there. The daemon reads it through cattle-drover, which is the only thing
 * that knows where four harnesses each keep their config.
 */
export async function machineDroverMcps(machineId: string): Promise<MachineMcpsResult> {
    try {
        return await apiSocket.machineRPC<MachineMcpsResult, Record<string, never>>(
            machineId,
            'drover-mcps',
            {},
        );
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'the computer did not answer',
        };
    }
}

// The wording lives in mcpText.ts (pure, and testable without a renderer);
// re-exported here so a caller needs one import for the whole surface.
export { harnessesToRender, mcpEmptyReason, mcpReadAgo, mcpSummaryLine } from './mcpText';
