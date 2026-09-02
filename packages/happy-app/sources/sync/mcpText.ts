/**
 * The sentences the MCP view puts on screen (DROVE-274).
 *
 * Pure, and deliberately in its own file with no import but the wire types.
 * They started next to the RPC client, which reaches apiSocket and from there
 * the whole expo runtime — so every test of a sentence became a test that has
 * to boot React Native. The transport and the wording have no reason to share
 * a module, and now they do not.
 */

import type { McpHealthState, McpReport, ProviderReport } from '@slopus/happy-wire';

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

/**
 * The footer under a harness that has no account group of its own — Codex and
 * OpenCode, today.
 *
 * ONE LINE (DROVE-346). It used to run four: where the config lives, then the
 * counts again, then read-only, then an apology that editing "is not built
 * yet". Clay scribbled all of it out.
 *
 * Every piece that went is said better somewhere else on the same screen. The
 * counts are already ON the row: `MachineMcpRows` draws `harness.count` as the
 * badge beside the chevron, and each scope's own count on the row below, so
 * saying "42 servers, 1 disabled" in prose underneath was the second telling of
 * a number the eye had just read. And the apology described a ROADMAP, not this
 * screen: a reader learns there is nothing to edit from there being nothing to
 * tap, without being told what we have not got round to building.
 *
 * `mcpSummaryLine` is left exported and unused by this function on purpose —
 * it is the pure phrasing of that count and the row may want it back.
 *
 * What is left is the fact a reader cannot get anywhere else, and it is the
 * one that answers "why is this not under an account?" — the file is the
 * machine's, not an account's.
 */
export function mcpOnlyFooter(harness: {
    configured: boolean;
    count: number;
    scopes: { servers: { enabled: boolean }[] }[];
    providers?: { count: number; modelCount: number } | null;
}): string {
    if (!harness.configured) return 'Read-only here.';
    return 'One file on this machine. Read-only here.';
}

/**
 * The one line under the Model providers heading (DROVE-296).
 *
 * Counts, same as the servers above, and for the same reason: Clay's OpenCode
 * lists 141 models across five providers, and 141 names is not a summary. The
 * DECLARED-only count is called out separately because it is the one that
 * means something is wrong — a provider his config declares and the harness
 * did not list is a provider whose key never arrived, so a pick against it
 * fails at exec.
 */
export function providerSummaryLine(report: ProviderReport): string {
    if (report.missing) return 'This harness is not installed here';
    if (report.error) return `\`${report.asked}\` ${report.error}`;
    if (!report.count) return 'None configured';
    const providers = `${report.count} provider${report.count === 1 ? '' : 's'}`;
    const models = `${report.modelCount} model${report.modelCount === 1 ? '' : 's'}`;
    const unusable = report.providers.filter((p) => p.origin === 'declared').length;
    return unusable ? `${providers}, ${models}, ${unusable} not available` : `${providers}, ${models}`;
}

/**
 * Why the provider list is empty, in the machine's own terms.
 *
 * Three empties again and they still mean different things: the harness is not
 * on that machine, the harness is there and would not answer, and the harness
 * answered with nothing. Only the third is "you have configured none".
 */
export function providerEmptyReason(report: ProviderReport): string | null {
    if (report.count) return null;
    if (report.missing) return 'No OpenCode on this machine, so it lists no providers.';
    if (report.error) return `\`${report.asked}\` ${report.error} on this machine.`;
    if (report.configError) return `${report.config} could not be read (${report.configError}).`;
    return `\`${report.asked}\` listed none, and ${report.config} declares none.`;
}

/**
 * What a provider's `origin` means, said rather than shown as a word nobody
 * can decode. Null for the ordinary case — a provider that simply works needs
 * no explanation, and a label under every row is noise that hides the one row
 * that matters.
 */
export function providerOriginLine(origin: string): string | null {
    if (origin === 'declared') return 'Declared in the config, not listed by OpenCode — usually a missing key';
    if (origin === 'both') return 'Declared in the config and listed by OpenCode';
    return null;
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

// --- one server, acted on (DROVE-291) ----------------------------------------
//
// The same rule as everything above: the copy is decided in one place, so the
// sheet and any future surface cannot disagree about what a state means. And
// the DROVE-346 rule — ONE FRAGMENT. A sheet that explains itself in paragraphs
// is a sheet nobody finishes reading.

/**
 * `Seen just now` / `Seen 3 minutes ago`.
 *
 * Its own function rather than mcpReadAgo's wording, because these are two
 * different facts and reading them in the same words is how they get confused:
 * `Read` is when the machine looked at a config FILE, `Seen` is when it last
 * got an answer from a running SERVER.
 */
export function mcpObservedAgo(observedAt: number, now: number = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - observedAt) / 1000));
    if (seconds < 45) return 'Seen just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `Seen ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Seen ${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `Seen ${days} day${days === 1 ? '' : 's'} ago`;
}

/** The one word at the top of the sheet. */
export function mcpHealthTitle(state: McpHealthState): string {
    switch (state) {
        case 'connected': return 'Connected';
        case 'failing': return 'Not connecting';
        case 'needs-auth': return 'Needs sign-in';
        default: return 'Not known';
    }
}

/**
 * `ok` / `warn` / `unknown` — which of the screen's three colours a state gets.
 * Named rather than returning a hex, so the component keeps its palette and
 * this file keeps the judgement.
 *
 * `unknown` is its own tone and NOT a warning. Codex has no verb that opens a
 * connection, so every Codex server is permanently unknown; painting forty rows
 * amber would teach Clay to ignore amber.
 */
export function mcpHealthTone(state: McpHealthState): 'ok' | 'warn' | 'unknown' {
    if (state === 'connected') return 'ok';
    if (state === 'unknown') return 'unknown';
    return 'warn';
}
