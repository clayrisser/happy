import { describe, expect, it } from 'vitest';
import {
    pluginForbiddenKeys,
    pluginFromAllowedKeys,
    pluginMcpAllowedKeys,
    pluginReportLeaks,
    pluginStateLine,
    type PluginReport,
    type PluginSummary,
} from './plugins';

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
    scope: { kind: 'harness', harnesses: ['claude', 'codex'] },
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
    requires: { commands: ['node'], platform: [], plugins: [] },
    vendor: [{ name: 'huly-mcp', kind: 'git', locator: 'git.example.com/huly-mcp.git', ref: 'v1.0.0' }],
    capabilities: { network: ['projects.example.com'], paths: [], credentialNames: ['HULY_API_KEY'], harnesses: [], sudo: false },
    warnings: [],
    vars: ['HULY_API_KEY', 'HULY_URL'],
    from: null,
    installedAt: null,
    sha256: null,
    error: null,
    ...over,
});

const clean = (): PluginReport => ({
    machine: 'studio.234.bitspur.com',
    readAt: 1_700_000_000_000,
    harnesses: ['claude', 'cursor', 'codex', 'opencode', 'pi'],
    config: '~/.config/drover/drover.yaml',
    catalog: '~/Projects/bitspur/cattle-drover/plugins',
    store: '~/.drover/plugins',
    plugins: [plugin()],
    errors: [],
});

describe('pluginReportLeaks', () => {
    it('passes a clean report', () => {
        expect(pluginReportLeaks(clean())).toEqual([]);
    });

    it('passes a declared credential NAME — a name is not a value', () => {
        const r = clean();
        r.plugins[0].capabilities = { network: null, paths: [], credentialNames: ['ANTHROPIC_API_KEY'], harnesses: [], sudo: false };
        expect(pluginReportLeaks(r)).toEqual([]);
    });

    it('passes a sanitized install origin', () => {
        const r = clean();
        r.plugins[0].from = { kind: 'git', locator: 'github.com/acme/notes.git', ref: 'v1', sha256: null, commit: 'abc' };
        expect(pluginReportLeaks(r)).toEqual([]);
    });

    it('catches a token hung off the install origin', () => {
        const r = clean();
        r.plugins[0].from = { kind: 'git', locator: 'h/r.git', ref: null, sha256: null, commit: null };
        (r.plugins[0].from as unknown as Record<string, unknown>).token = 'FIXTURESECRET';
        const leaks = pluginReportLeaks(r);
        expect(leaks.length).toBeGreaterThan(0);
        expect(leaks.join(' ')).not.toContain('FIXTURESECRET');
    });

    it('catches a url on the install origin (the shape a token rides in)', () => {
        const r = clean();
        r.plugins[0].from = { kind: 'git', locator: 'h/r.git', ref: null, sha256: null, commit: null };
        (r.plugins[0].from as unknown as Record<string, unknown>).url = 'https://x:tok@h/r.git';
        expect(pluginReportLeaks(r).length).toBeGreaterThan(0);
    });

    it('catches an env block hung off a plugin', () => {
        const r = clean();
        (r.plugins[0] as unknown as Record<string, unknown>).env = { API_KEY: 'FIXTURESECRET' };
        const leaks = pluginReportLeaks(r);
        expect(leaks.length).toBeGreaterThan(0);
        expect(leaks.join(' ')).not.toContain('FIXTURESECRET');
    });

    it('catches an MCP entry that was spread rather than named', () => {
        const r = clean();
        (r.plugins[0].provides.mcp[0] as unknown as Record<string, unknown>).command = 'node';
        (r.plugins[0].provides.mcp[0] as unknown as Record<string, unknown>).args = ['--key', 'x'];
        const leaks = pluginReportLeaks(r);
        expect(leaks.some((p) => p.includes('command'))).toBe(true);
        expect(leaks.some((p) => p.includes('args'))).toBe(true);
    });

    it('catches a hook carrying its args', () => {
        const r = clean();
        (r.plugins[0].provides.hooks[0] as unknown as Record<string, unknown>).args = ['--flag', 'x'];
        expect(pluginReportLeaks(r).some((p) => p.includes('hooks'))).toBe(true);
    });

    it('catches vars sent as a map — that would be the values', () => {
        const r = clean();
        (r.plugins[0] as unknown as Record<string, unknown>).vars = { HULY_API_KEY: 'FIXTURESECRET' };
        const leaks = pluginReportLeaks(r);
        expect(leaks.some((p) => p.includes('vars'))).toBe(true);
        expect(leaks.join(' ')).not.toContain('FIXTURESECRET');
    });

    it('catches a vendor key nobody allow-listed', () => {
        const r = clean();
        (r.plugins[0].vendor[0] as unknown as Record<string, unknown>).npmAuthToken = 'x';
        expect(pluginReportLeaks(r).some((p) => p.includes('npmAuthToken'))).toBe(true);
    });

    it('is case-insensitive on the forbidden keys', () => {
        const r = clean();
        (r.plugins[0] as unknown as Record<string, unknown>).API_KEY = 'x';
        expect(pluginReportLeaks(r).length).toBeGreaterThan(0);
    });

    it('checks a catalog report the same way', () => {
        const cat = clean();
        cat.plugins[0].state = 'not-installed';
        (cat.plugins[0] as unknown as Record<string, unknown>).headers = { Authorization: 'x' };
        expect(pluginReportLeaks(cat).length).toBeGreaterThan(0);
    });

    it('checks an op outcome passed as { plugins: [outcome.plugin] }', () => {
        const p = plugin();
        (p as unknown as Record<string, unknown>).password = 'x';
        expect(pluginReportLeaks({ plugins: [p] }).length).toBeGreaterThan(0);
    });

    it('does not hang on a cycle', () => {
        const r = clean() as unknown as Record<string, unknown>;
        r.self = r;
        expect(() => pluginReportLeaks(r)).not.toThrow();
    });
});

describe('the forbidden list is composed, not copied', () => {
    it('bans the credential names and the structural shapes', () => {
        for (const k of ['env', 'token', 'apiKey', 'headers', 'url', 'args', 'command', 'credentials']) {
            expect(pluginForbiddenKeys).toContain(k);
        }
    });

    it('allows only the safe origin and MCP keys', () => {
        expect(pluginFromAllowedKeys).toContain('locator');
        expect(pluginFromAllowedKeys).not.toContain('url');
        expect(pluginMcpAllowedKeys).toEqual(['name', 'when']);
    });
});

describe('pluginStateLine', () => {
    it('names the state, and the harnesses when narrowed', () => {
        expect(pluginStateLine({ state: 'enabled', scope: { kind: 'global' } })).toBe('Enabled');
        expect(pluginStateLine({ state: 'disabled', scope: { kind: 'harness', harnesses: ['codex'] } })).toBe('Disabled · codex');
        expect(pluginStateLine({ state: 'not-installed', scope: { kind: 'harness', harnesses: ['codex'] } })).toBe('Not installed');
    });
});
