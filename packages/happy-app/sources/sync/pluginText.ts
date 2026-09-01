/**
 * The sentences the plugin view puts on screen (DROVE-310).
 *
 * Pure, and in its own file with no import but the wire types, for the reason
 * mcpText.ts is: they started next to the RPC client, which reaches apiSocket
 * and from there the whole expo runtime, so every test of a sentence became a
 * test that has to boot React Native. The transport and the wording have no
 * reason to share a module.
 *
 * NOTHING HERE MAY PRINT A VALUE. A plugin names the credentials it needs
 * (`capabilities.credentialNames`) and the config keys the user has set
 * (`vars`), and both are NAMES — the machine never sends the value and these
 * sentences must not imply one is on the phone. So the wording is always "set
 * on the computer", never a field the phone could fill.
 */

import type { PluginReport, PluginSummary } from '@slopus/happy-wire';

/** `Read 3 minutes ago`. Relative, because the absolute time means nothing here. */
export function pluginReadAgo(readAt: number, now: number = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - readAt) / 1000));
    if (seconds < 45) return 'Read just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `Read ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `Read ${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `Read ${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * What the plugin PUTS INTO a harness, as counts.
 *
 * Counts and not names for mcpText's reason — the question a collapsed row
 * answers is "what does this add", and three MCP names is not that answer. The
 * names are one tap down. A plugin that provides nothing says so rather than
 * drawing an empty line, because a manifest with an empty `provides:` is
 * usually a manifest somebody has not finished.
 */
export function pluginProvidesLine(p: Pick<PluginSummary, 'provides'>): string {
    const parts: string[] = [];
    const push = (n: number, one: string, many = `${one}s`) => {
        if (n) parts.push(`${n} ${n === 1 ? one : many}`);
    };
    push(p.provides.mcp.length, 'MCP', 'MCPs');
    push(p.provides.skills.length, 'skill');
    push(p.provides.commands.length, 'command');
    push(p.provides.subagents.length, 'subagent');
    push(p.provides.rules.length, 'rule');
    push(p.provides.hooks.length, 'hook');
    push(p.provides.bin.length, 'binary', 'binaries');
    return parts.length ? parts.join(' · ') : 'Provides nothing yet';
}

/**
 * The count a disable does NOT reach (DROVE-220).
 *
 * A session keeps the plugin set it started with until it restarts, so a
 * disable that says nothing implies the change is live everywhere and it is
 * not. Null at zero: a sentence about no sessions is noise on the common path.
 */
export function pluginStaleLine(staleSessions: number | undefined | null): string | null {
    if (!staleSessions) return null;
    const s = staleSessions === 1 ? 'session' : 'sessions';
    const have = staleSessions === 1 ? 'has' : 'have';
    return `${staleSessions} running ${s} still ${have} the old set until ${staleSessions === 1 ? 'it restarts' : 'they restart'}.`;
}

/**
 * Which harnesses the plugin is scoped to, said rather than shown as a list of
 * five names when the answer is "all of them".
 */
export function pluginScopeLine(scope: PluginSummary['scope']): string {
    if (scope.kind === 'global') return 'Every harness';
    if (!scope.harnesses.length) return 'No harness';
    return scope.harnesses.join(', ');
}

/**
 * The author's own `when:` — the harnesses the PLUGIN says it works on, which
 * is a different fact from the user's scoping above and is easily read as the
 * same one. Null when the author scoped nothing, which is the common case.
 */
export function pluginWhenLine(p: Pick<PluginSummary, 'when'>): string | null {
    if (!p.when || !p.when.length) return null;
    return `The plugin declares itself for ${p.when.join(', ')}`;
}

/**
 * The credentials the plugin NEEDS, by name, and where the value lives.
 *
 * The second half is the whole point of the sentence: the phone is naming a
 * requirement, not offering a field. A token typed on a phone is a token that
 * has already been somewhere it should not be, so this view never asks for
 * one and says so out loud.
 */
export function pluginCredentialsLine(p: Pick<PluginSummary, 'capabilities'>): string | null {
    const names = p.capabilities?.credentialNames ?? [];
    if (!names.length) return null;
    return `Needs ${names.join(', ')} — set on the computer, never here`;
}

/** Which config KEYS drover.yaml sets for this plugin. Names, never values. */
export function pluginVarsLine(p: Pick<PluginSummary, 'vars'>): string | null {
    if (!p.vars.length) return null;
    return `Configured: ${p.vars.join(', ')} (names only; the values stay on the computer)`;
}

/**
 * What the plugin says it TOUCHES (DROVE-311's capabilities), in one line.
 *
 * `null` capabilities and `{}` capabilities are different facts and are said
 * differently: a manifest that declares no surface at all has not been through
 * the validator's gate, and a manifest that declares an empty one has.
 */
export function pluginTouchesLine(p: Pick<PluginSummary, 'capabilities'>): string {
    const c = p.capabilities;
    if (!c) return 'Declares nothing about what it touches';
    const parts: string[] = [];
    if (c.network === true) parts.push('any network host');
    else if (Array.isArray(c.network) && c.network.length) parts.push(c.network.join(', '));
    if (c.paths.length) parts.push(`${c.paths.length} path${c.paths.length === 1 ? '' : 's'}`);
    if (c.sudo) parts.push('sudo');
    return parts.length ? `Touches ${parts.join(' · ')}` : 'Touches nothing outside itself';
}

/**
 * Where the plugin came FROM, host and path only.
 *
 * The machine already dropped userinfo, query and fragment — a `?token=` never
 * reaches here — so this only has to name what survived. A catalog plugin is
 * the ordinary case and says so without a url.
 */
export function pluginOriginLine(p: Pick<PluginSummary, 'origin' | 'from'>): string | null {
    const from = p.from;
    if (from?.kind === 'git') return `From ${from.locator ?? 'a git remote'}${from.ref ? ` at ${from.ref}` : ''}`;
    if (from?.kind === 'tarball') return `From ${from.locator ?? 'a bundle'}${from.sha256 ? ' (pinned)' : ''}`;
    if (from?.kind === 'path') return `From ${from.locator ?? 'a local path'}`;
    if (p.origin === 'catalog') return 'From the drover catalog';
    if (p.origin === 'store') return 'Installed into the plugin store';
    return null;
}

/**
 * The header under the machine's name: what it manages and when it looked.
 *
 * Enabled is counted separately from installed because they are the two
 * numbers a glance is for — a machine with nine plugins and none enabled is a
 * machine somebody should look at.
 */
export function pluginCountsLine(report: PluginReport, now?: number): string {
    const total = report.plugins.length;
    if (!total) return `No plugins on this machine · ${pluginReadAgo(report.readAt, now).toLowerCase()}`;
    const enabled = report.plugins.filter((p) => p.state === 'enabled').length;
    return `${total} plugin${total === 1 ? '' : 's'}, ${enabled} enabled · ${pluginReadAgo(report.readAt, now).toLowerCase()}`;
}

/**
 * Why the list is empty or short, in the machine's own terms.
 *
 * A drover.yaml that would not parse is NOT an empty machine and must never
 * read as one: an empty list there means "nothing installed", and the truth is
 * "I could not tell". The catalog errors are separate and named per directory,
 * because "this one is broken" is a different job from "you have none".
 */
export function pluginEmptyReason(report: PluginReport): string | null {
    if (report.error) return `${report.config ?? 'drover.yaml'} could not be read (${report.error}).`;
    if (report.plugins.length) return null;
    if (!report.config) return 'No drover.yaml on this machine yet. Installing one plugin writes it.';
    return `${report.config} names no plugins, and the store holds none.`;
}

/** A verb in the tense a confirmation uses: `Disable @drover/huly?`. */
export function pluginOpTitle(op: string, name: string): string {
    const verb = op.charAt(0).toUpperCase() + op.slice(1);
    return `${verb} ${name}?`;
}

/**
 * What a completed op says back.
 *
 * The stale count rides here rather than in a separate toast, because the two
 * halves are one fact: the file changed, and this many sessions have not
 * noticed yet.
 */
export function pluginOpDone(op: string, name: string, staleSessions?: number | null): string {
    const past: Record<string, string> = {
        enable: 'enabled',
        disable: 'disabled',
        install: 'installed',
        uninstall: 'uninstalled',
        inspect: 'read',
    };
    const stale = pluginStaleLine(staleSessions);
    return `${name} ${past[op] ?? op}.${stale ? ` ${stale}` : ''}`;
}

/**
 * What DROVE-312's link report did to PATH, as a sentence, or null when it did
 * nothing worth saying. A kept or skipped link is the interesting half: it
 * means a name on PATH is NOT this plugin's, which is exactly the surprise
 * somebody needs told.
 */
export function pluginLinksLine(links: PluginSummary extends never ? never : {
    linked: string[];
    removed: string[];
    skipped: { name: string | null }[];
    kept: { name: string | null }[];
} | null | undefined): string | null {
    if (!links) return null;
    const parts: string[] = [];
    if (links.linked.length) parts.push(`${links.linked.length} on PATH`);
    if (links.removed.length) parts.push(`${links.removed.length} removed`);
    const left = links.skipped.length + links.kept.length;
    if (left) parts.push(`${left} left alone (something else owns the name)`);
    return parts.length ? parts.join(' · ') : null;
}
