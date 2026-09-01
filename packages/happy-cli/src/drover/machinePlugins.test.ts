import { describe, expect, it } from 'vitest';

import { readMachinePlugins, runPluginOp } from './machinePlugins';
import type { PluginReport, PluginSummary } from '@slopus/happy-wire';

const plugin = (over: Partial<PluginSummary> = {}): PluginSummary => ({
    name: '@drover/huly',
    version: '1.2.0',
    manifestVersion: 1,
    summary: 'Huly ticketing',
    dependsOn: [],
    provides: { mcp: ['huly'], skills: ['huly-ticket'], hooks: [], bin: [], libexec: [] },
    when: [],
    sources: [{ kind: 'git', locator: 'git.example.com/huly.git', ref: 'main', sha256: null, patches: 0 }],
    requires: [{ kind: 'env', name: 'HULY_TOKEN', note: 'set it yourself' }],
    integrity: { sha256: null },
    installs: false,
    state: 'enabled',
    scope: { kind: 'global' },
    from: null,
    config: [],
    manifestKnown: true,
    staleSessions: 0,
    ...over,
});

const report = (): PluginReport => ({
    machine: 'm',
    readAt: 1,
    harnesses: ['claude', 'cursor', 'codex', 'opencode', 'pi'],
    plugins: [plugin()],
});

describe('readMachinePlugins', () => {
    it('relays the bus report when the bus answers', async () => {
        const r = await readMachinePlugins({ fetchBus: async () => report() });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.report.plugins[0].name).toBe('@drover/huly');
    });

    it('falls back to the wrapper when the bus is down', async () => {
        const r = await readMachinePlugins({
            fetchBus: async () => {
                throw new Error('ECONNREFUSED');
            },
            runCli: async (args) => {
                expect(args).toEqual(['plugins', '--json']);
                return JSON.stringify(report());
            },
        });
        expect(r.ok).toBe(true);
    });

    it('asks the catalog route when catalog is requested', async () => {
        let asked = '';
        await readMachinePlugins({ fetchBus: async (p) => ((asked = p), { machine: 'm', readAt: 1, catalog: '~/plugins', plugins: [] }) }, { catalog: true });
        expect(asked).toBe('/v1/plugins/catalog');
    });

    it('names both failures when neither the bus nor the wrapper answers', async () => {
        const r = await readMachinePlugins({
            fetchBus: async () => {
                throw new Error('ECONNREFUSED');
            },
            runCli: async () => {
                throw new Error('boom');
            },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain('the drover bus');
            expect(r.error).toContain('the wrapper');
        }
    });

    it('REFUSES a report carrying a token on a source rather than stripping it', async () => {
        const leaky = report();
        (leaky.plugins[0].sources[0] as unknown as Record<string, unknown>).token = 'sk-ant-leaked';
        const r = await readMachinePlugins({ fetchBus: async () => leaky });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).not.toContain('sk-ant-leaked');
            expect(r.error).toContain('credential-shaped');
            expect(r.error).toContain('Update cattle-drover');
        }
    });

    it('passes a report with forward-compat unknown top-level fields', async () => {
        const forward = { ...report(), somethingNew: 42 };
        const r = await readMachinePlugins({ fetchBus: async () => forward });
        expect(r.ok).toBe(true);
    });
});

describe('runPluginOp', () => {
    it('posts an enable to the name-scoped route and returns the outcome', async () => {
        let posted = '';
        const r = await runPluginOp(
            { op: 'enable', name: '@drover/huly', scope: { kind: 'global' } },
            {
                postBus: async (path, body) => {
                    posted = path;
                    expect(body).toEqual({ scope: { kind: 'global' } });
                    return { ok: true, op: 'enable', plugin: plugin(), staleSessions: 0 };
                },
            },
        );
        expect(posted).toBe('/v1/plugins/%40drover%2Fhuly/enable');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.outcome.op).toBe('enable');
    });

    it('posts an install with source and scope', async () => {
        const r = await runPluginOp(
            { op: 'install', source: { kind: 'catalog', name: '@drover/huly' }, scope: { kind: 'harness', harnesses: ['codex'] } },
            { postBus: async (path) => ((expect(path).toBe('/v1/plugins/install')), { ok: true, op: 'install', plugin: plugin(), staleSessions: 0 }) },
        );
        expect(r.ok).toBe(true);
    });

    it('passes a bus error outcome through as an error', async () => {
        const r = await runPluginOp(
            { op: 'disable', name: 'nope' },
            { postBus: async () => ({ ok: false, error: '`nope` is not installed' }) },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('not installed');
    });

    it('refuses an enable with no name before touching the bus', async () => {
        let touched = false;
        const r = await runPluginOp({ op: 'enable' }, { postBus: async () => ((touched = true), {}) });
        expect(r.ok).toBe(false);
        expect(touched).toBe(false);
    });

    it('reports a bus that cannot be reached, with no CLI fallback for a write', async () => {
        const r = await runPluginOp(
            { op: 'disable', name: '@drover/huly' },
            {
                postBus: async () => {
                    throw new Error('ECONNREFUSED');
                },
            },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('bus');
    });

    it('refuses an op outcome carrying a credential-shaped field', async () => {
        const leaky = plugin();
        (leaky.sources[0] as unknown as Record<string, unknown>).apiKey = 'sk-leaked';
        const r = await runPluginOp(
            { op: 'enable', name: '@drover/huly' },
            { postBus: async () => ({ ok: true, op: 'enable', plugin: leaky, staleSessions: 0 }) },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).not.toContain('sk-leaked');
    });
});
