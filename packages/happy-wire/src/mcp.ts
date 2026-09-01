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

import { credentialKeys } from './redact';

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

/**
 * One model a provider offers (DROVE-296).
 *
 * Two fields, and the count is not an accident either. A model's full record
 * in OpenCode's catalog carries `api.url`, `headers` and `options` — a base
 * URL and whatever was pasted next to it — and none of that is needed to
 * answer "which model" or to make a pick the harness will accept.
 */
export interface ProviderModelSummary {
    /** The id the harness itself named, e.g. `gemini-3.1-pro-preview`. */
    id: string;
    /** Display name. Equal to `id` when nothing gave it another one. */
    name: string;
}

/**
 * One configured model provider.
 *
 * Clay: "I typically use opencode for custom 3rd party model providers." A
 * provider is a NAME and a list of MODEL IDS here — never its base URL, never
 * its key, and never the environment variable the key is read from.
 */
export interface ProviderSummary {
    /** `google`, `lmstudio`, `gitlab`, or whatever a custom one was called. */
    id: string;
    name: string;
    /**
     * Where the machine learnt about it, and it changes what a pick will do:
     *
     *   `listed`    the harness named it; it will run
     *   `declared`  the config declares it and the harness did NOT name it,
     *               which usually means the credential never arrived — a pick
     *               here fails at exec, so the app shows it differently
     *   `both`      declared and named
     *
     * Open, so a fourth origin needs no wire change.
     */
    origin: string;
    models: ProviderModelSummary[];
    modelCount: number;
}

/**
 * One harness's provider list, or the reason there is none.
 *
 * NULL on a harness that has no provider list at all — Claude Code, Cursor and
 * Codex each reach one vendor through one login. Null and empty are different
 * answers: null is "there is nothing of this kind here", empty is "you have
 * configured none", and collapsing them sends somebody looking for a setting
 * that does not exist.
 */
export interface ProviderReport {
    /** How the machine asked, in the words a person would type: `opencode models`. */
    asked: string;
    /** The config file the declared half came from, `$HOME` collapsed to `~`. */
    config: string | null;
    /** That config file is not there. */
    configMissing: boolean;
    /** That config file is there and could not be read. */
    configError: string | null;
    /** The harness binary is not on this machine. */
    missing: boolean;
    /** The harness is here and would not answer. Never its stderr — see below. */
    error: string | null;
    providers: ProviderSummary[];
    count: number;
    /** Models across every provider. Saves the app summing to draw a header. */
    modelCount: number;
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
    /**
     * The model providers this harness is configured with (DROVE-296), or null
     * when the harness has no provider list. Optional on the type as well as
     * nullable, because a drover from before this landed sends no such key and
     * a missing section must read as "that machine is older", not as an error.
     */
    providers?: ProviderReport | null;
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
 * Every key that may appear on a provider summary (DROVE-296), and on one of
 * its models.
 *
 * The same allowlist argument as the servers above, and the risk is if
 * anything higher. OpenCode's own provider record holds `options.apiKey` and
 * `options.baseURL`; a producer that spread a ProviderConfig into the summary
 * would carry both, and `baseURL` is not a name the forbidden list below would
 * catch on its own.
 */
export const providerAllowedKeys: readonly string[] = Object.freeze(['id', 'name', 'origin', 'models', 'modelCount']);
export const providerModelAllowedKeys: readonly string[] = Object.freeze(['id', 'name']);

/**
 * Names that must never appear as a key anywhere in a report, at any depth.
 *
 * The allowlist above already covers the server objects, so this is the second
 * net: it catches a producer that hangs a credential off a SCOPE or a harness
 * rather than off a server, which the per-server check would sail past.
 *
 * The credential half is COMPOSED from `redact.ts` rather than repeated here
 * (DROVE-304), because the log redactor masks values by the same names and two
 * copies of that list is how one of them goes stale. A name added there is
 * banned from a report here without anybody remembering to add it twice.
 */
export const mcpForbiddenKeys: readonly string[] = Object.freeze([
    ...credentialKeys,
    // Structural, and report-only. These are not secrets in themselves, they
    // are the SHAPES a credential arrives in -- a token in a query string, a
    // key pasted onto a command line. A report has no business carrying any of
    // them. A LOG line legitimately says which url it called, which is why
    // these are not on the masking list in redact.ts: a redactor that masked
    // every url leaves a daemon log nobody can debug with, and a redactor
    // nobody can debug with gets switched off.
    'args', 'command', 'url', 'baseurl', 'base_url', 'endpoint', 'api', 'key',
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
    const providerKeys = new Set(providerAllowedKeys);
    const providerModelKeys = new Set(providerModelAllowedKeys);
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
            // The provider half (DROVE-296), checked the same way and for the
            // same reason: the failure being guarded against is an EXTRA key,
            // and only an allowlist can see one.
            for (const provider of h?.providers?.providers ?? []) {
                for (const key of Object.keys(provider ?? {})) {
                    if (!providerKeys.has(key)) {
                        problems.push(
                            `${h?.harness}/providers/${(provider as ProviderSummary)?.id}.${key} is not one of ${providerAllowedKeys.join(', ')}`,
                        );
                    }
                }
                for (const model of provider?.models ?? []) {
                    for (const key of Object.keys(model ?? {})) {
                        if (!providerModelKeys.has(key)) {
                            problems.push(
                                `${h?.harness}/providers/${(provider as ProviderSummary)?.id}/${(model as ProviderModelSummary)?.id}.${key} is not one of ${providerModelAllowedKeys.join(', ')}`,
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
