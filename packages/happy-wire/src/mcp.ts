/**
 * What a machine may say about the MCP servers its harnesses are configured
 * with (DROVE-274).
 *
 * Clay: "the ability to see its MCPs that are configured ... MCPs are
 * configured differently per harness so I guess under each harness you see the
 * MCPs". Global config was explicitly deferred, so this pass is SEEING only —
 * there is no patch type here, and adding one is a decision, not a refactor.
 *
 * Three processes touch this shape and none of them share a language runtime:
 * cattle-drover's `engine/mcp.js` builds it in plain JS, happy-cli's daemon
 * relays it over the machine RPC, and the app draws it. That is the same
 * three-cornered problem `statusDot.ts` had, and the same answer — the shape
 * lives on the wire so the two TypeScript ends cannot drift, and the drover's
 * tests/mcp.bats pins the third against it.
 *
 * WHAT MAY BE IN HERE, and it is the whole design constraint.
 *
 * An MCP server definition is mostly credential. `env` holds API keys, `args`
 * holds whatever got pasted on a command line, and a remote server's `url`
 * routinely carries a token in its query string. None of that is on this type,
 * and `mcpReportLeaks` below exists so the ban is CHECKABLE at runtime rather
 * than merely absent from an interface — a type cannot stop a producer from
 * putting an extra key on an object it hands over.
 *
 * A server is three facts: what it is called, how it is reached, and whether
 * it is switched on. That is enough to answer "are my MCPs there", which is
 * the question that produced this ticket.
 */

/**
 * How the harness reaches the server. `stdio` is a local subprocess; `http`
 * and `sse` are remote. `unknown` is honest rather than defaulted: an entry
 * whose shape we do not recognise is a thing to show, and calling it stdio
 * would be a guess presented as a reading.
 */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

/** One configured server. Three fields, and the count is not an accident. */
export interface McpServerSummary {
    name: string;
    transport: McpTransport;
    /**
     * False only when something on the machine actually says so — Claude's
     * `disabledMcpjsonServers`, Cursor's per-entry flag, Codex's `enabled`.
     * A server nothing disables is enabled.
     */
    enabled: boolean;
}

/**
 * How one scope's server list differs from the harness's default scope.
 *
 * Only Claude has more than one scope today, and this is the field the whole
 * per-account view was built for. DROVE-252 mirrors the default account's
 * servers outward, so `missing` is the mirror having failed to reach an
 * account — the bug that read, from the outside, as "what the fuck where are
 * all my mcps". `extra` is usually deliberate and is shown differently.
 */
export interface McpDivergence {
    /** In the default scope, absent here. */
    missing: string[];
    /** Here, absent from the default scope. */
    extra: string[];
}

/**
 * One config file's worth of servers. For a per-account harness there is one
 * of these per account, the default first; for every other harness there is
 * exactly one, `id: 'global'`.
 */
export interface McpScope {
    /** `default` for the primary config, `global` for a single-file harness, else the account id. */
    id: string;
    label: string;
    /** The config file, with `$HOME` collapsed to `~`. Never an OS username. */
    source: string | null;
    /** The file is not there. Not an error — a harness may simply be uninstalled. */
    missing: boolean;
    /**
     * The file is there and could not be read. Worth SAYING: an empty list
     * reads as "you configured nothing", which sends you looking in the wrong
     * place.
     */
    error: string | null;
    servers: McpServerSummary[];
    count: number;
    /** Null on the default scope, and on any scope too broken to diff. */
    divergence: McpDivergence | null;
}

/** One harness's section on the machine page. */
export interface McpHarnessReport {
    /** `claude` | `cursor` | `codex` | `opencode`. Open, so a fifth needs no wire change. */
    harness: string;
    /** What the section is headed with: `Claude Code`, `Cursor`, … */
    label: string;
    /** This harness keeps MCP config per account. Only Claude does, today. */
    perAccount: boolean;
    /** Default scope first. Never empty — a harness with no config still has the scope it looked in. */
    scopes: McpScope[];
    /** Distinct server names across every scope. */
    count: number;
    /**
     * False when the harness has no server anywhere. The section is still
     * drawn and says none: hiding it reads as "this harness cannot have MCPs",
     * which is a different and wrong claim.
     */
    configured: boolean;
    /** Any scope differs from the default. Saves the app walking every scope to find out. */
    diverged: boolean;
}

/** Everything one machine reports. */
export interface McpReport {
    machine: string;
    /**
     * When the machine READ THE FILES, epoch ms.
     *
     * This is config, not live state: nothing polls it and nothing pushes it,
     * so the app fetches on open and shows this. A screen with no timestamp
     * would be indistinguishable from a screen that had stopped updating.
     */
    readAt: number;
    harnesses: McpHarnessReport[];
}

export type McpReportResult =
    | { ok: true; report: McpReport }
    | { ok: false; error: string };

/**
 * Every key that may appear on a server summary. The allowlist is the check —
 * a denylist of `env`, `args` and the rest would pass the first key nobody
 * thought of.
 */
export const mcpServerAllowedKeys: readonly string[] = Object.freeze(['name', 'transport', 'enabled']);

/**
 * Names that must never appear as a key anywhere in a report, at any depth.
 *
 * The allowlist above already covers the server objects, so this is the second
 * net: it catches a producer that hangs a credential off a SCOPE or a harness
 * rather than off a server, which the per-server check would sail past.
 */
export const mcpForbiddenKeys: readonly string[] = Object.freeze([
    'env', 'args', 'command', 'url', 'headers', 'token', 'apiKey', 'api_key',
    'secret', 'password', 'authorization', 'credential', 'credentials',
]);

/**
 * Everything wrong with a report, as sentences. Empty means it is safe to send.
 *
 * A runtime check and not just a type, because the producer is a plain-JS
 * module in another repository that TypeScript never sees. The app calls this
 * on what arrives and the CLI calls it on what it is about to relay, so a
 * leak is caught on the machine — before it is encrypted and posted — rather
 * than discovered on the phone.
 *
 * It walks the whole object rather than the fields this file declares,
 * deliberately: the failure being guarded against is an EXTRA key, and a
 * walk of the declared fields is exactly the walk that cannot see one.
 */
export function mcpReportLeaks(report: unknown): string[] {
    const problems: string[] = [];
    const forbidden = new Set(mcpForbiddenKeys.map((k) => k.toLowerCase()));
    const allowed = new Set(mcpServerAllowedKeys);
    const seen = new Set<unknown>();

    const walk = (value: unknown, path: string): void => {
        if (value === null || typeof value !== 'object') return;
        // A cycle cannot reach the wire as JSON anyway, but a walker that can
        // hang is a walker nobody leaves switched on.
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            value.forEach((v, i) => walk(v, `${path}[${i}]`));
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            if (forbidden.has(key.toLowerCase())) {
                problems.push(`${path}.${key} is a key that can carry a credential`);
            }
            walk(child, `${path}.${key}`);
        }
    };

    walk(report, 'report');

    const harnesses = (report as McpReport | null)?.harnesses;
    if (Array.isArray(harnesses)) {
        for (const h of harnesses) {
            for (const s of h?.scopes ?? []) {
                for (const srv of s?.servers ?? []) {
                    for (const key of Object.keys(srv ?? {})) {
                        if (!allowed.has(key)) {
                            problems.push(
                                `${h?.harness}/${s?.id}/${(srv as McpServerSummary)?.name}.${key} is not one of ${mcpServerAllowedKeys.join(', ')}`,
                            );
                        }
                    }
                }
            }
        }
    }
    return problems;
}

/**
 * The one sentence the section header needs when a per-account harness is
 * healthy, or the alarm when it is not.
 *
 * Here rather than in the app because the terminal renders the same judgement
 * (`drover mcps` prints "every account matches the default"), and two places
 * deciding what counts as healthy is how the CLI and the phone start
 * disagreeing about whether there is a problem.
 */
export function mcpDivergenceSummary(harness: McpHarnessReport): string | null {
    if (!harness.perAccount || harness.scopes.length < 2) return null;
    const broken = harness.scopes.filter((s) => s.error || s.missing);
    const diverged = harness.scopes.filter((s) => s.divergence);
    if (!broken.length && !diverged.length) {
        return `Same on all ${harness.scopes.length} accounts`;
    }
    const parts: string[] = [];
    for (const s of diverged) {
        const d = s.divergence!;
        if (d.missing.length) parts.push(`${s.label} is missing ${d.missing.length}`);
        else parts.push(`${s.label} has ${d.extra.length} of its own`);
    }
    for (const s of broken) parts.push(`${s.label} could not be read`);
    return parts.join(' · ');
}
