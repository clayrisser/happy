/**
 * What a machine may say about its plugins, and what the phone may ask it to do
 * to them (DROVE-310).
 *
 * Clay: "managing the extensions (let's actually call them plugins) should
 * actually support being managed from the mobile app ... enable disable install
 * globally install for a specific harness etc.. all from the mobile app". So
 * unlike the MCP viewer (DROVE-274), which only SEES, this carries WRITES: the
 * phone enables, disables, installs, uninstalls, and scopes a plugin globally or
 * to one harness.
 *
 * A PLUGIN is shotgun content and only that: an MCP + skills + hooks bundle
 * (huly, pdf, matrix). A harness (claude/cursor/codex/opencode/pi) and an OS
 * installer (tmux, node, gum) are NOT plugins — the drover's catalog walk skips
 * them by kind, so the phone never shows one. The `harnesses` array on a report
 * is the set a plugin may be SCOPED to, never a list of plugins.
 *
 * Three processes touch this shape and none share a runtime: cattle-drover's
 * `engine/plugin/ops.js` builds it in plain JS, happy-cli's daemon relays it,
 * the app draws it. The shape lives on the wire so the two TypeScript ends
 * cannot drift, and the drover's tests/plugins.bats pins the third against it.
 *
 * WHAT MAY BE IN HERE, and it is the whole design constraint. A plugin manifest
 * is somebody else's file and an install source is where a token hides — a
 * `?token=` in a git url, an `env:` block under an MCP, a config value a user
 * pasted into drover.yaml. None of that is on this type: an MCP is a NAME and
 * its harness scope, `vars` is KEY NAMES only, a source is host+path only, and
 * `pluginReportLeaks` below makes the ban CHECKABLE at runtime — a type cannot
 * stop a plain-JS producer in another repo from hanging an extra key on an
 * object it hands over.
 *
 * IDENTITY (DROVE-311): a plugin's `name` is namespaced (`@drover/huly` or
 * reverse-DNS). The full name is what every route and every drover.yaml entry
 * is keyed by; `id.name` is the short name, which is its directory.
 */

import { credentialKeys } from './redact';

/** The three states, as drover.yaml has them: no entry, `enabled: false`, `enabled: true`. */
export type PluginState = 'not-installed' | 'disabled' | 'enabled';

/**
 * The user's per-harness scoping of the whole plugin. `global` is every
 * harness; `harness` is only the named ones. The AUTHOR separately scopes the
 * plugin (`when`) and its components (`provides.mcp[].when`, `hooks[].when`) —
 * different granularity, they compose by intersection.
 */
export type PluginScope = { kind: 'global' } | { kind: 'harness'; harnesses: string[] };

/** Where the plugin's files are: the in-repo catalog, or the third-party store. */
export type PluginOrigin = 'catalog' | 'store';

/** DROVE-311's identity: `@scope/name` split, and the full name. */
export interface PluginIdentity {
    scope: string | null;
    /** The SHORT name — also the directory under the catalog or the store. */
    name: string | null;
    full: string | null;
}

/** One MCP server the plugin ships: its NAME and the harnesses the author limited it to. Never its command, args, env or url. */
export interface PluginMcpSummary {
    name: string;
    when: string[] | null;
}

/** One hook: what it fires on, its matcher, and the author's harness scope. Never its script or args. */
export interface PluginHookSummary {
    event: string | null;
    matcher: string | null;
    when: string[] | null;
}

/** What a plugin provides — the shotgun content that makes it a plugin. Paths are as declared, relative to the plugin. */
export interface PluginProvides {
    mcp: PluginMcpSummary[];
    skills: string[];
    commands: string[];
    subagents: string[];
    rules: string[];
    bin: string[];
    hooks: PluginHookSummary[];
}

/** What the plugin needs present to render at all. */
export interface PluginRequires {
    commands: string[];
    platform: string[];
    plugins: string[];
}

/** An external source the plugin vendors — sanitized to host+path and a pinned ref. */
export interface PluginVendorSummary {
    name: string;
    kind: 'git' | 'packed' | 'unknown';
    locator: string | null;
    ref: string | null;
}

/**
 * What the plugin DECLARES it touches outside its own directory (DROVE-311's
 * `capabilities`). `credentialNames` is the declared NEED, by name: a plugin
 * that carries a value is refused by the drover before it is ever listed.
 */
export interface PluginCapabilities {
    network: boolean | string[] | null;
    paths: string[];
    credentialNames: string[];
    harnesses: string[];
    sudo: boolean;
}

/**
 * Where a plugin came from — sanitized. The raw url NEVER survives to this
 * type: userinfo, query and fragment, the three places a token hides, are
 * dropped and only host+path remain as `locator`. `sha256` and `commit` are
 * public pins, not secrets.
 */
export interface PluginFrom {
    kind: 'catalog' | 'path' | 'git' | 'tarball' | null;
    locator: string | null;
    ref: string | null;
    sha256: string | null;
    commit: string | null;
}

/** One plugin as the machine reports it: manifest summary + the user's state. */
export interface PluginSummary {
    /** The FULL namespaced name, e.g. `@drover/huly`. */
    name: string;
    id: PluginIdentity | null;
    version: string | null;
    manifestVersion: number | null;
    summary: string | null;
    schema: string | null;
    origin: PluginOrigin | null;
    /** The plugin's directory, `$HOME` collapsed to `~`. */
    dir: string | null;
    state: PluginState;
    /** The user's scoping of the plugin (drover.yaml `harnesses`). */
    scope: PluginScope;
    /** The author's scoping of the whole plugin (manifest `when`). */
    when: string[] | null;
    enableDefault: boolean;
    /** Installing this plugin runs its own build (a Makefile or setup script). */
    builds: boolean;
    provides: PluginProvides;
    requires: PluginRequires;
    vendor: PluginVendorSummary[];
    /** `null` when the manifest does not declare a surface at all (a spike manifest); `{}` declares none. */
    capabilities: PluginCapabilities | null;
    /** The validator's warnings (a wildcard host grant, say). Sentences, never values. */
    warnings: string[];
    /**
     * Which config KEYS are set in drover.yaml — names only, NEVER values. A
     * user may have pasted a token into a var; DROVE-304's rule is to remove
     * it, not echo it, so only the key name reaches the phone.
     */
    vars: string[];
    /** Set when the plugin was installed from a source rather than the catalog. */
    from: PluginFrom | null;
    installedAt: string | null;
    sha256: string | null;
    /** A plugin drover.yaml names that the catalog lacks, or whose directory is unreadable, says why here. */
    error: string | null;
}

/** A manifest in the catalog that would not validate: by directory, with the reason (a KIND, never a value). */
export interface PluginCatalogError {
    name: string;
    dir: string;
    error: string;
}

/**
 * Everything one machine reports about its plugins. The managed report lists
 * what drover.yaml and the store hold; the catalog report lists what the
 * catalog offers, each with its state on this machine. Same shape.
 */
export interface PluginReport {
    machine: string;
    /** When the machine read drover.yaml and the catalog, epoch ms. */
    readAt: number;
    /** The harnesses a plugin may be scoped to — NOT a list of plugins. */
    harnesses: string[];
    /** The drover.yaml path, `~`-collapsed, or null when none exists yet. */
    config: string | null;
    catalog: string | null;
    store: string | null;
    plugins: PluginSummary[];
    errors: PluginCatalogError[];
    /** drover.yaml could not be read. An empty list would read as "nothing installed". */
    error?: string;
}

export type PluginCatalogReport = PluginReport;

export type PluginReportResult = { ok: true; report: PluginReport } | { ok: false; error: string };
export type PluginCatalogResult = PluginReportResult;

/** Where to install from. A url carrying a credential is REFUSED by the machine, not sanitized. */
export type PluginInstallSource =
    | { kind: 'catalog'; name: string }
    | { kind: 'path'; path: string }
    | { kind: 'git'; url: string; ref?: string | null }
    | { kind: 'tarball'; url: string; sha256: string };

/** DROVE-312's link report: what of the plugin's bin/ landed on PATH, and what did not, and why. */
export interface PluginLinksReport {
    linked: string[];
    unchanged: string[];
    skipped: { name: string | null; reason: string | null; detail: string | null }[];
    removed: string[];
    kept: { name: string | null; reason: string | null; path: string | null; detail: string | null }[];
    absent: string[];
}

/** The result of one mutation, or an inspect. */
export interface PluginOpOutcome {
    ok: boolean;
    /** `install` | `enable` | `disable` | `uninstall` | `inspect`. */
    op?: string;
    /** The plugin as it now stands (for inspect: as it would be, state `not-installed`). */
    plugin?: PluginSummary | null;
    /**
     * Running sessions still holding the pre-change config (DROVE-220). A
     * disable rewrites config on disk, but a live session keeps the plugin set
     * it started with until it restarts, and the phone must say so.
     */
    staleSessions?: number;
    /** What the mirror render produced, as counts. */
    render?: { plugins: number; mcp: number; hooks: number; skills: number };
    links?: PluginLinksReport | null;
    /** For inspect: the sanitized source it was read from. */
    source?: PluginFrom | null;
    error?: string;
    /** Set on a 403: the bus invariant that refused (`plugin-hook-may-raise-never-resolve`). */
    invariant?: string;
}

export type PluginOpResult = { ok: true; outcome: PluginOpOutcome } | { ok: false; error: string };

/** What the phone asks the machine to do. `drover-plugin-op`'s params. */
export interface PluginOpParams {
    op: 'install' | 'enable' | 'disable' | 'uninstall' | 'inspect';
    /** The plugin's FULL name, for enable/disable/uninstall. */
    name?: string;
    /** The source, for install/inspect. */
    source?: PluginInstallSource;
    /** The scope, for install/enable. */
    scope?: PluginScope;
    /** Install disabled rather than enabled. */
    enabled?: boolean;
}

// --- the leak check ----------------------------------------------------------

/**
 * Every key that may appear on the objects most at risk of a spread — a
 * source, a vendor entry, an MCP entry, a hook. The allowlist is the check: a
 * denylist is one unfamiliar key name away from being wrong, and a producer
 * that spread a raw manifest entry would carry its `url` or `command` under a
 * name no denylist thought to ban.
 */
export const pluginFromAllowedKeys: readonly string[] = Object.freeze(['kind', 'locator', 'ref', 'sha256', 'commit']);
export const pluginVendorAllowedKeys: readonly string[] = Object.freeze(['name', 'kind', 'locator', 'ref']);
export const pluginMcpAllowedKeys: readonly string[] = Object.freeze(['name', 'when']);
export const pluginHookAllowedKeys: readonly string[] = Object.freeze(['event', 'matcher', 'when']);

/**
 * Names that must never appear as a key anywhere in a plugin report, at any
 * depth. Composed from `redact.ts` (DROVE-304) so the log redactor and this
 * report ban cannot drift — a name added there is banned here without anybody
 * remembering to add it twice — plus the report-only structural shapes a
 * credential arrives in.
 *
 * `env` and `credentials` are on the credential list and so are banned as
 * KEYS; the drover names a declared need `credentialNames` and a config key
 * list `vars` for exactly that reason.
 */
export const pluginForbiddenKeys: readonly string[] = Object.freeze([
    ...credentialKeys,
    'args',
    'command',
    'url',
    'baseurl',
    'base_url',
    'endpoint',
    'api',
    'key',
]);

/**
 * Everything wrong with a report, as sentences. Empty means it is safe to send.
 *
 * A runtime check and not just a type, because the producer is a plain-JS
 * module in another repository TypeScript never sees. The app calls this on
 * what arrives and the CLI calls it on what it is about to relay, so a leak is
 * caught on the machine — before it is encrypted and posted — not on the phone.
 * It walks the whole object rather than the declared fields, because the
 * failure guarded against is an EXTRA key and a walk of declared fields is
 * exactly the walk that cannot see one. Then it checks the SHAPE of the places
 * a value would arrive: `vars` must be a list of names (a map would be the
 * values), and a source, vendor, MCP or hook entry may carry only its allowed
 * keys.
 *
 * Accepts a managed report, a catalog report, or `{ plugins: [outcome.plugin] }`
 * built by the caller from an op outcome.
 */
export function pluginReportLeaks(report: unknown): string[] {
    const problems: string[] = [];
    const forbidden = new Set(pluginForbiddenKeys.map((k) => k.toLowerCase()));
    const seen = new Set<unknown>();

    const walk = (value: unknown, path: string): void => {
        if (value === null || typeof value !== 'object') return;
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

    const onlyKeys = (obj: unknown, allowed: readonly string[], label: string): void => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        const ok = new Set(allowed);
        for (const key of Object.keys(obj)) {
            if (!ok.has(key)) problems.push(`${label}.${key} is not one of ${allowed.join(', ')}`);
        }
    };

    const plugins = (report as PluginReport | null)?.plugins;
    if (Array.isArray(plugins)) {
        for (const p of plugins) {
            if (!p || typeof p !== 'object') continue;
            const s = p as PluginSummary;
            const label = s.name ?? '?';
            if (s.vars !== undefined && !(Array.isArray(s.vars) && s.vars.every((v) => typeof v === 'string'))) {
                problems.push(`${label}.vars is not a list of names — a map here would be the values`);
            }
            if (s.from) onlyKeys(s.from, pluginFromAllowedKeys, `${label}.from`);
            for (const v of Array.isArray(s.vendor) ? s.vendor : []) onlyKeys(v, pluginVendorAllowedKeys, `${label}.vendor`);
            for (const m of Array.isArray(s.provides?.mcp) ? s.provides.mcp : []) onlyKeys(m, pluginMcpAllowedKeys, `${label}.provides.mcp`);
            for (const h of Array.isArray(s.provides?.hooks) ? s.provides.hooks : []) onlyKeys(h, pluginHookAllowedKeys, `${label}.provides.hooks`);
        }
    }
    return problems;
}

/** One line for a plugin row: its state, and its scope when narrowed. */
export function pluginStateLine(p: Pick<PluginSummary, 'state' | 'scope'>): string {
    const state = p.state === 'not-installed' ? 'Not installed' : p.state === 'disabled' ? 'Disabled' : 'Enabled';
    if (p.scope.kind === 'harness' && p.state !== 'not-installed') return `${state} · ${p.scope.harnesses.join(', ')}`;
    return state;
}
