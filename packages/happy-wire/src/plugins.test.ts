import { describe, expect, it } from 'vitest';
import {
    pluginForbiddenKeys,
    pluginReportLeaks,
    pluginSourceAllowedKeys,
    type PluginReport,
    type PluginSummary,
} from './plugins';

const plugin = (over: Partial<PluginSummary> = {}): PluginSummary => ({
    name: '@drover/huly',
    version: '1.2.0',
    manifestVersion: 1,
    summary: 'Huly ticketing',
    dependsOn: [],
    provides: { mcp: ['huly'], skills: ['huly-ticket'], hooks: [{ script: 'hooks/deny.sh', event: 'PreToolUse' }], bin: [], libexec: [] },
    when: [{ component: 'mcp:huly', os: null, harness: ['claude', 'codex'] }],
    sources: [{ kind: 'git', locator: 'git.example.com/huly.git', ref: 'main', sha256: null, patches: 0 }],
    requires: [{ kind: 'env', name: 'HULY_TOKEN', note: 'set your own Huly token' }],
    integrity: { sha256: null },
    installs: false,
    state: 'enabled',
    scope: { kind: 'harness', harnesses: ['claude', 'codex'] },
    from: null,
    config: ['NOTES_DIR'],
    manifestKnown: true,
    staleSessions: 0,
    ...over,
});

const clean = (): PluginReport => ({
    machine: 'studio.234.bitspur.com',
    readAt: 1_700_000_000_000,
    harnesses: ['claude', 'cursor', 'codex', 'opencode', 'pi'],
    plugins: [plugin()],
});

describe('pluginReportLeaks', () => {
    it('passes a clean report', () => {
        expect(pluginReportLeaks(clean())).toEqual([]);
    });

    it('passes a report with a named credential requirement — a name is not a value', () => {
        const r = clean();
        r.plugins[0].requires = [{ kind: 'env', name: 'HULY_TOKEN', note: 'set it yourself' }];
        expect(pluginReportLeaks(r)).toEqual([]);
    });

    it('catches a token hung off a source', () => {
        const r = clean();
        (r.plugins[0].sources[0] as unknown as Record<string, unknown>).token = 'FIXTURESECRET';
        const leaks = pluginReportLeaks(r);
        expect(leaks.length).toBeGreaterThan(0);
        expect(leaks.join(' ')).not.toContain('FIXTURESECRET');
    });

    it('catches a url on a from-source (the shape a token rides in)', () => {
        const r = clean();
        r.plugins[0].from = { kind: 'git', locator: 'h/r.git', ref: null, pick: null } as PluginSummary['from'];
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

    it('catches a source key nobody allow-listed', () => {
        const r = clean();
        (r.plugins[0].sources[0] as unknown as Record<string, unknown>).npmAuthToken = 'x';
        expect(pluginReportLeaks(r).some((p) => p.includes('npmAuthToken'))).toBe(true);
    });

    it('is case-insensitive on the forbidden keys', () => {
        const r = clean();
        (r.plugins[0] as unknown as Record<string, unknown>).API_KEY = 'x';
        expect(pluginReportLeaks(r).length).toBeGreaterThan(0);
    });

    it('checks a catalog report the same way (plugins array)', () => {
        const cat = { machine: 'm', readAt: 1, catalog: '~/plugins', plugins: [{ ...plugin(), installed: false }] };
        (cat.plugins[0].sources[0] as unknown as Record<string, unknown>).headers = { Authorization: 'x' };
        expect(pluginReportLeaks(cat).length).toBeGreaterThan(0);
    });

    it('does not hang on a cycle', () => {
        const r = clean() as unknown as Record<string, unknown>;
        r.self = r;
        expect(() => pluginReportLeaks(r)).not.toThrow();
    });
});

describe('the forbidden list is composed, not copied', () => {
    it('bans the credential names and the structural shapes', () => {
        for (const k of ['env', 'token', 'apiKey', 'headers', 'url', 'args', 'command']) {
            expect(pluginForbiddenKeys).toContain(k);
        }
    });

    it('allows only the safe source keys', () => {
        expect(pluginSourceAllowedKeys).toContain('locator');
        expect(pluginSourceAllowedKeys).not.toContain('url');
    });
});
