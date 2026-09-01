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
 * installer (tmux, node, gum) are NOT plugins — the drover filters them out of
 * the catalog by structure, so the phone never shows one. The `harnesses` array
 * on a report is the set a plugin may be SCOPED to, never a list of plugins.
 *
 * Three processes touch this shape and none share a runtime: cattle-drover's
 * `engine/plugins.js` builds it in plain JS, happy-cli's daemon relays it, the
 * app draws it. The shape lives on the wire so the two TypeScript ends cannot
 * drift, and the drover's tests/plugins.bats pins the third against it.
 *
 * WHAT MAY BE IN HERE, and it is the whole design constraint. A plugin manifest
 * is somebody else's file and an install source is where a token hides — a
 * `?token=` in a git url, an `env:` block, a config value a user pasted into
 * drover.yaml. None of that is on this type, `config` is KEY NAMES only, a
 * source is host+path only, and `pluginReportLeaks` below makes the ban
 * CHECKABLE at runtime — a type cannot stop a plain-JS producer in another repo
 * from hanging an extra key on an object it hands over.
 */

import { credentialKeys } from './redact';

/**
 * The user's per-harness scoping of the whole plugin. `global` is every
 * harness; `harness` is only the named ones. The AUTHOR separately scopes
 * COMPONENTS with the manifest's `when:` — different granularity, they compose.
 */
export type PluginScope = { kind: 'global' } | { kind: 'harness'; harnesses: string[] };

/**
 * Where a plugin came from, or is being installed from — sanitized. The raw
 * url NEVER survives to this type: userinfo, query and fragment, the three
 * places a token hides, are dropped and only host+path remain as `locator`.
 * `sha256` is a public integrity pin, not a secret.
 */
export type PluginSource =
    | { kind: 'catalog'; name: string; catalog: string; pick: string | null }
    | { kind: 'git'; locator: string; ref: string | null; pick: string | null }
    | { kind: 'tarball'; locator: string; sha256: string; pick: string | null }
    | { kind: 'package'; manager: string; name: string; pick: string | null }
    | { kind: 'path'; locator: string; pick: string | null };

/** One component the author scoped, in the manifest's `when:`. */
export interface PluginWhen {
    /** Which component: `mcp:huly`, `skills/mac-only`, … */
    component: string;
    /** The OSes it is limited to, or null for all. */
    os: string[] | null;
    /** The harnesses it is limited to, or null for all. */
    harness: string[] | null;
}

/** A credential the plugin needs, NAMED. The value is never in a manifest and never here. */
export interface PluginRequirement {
    /** `env` (an environment variable) or `login` (a harness/CLI login). */
    kind: string;
    /** The variable or command name, e.g. `HULY_TOKEN`. */
    name: string;
    /** What to tell the user, shown as-is. Never a value. */
    note: string | null;
}

/** What a plugin provides — the shotgun content that makes it a plugin. */
export interface PluginProvides {
    mcp: string[];
    skills: string[];
    hooks: { script: string | null; event: string | null }[];
    bin: string[];
    libexec: string[];
}

/** One manifest source the plugin declares (not the install source). */
export interface PluginManifestSource {
    kind: string;
    locator: string | null;
    ref: string | null;
    sha256: string | null;
    /** How many patches the source declares — a count, never the patches. */
    patches: number;
}

/** One plugin as the machine reports it: manifest summary + the user's state. */
export interface PluginSummary {
    name: string;
    version: string | null;
    manifestVersion: number | null;
    summary: string | null;
    dependsOn: string[];
    provides: PluginProvides;
    when: PluginWhen[];
    sources: PluginManifestSource[];
    requires: PluginRequirement[];
    integrity: { sha256: string | null };
    /** Installing this plugin runs code (a manifest `install:` block or a Makefile). */
    installs: boolean;
    /** The three states collapse to two once installed: enabled or disabled. */
    state: 'enabled' | 'disabled';
    /** The user's scoping of the plugin. */
    scope: PluginScope;
    /** Set when the plugin came from a third-party source rather than the catalog. */
    from: PluginSource | null;
    /**
     * Which config KEYS are set in drover.yaml — names only, NEVER values. A
     * user may have pasted a token into a config value; DROVE-304's rule is to
     * remove it, not echo it, so only the key name reaches the phone.
     */
    config: string[];
    /** False when only the real engine has fetched the manifest (a remote, pending install). */
    manifestKnown: boolean;
    /**
     * Running sessions still holding the pre-change config (DROVE-220). A
     * disable rewrites config on disk, but a live session keeps the plugin set
     * it started with until it restarts, and the phone must say so.
     */
    staleSessions: number;
    /** A plugin whose manifest could not be read is reported by name with the reason. */
    error?: string;
}

/** Everything one machine reports about its managed plugins. */
export interface PluginReport {
    machine: string;
    /** When the machine read drover.yaml and the catalog, epoch ms. */
    readAt: number;
    /** The harnesses a plugin may be scoped to — NOT a list of plugins. */
    harnesses: string[];
    plugins: PluginSummary[];
    /** drover.yaml could not be read. An empty list would read as "nothing installed". */
    error?: string;
}

/** What the catalog offers to install, so the phone can pick one. */
export interface PluginCatalogReport {
    machine: string;
    readAt: number;
    /** The catalog location, `$HOME` collapsed to `~`. */
    catalog: string;
    plugins: (PluginSummary & { installed: boolean })[];
}

export type PluginReportResult = { ok: true; report: PluginReport } | { ok: false; error: string };

export type PluginCatalogResult = { ok: true; report: PluginCatalogReport } | { ok: false; error: string };

/** The result of one mutation, or an inspect. */
export interface PluginOpOutcome {
    ok: boolean;
    /** `install` | `enable` | `disable` | `uninstall` | `inspect`. */
    op?: string;
    /** The plugin's new state, or null (uninstall, a pending remote install). */
    plugin?: PluginSummary | null;
    staleSessions?: number;
    /** A remote source the real engine will fetch — recorded, not yet installed. */
    pending?: boolean;
    source?: PluginSource;
    scope?: PluginScope;
    /** For inspect: the manifest read from a source WITHOUT installing. */
    manifest?: PluginSummary | null;
    /** For inspect of a repo holding many plugins: the ones to pick from. */
    candidates?: string[] | null;
    /** `local` (read here) or `deferred` (the real engine fetches it). */
    fetched?: string;
    note?: string;
    error?: string;
}

export type PluginOpResult = { ok: true; outcome: PluginOpOutcome } | { ok: false; error: string };

/** What the phone asks the machine to do. `drover-plugin-op`'s params. */
export interface PluginOpParams {
    op: 'install' | 'enable' | 'disable' | 'uninstall' | 'inspect';
    /** The plugin's name, for enable/disable/uninstall. */
    name?: string;
    /** The source, for install/inspect. Raw url is sanitized by the machine. */
    source?: unknown;
    /** The scope, for install/enable. */
    scope?: PluginScope;
    /** Install disabled rather than enabled. */
    enabled?: boolean;
}

// --- the leak check ----------------------------------------------------------

/**
 * Every key that may appear on the objects most at risk of a spread — a
 * source, a requirement, a hook, a `when`. The allowlist is the check: a
 * denylist is one unfamiliar key name away from being wrong, and a producer
 * that spread a raw install source would carry its `url` under a name no
 * denylist thought to ban.
 */
export const pluginSourceAllowedKeys: readonly string[] = Object.freeze([
    'kind',
    'locator',
    'name',
    'catalog',
    'ref',
    'sha256',
    'pick',
    'patches',
]);
export const pluginRequireAllowedKeys: readonly string[] = Object.freeze(['kind', 'name', 'note']);

/**
 * Names that must never appear as a key anywhere in a plugin report, at any
 * depth. Composed from `redact.ts` (DROVE-304) so the log redactor and this
 * report ban cannot drift — a name added there is banned here without anybody
 * remembering to add it twice — plus the report-only structural shapes a
 * credential arrives in.
 *
 * `env` is on the credential list and so is banned as a KEY; it is still a
 * legitimate `requires.kind` VALUE (`"kind":"env"`), which this walk never
 * touches because it only reads keys.
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
 * exactly the walk that cannot see one.
 *
 * Accepts either a managed report or a catalog report — both carry a `plugins`
 * array of the same shape, and an inspect/op outcome's `plugin`/`manifest` is
 * checked by passing it in as `{ plugins: [outcome.plugin] }` from the caller.
 */
export function pluginReportLeaks(report: unknown): string[] {
    const problems: string[] = [];
    const forbidden = new Set(pluginForbiddenKeys.map((k) => k.toLowerCase()));
    const sourceKeys = new Set(pluginSourceAllowedKeys);
    const requireKeys = new Set(pluginRequireAllowedKeys);
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

    const plugins = (report as PluginReport | PluginCatalogReport | null)?.plugins;
    if (Array.isArray(plugins)) {
        for (const p of plugins) {
            const label = (p as PluginSummary)?.name ?? '?';
            for (const src of [...((p as PluginSummary)?.sources ?? []), (p as PluginSummary)?.from].filter(Boolean)) {
                for (const key of Object.keys(src as object)) {
                    if (!sourceKeys.has(key)) {
                        problems.push(`${label}.source.${key} is not one of ${pluginSourceAllowedKeys.join(', ')}`);
                    }
                }
            }
            for (const req of (p as PluginSummary)?.requires ?? []) {
                for (const key of Object.keys(req ?? {})) {
                    if (!requireKeys.has(key)) {
                        problems.push(`${label}.requires.${key} is not one of ${pluginRequireAllowedKeys.join(', ')}`);
                    }
                }
            }
        }
    }
    return problems;
}
