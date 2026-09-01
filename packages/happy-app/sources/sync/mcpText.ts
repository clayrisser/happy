/**
 * The sentences the MCP view puts on screen (DROVE-274).
 *
 * Pure, and deliberately in its own file with no import but the wire types.
 * They started next to the RPC client, which reaches apiSocket and from there
 * the whole expo runtime — so every test of a sentence became a test that has
 * to boot React Native. The transport and the wording have no reason to share
 * a module, and now they do not.
 */

import type { McpReport } from '@slopus/happy-wire';

/**
 * A harness's section, in the order the machine listed them.
 *
 * A helper rather than an inline find, because the page draws a section per
 * harness whether or not the machine reported one — a drover too old to know
 * about OpenCode must not make the OpenCode section vanish, it must make it
 * say so.
 */
export function harnessesToRender(report: McpReport | null): string[] {
    return report?.harnesses?.map((h) => h.harness) ?? [];
}

/**
 * The one line under a harness heading, before anything is expanded.
 *
 * Counts, not names. Forty names is not a summary, and the question this view
 * answers first is "are they there" — the names are one tap away.
 */
export function mcpSummaryLine(harness: {
    configured: boolean;
    count: number;
    scopes: { servers: { enabled: boolean }[] }[];
}): string {
    if (!harness.configured) return 'None configured';
    const disabled = harness.scopes[0]?.servers.filter((s) => !s.enabled).length ?? 0;
    const plural = harness.count === 1 ? 'server' : 'servers';
    return disabled ? `${harness.count} ${plural}, ${disabled} disabled` : `${harness.count} ${plural}`;
}

/**
 * Why a section is empty, in the machine's own terms.
 *
 * Three different empties and they mean different things: no config file at
 * all (the harness is probably not installed), a file that is there and holds
 * no MCP block (installed, nothing configured), and a file that could not be
 * read (something is wrong, go and look). Collapsing them into "None" is what
 * would send somebody hunting in the wrong place.
 */
export function mcpEmptyReason(harness: {
    configured: boolean;
    scopes: { source: string | null; missing: boolean; error: string | null }[];
}): string | null {
    if (harness.configured) return null;
    const scope = harness.scopes[0];
    if (!scope) return 'This machine did not say where it looked.';
    if (scope.error) return `${scope.source} could not be read (${scope.error}).`;
    if (scope.missing) return `No ${scope.source} on this machine.`;
    return `${scope.source} configures no MCP servers.`;
}

/** `Read 3 minutes ago`. Relative, because the absolute time means nothing here. */
export function mcpReadAgo(readAt: number, now: number = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - readAt) / 1000));
    if (seconds < 45) return 'Read just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `Read ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Read ${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `Read ${days} day${days === 1 ? '' : 's'} ago`;
}
