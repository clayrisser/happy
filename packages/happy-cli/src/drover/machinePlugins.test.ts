import { describe, expect, it } from 'vitest';

import { readMachinePlugins, runPluginOp } from './machinePlugins';
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
    provides: { mcp: [{ name: 'huly', when: null }], skills: [], commands: [], subagents: [], rules: [], bin: [], hooks: [] },
    requires: { commands: [], platform: [], plugins: [] },
    vendor: [{ name: 'huly-mcp', kind: 'git', locator: 'git.example.com/huly-mcp.git', ref: 'v1.0.0' }],
    capabilities: { network: null, paths: [], credentialNames: ['HULY_API_KEY'], harnesses: [], sudo: false },
    warnings: [],
    vars: [],
    from: null,
    installedAt: null,
    sha256: null,
    error: null,
    ...over,
});

const report = (): PluginReport => ({
    machine: 'm',
    readAt: 1,
    harnesses: ['claude', 'cursor', 'codex', 'opencode', 'pi'],
    config: '~/.config/drover/drover.yaml',
    catalog: '~/Projects/bitspur/cattle-drover/plugins',
    store: '~/.drover/plugins',
    plugins: [plugin()],
    errors: [],
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
        await readMachinePlugins({ fetchBus: async (p) => ((asked = p), report()) }, { catalog: true });
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

    it('REFUSES a report carrying a token on an install origin rather than stripping it', async () => {
        const leaky = report();
        leaky.plugins[0].from = { kind: 'git', locator: 'h/r.git', ref: null, sha256: null, commit: null };
        (leaky.plugins[0].from as unknown as Record<string, unknown>).token = 'sk-ant-leaked';
        const r = await readMachinePlugins({ fetchBus: async () => leaky });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).not.toContain('sk-ant-leaked');
            expect(r.error).toContain('credential-shaped');
            expect(r.error).toContain('Update cattle-drover');
        }
    });

    it('REFUSES a report whose vars arrived as a map of values', async () => {
        const leaky = report();
        (leaky.plugins[0] as unknown as Record<string, unknown>).vars = { HULY_API_KEY: 'sk-ant-leaked' };
        const r = await readMachinePlugins({ fetchBus: async () => leaky });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).not.toContain('sk-ant-leaked');
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
            { op: 'disable', name: '@drover/nope' },
            { postBus: async () => ({ ok: false, error: '@drover/nope is not installed' }) },
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
        (leaky.vendor[0] as unknown as Record<string, unknown>).apiKey = 'sk-leaked';
        const r = await runPluginOp(
            { op: 'enable', name: '@drover/huly' },
            { postBus: async () => ({ ok: true, op: 'enable', plugin: leaky, staleSessions: 0 }) },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).not.toContain('sk-leaked');
    });

    it('relays the stale-sessions count and the links report as the machine said them', async () => {
        const r = await runPluginOp(
            { op: 'disable', name: '@drover/huly' },
            {
                postBus: async () => ({
                    ok: true,
                    op: 'disable',
                    plugin: plugin({ state: 'disabled' }),
                    staleSessions: 3,
                    links: { linked: [], unchanged: [], skipped: [], removed: ['huly-cli'], kept: [], absent: [] },
                }),
            },
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.outcome.staleSessions).toBe(3);
            expect(r.outcome.links?.removed).toEqual(['huly-cli']);
        }
    });
});
