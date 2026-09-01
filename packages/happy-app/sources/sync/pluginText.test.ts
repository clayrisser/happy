/**
 * The sentences the plugin view puts on screen (DROVE-310).
 *
 * Pure functions, so these are the cheap tests — and the ones worth having,
 * because the acceptance criteria are about WORDING: a disable that does not
 * say how many sessions still have the plugin is a disable that implies the
 * change is live everywhere, and a credential line that reads like a field is
 * an invitation to type a token into a phone.
 */

import { describe, expect, it } from 'vitest';
import type { PluginReport, PluginSummary } from '@slopus/happy-wire';

const plugin = (over: Partial<PluginSummary> = {}): PluginSummary => ({
    name: '@drover/huly',
    id: { scope: '@drover', name: 'huly', full: '@drover/huly' },
    version: '1.2.0',
    manifestVersion: 1,
    summary: 'Huly ticketing',
    schema: 'drover.plugin/v1',
    origin: 'catalog',
    dir: '~/Projects/bitspur/cattle-drover/plugins/huly',
    state: 'enabled',
    scope: { kind: 'global' },
    when: null,
    enableDefault: true,
    builds: false,
    provides: {
        mcp: [{ name: 'huly', when: null }],
        skills: ['skills/huly-ticket'],
        commands: [],
        subagents: [],
        rules: [],
        bin: [],
        hooks: [{ event: 'preToolUse', matcher: 'mcp__huly__.*', when: null }],
    },
    requires: { commands: [], platform: [], plugins: [] },
    vendor: [],
    capabilities: { network: null, paths: [], credentialNames: [], harnesses: [], sudo: false },
    warnings: [],
    vars: [],
    from: null,
    installedAt: null,
    sha256: null,
    error: null,
    ...over,
});

const report = (over: Partial<PluginReport> = {}): PluginReport => ({
    machine: 'studio.234.bitspur.com',
    readAt: 1_700_000_000_000,
    harnesses: ['claude', 'cursor', 'codex', 'opencode', 'pi'],
    config: '~/.config/drover/drover.yaml',
    catalog: '~/Projects/bitspur/cattle-drover/plugins',
    store: '~/.drover/plugins',
    plugins: [plugin()],
    errors: [],
    ...over,
});

const readAt = 1_700_000_000_000;

// Imported after the fixtures so a failure reads top-down.
import {
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

describe('pluginProvidesLine', () => {
    it('counts what the plugin adds, in the order the manifest lists it', () => {
        expect(pluginProvidesLine(plugin())).toBe('1 MCP · 1 skill · 1 hook');
    });

    it('pluralises each count on its own', () => {
        const p = plugin({
            provides: {
                mcp: [{ name: 'a', when: null }, { name: 'b', when: null }],
                skills: ['one'],
                commands: [],
                subagents: [],
                rules: [],
                bin: ['drover-huly', 'huly-sync'],
                hooks: [],
            },
        });
        expect(pluginProvidesLine(p)).toBe('2 MCPs · 1 skill · 2 binaries');
    });

    it('says a plugin provides nothing rather than drawing an empty line', () => {
        const p = plugin({
            provides: { mcp: [], skills: [], commands: [], subagents: [], rules: [], bin: [], hooks: [] },
        });
        expect(pluginProvidesLine(p)).toBe('Provides nothing yet');
    });
});

describe('pluginStaleLine (DROVE-220)', () => {
    it('names the sessions a disable does NOT reach', () => {
        expect(pluginStaleLine(3)).toBe('3 running sessions still have the old set until they restart.');
    });

    it('agrees with itself in the singular', () => {
        expect(pluginStaleLine(1)).toBe('1 running session still has the old set until it restarts.');
    });

    it('says nothing at zero — a sentence about no sessions is noise', () => {
        expect(pluginStaleLine(0)).toBeNull();
        expect(pluginStaleLine(undefined)).toBeNull();
        expect(pluginStaleLine(null)).toBeNull();
    });
});

describe('pluginScopeLine', () => {
    it('says every harness rather than listing five names', () => {
        expect(pluginScopeLine({ kind: 'global' })).toBe('Every harness');
    });

    it('names the harnesses when narrowed', () => {
        expect(pluginScopeLine({ kind: 'harness', harnesses: ['claude', 'codex'] })).toBe('claude, codex');
    });

    it('does not read an empty harness set as global', () => {
        expect(pluginScopeLine({ kind: 'harness', harnesses: [] })).toBe('No harness');
    });
});

describe('the credential and config lines NAME, never value (DROVE-304)', () => {
    it('names the credentials and says where the value lives', () => {
        const p = plugin({
            capabilities: { network: null, paths: [], credentialNames: ['HULY_API_KEY'], harnesses: [], sudo: false },
        });
        const line = pluginCredentialsLine(p)!;
        expect(line).toContain('HULY_API_KEY');
        expect(line).toContain('set on the computer');
        expect(line).toContain('never here');
    });

    it('says nothing when a plugin needs no credential', () => {
        expect(pluginCredentialsLine(plugin())).toBeNull();
    });

    it('names the config KEYS and says the values stay put', () => {
        const line = pluginVarsLine(plugin({ vars: ['HULY_URL', 'NOTES_DIR'] }))!;
        expect(line).toContain('HULY_URL');
        expect(line).toContain('NOTES_DIR');
        expect(line).toContain('names only');
    });
});

describe('pluginTouchesLine (DROVE-311 capabilities)', () => {
    it('tells a manifest that declares nothing from one that declares none', () => {
        expect(pluginTouchesLine(plugin({ capabilities: null }))).toBe('Declares nothing about what it touches');
        expect(pluginTouchesLine(plugin())).toBe('Touches nothing outside itself');
    });

    it('names the hosts a plugin declared', () => {
        const p = plugin({
            capabilities: { network: ['projects.corp.bitspur.com'], paths: [], credentialNames: [], harnesses: [], sudo: false },
        });
        expect(pluginTouchesLine(p)).toBe('Touches projects.corp.bitspur.com');
    });

    it('calls a blanket network grant what it is', () => {
        const p = plugin({
            capabilities: { network: true, paths: ['~/Documents'], credentialNames: [], harnesses: [], sudo: true },
        });
        expect(pluginTouchesLine(p)).toBe('Touches any network host · 1 path · sudo');
    });
});

describe('pluginOriginLine', () => {
    it('names the host and ref of a git install, and never a token', () => {
        const p = plugin({
            origin: 'store',
            from: { kind: 'git', locator: 'github.com/acme/notes.git', ref: 'v1.2.0', sha256: null, commit: 'abc123' },
        });
        expect(pluginOriginLine(p)).toBe('From github.com/acme/notes.git at v1.2.0');
    });

    it('says a pinned bundle is pinned', () => {
        const p = plugin({
            origin: 'store',
            from: { kind: 'tarball', locator: 'example.com/n.tgz', ref: null, sha256: 'deadbeef', commit: null },
        });
        expect(pluginOriginLine(p)).toBe('From example.com/n.tgz (pinned)');
    });

    it('names the catalog for the ordinary case, with no url at all', () => {
        expect(pluginOriginLine(plugin())).toBe('From the drover catalog');
    });
});

describe('pluginWhenLine', () => {
    it("keeps the author's scoping distinct from the user's", () => {
        expect(pluginWhenLine(plugin({ when: ['claude', 'codex'] })))
            .toBe('The plugin declares itself for claude, codex');
    });

    it('says nothing when the author scoped nothing', () => {
        expect(pluginWhenLine(plugin())).toBeNull();
    });
});

describe('pluginCountsLine', () => {
    it('counts installed and enabled separately — nine and none is a machine to look at', () => {
        const r = report({ plugins: [plugin(), plugin({ name: '@drover/pdf', state: 'disabled' })] });
        expect(pluginCountsLine(r, readAt + 1_000)).toBe('2 plugins, 1 enabled · read just now');
    });

    it('says a machine has none without inventing a count', () => {
        expect(pluginCountsLine(report({ plugins: [] }), readAt + 1_000))
            .toBe('No plugins on this machine · read just now');
    });
});

describe('pluginEmptyReason', () => {
    it('never reads an unreadable drover.yaml as an empty machine', () => {
        const r = report({ plugins: [], error: 'line 4: bad indent' });
        const reason = pluginEmptyReason(r)!;
        expect(reason).toContain('could not be read');
        expect(reason).toContain('line 4: bad indent');
        expect(reason).not.toContain('names no plugins');
    });

    it('says an unreadable config even when some plugins were listed', () => {
        expect(pluginEmptyReason(report({ error: 'bad yaml' }))).toContain('could not be read');
    });

    it('tells no config file from a config that names none', () => {
        expect(pluginEmptyReason(report({ plugins: [], config: null }))).toContain('No drover.yaml on this machine yet');
        expect(pluginEmptyReason(report({ plugins: [] }))).toContain('names no plugins');
    });

    it('says nothing when there is a list to draw', () => {
        expect(pluginEmptyReason(report())).toBeNull();
    });
});

describe('pluginReadAgo', () => {
    it('is relative, because the absolute time means nothing here', () => {
        expect(pluginReadAgo(readAt, readAt + 5_000)).toBe('Read just now');
        expect(pluginReadAgo(readAt, readAt + 120_000)).toBe('Read 2 minutes ago');
        expect(pluginReadAgo(readAt, readAt + 3_600_000)).toBe('Read 1 hour ago');
        expect(pluginReadAgo(readAt, readAt + 86_400_000 * 3)).toBe('Read 3 days ago');
    });

    it('never reads a clock skew as the future', () => {
        expect(pluginReadAgo(readAt, readAt - 60_000)).toBe('Read just now');
    });
});

describe('what an op says back', () => {
    it('asks in the verb it will perform', () => {
        expect(pluginOpTitle('uninstall', '@drover/huly')).toBe('Uninstall @drover/huly?');
    });

    it('carries the stale count into the confirmation, as one fact', () => {
        expect(pluginOpDone('disable', '@drover/huly', 3))
            .toBe('@drover/huly disabled. 3 running sessions still have the old set until they restart.');
    });

    it('says the plain thing when nothing is stale', () => {
        expect(pluginOpDone('enable', '@drover/huly', 0)).toBe('@drover/huly enabled.');
    });
});

describe('pluginLinksLine (DROVE-312)', () => {
    it('calls out the names something else already owns', () => {
        const line = pluginLinksLine({
            linked: ['huly-cli'],
            removed: [],
            skipped: [{ name: 'jq' }],
            kept: [{ name: 'node' }],
        })!;
        expect(line).toContain('1 on PATH');
        expect(line).toContain('2 left alone');
    });

    it('says nothing when the render touched no link', () => {
        expect(pluginLinksLine({ linked: [], removed: [], skipped: [], kept: [] })).toBeNull();
        expect(pluginLinksLine(null)).toBeNull();
        expect(pluginLinksLine(undefined)).toBeNull();
    });
});
