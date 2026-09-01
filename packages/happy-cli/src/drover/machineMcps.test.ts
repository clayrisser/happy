/**
 * The relay's job is to be honest about where the answer came from and to
 * refuse one that carries a credential. Both are tested here against a fake
 * bus and a fake wrapper — nothing in this file touches the live bus, which
 * is the same rule the drover's own suite enforces at :7970.
 */

import { describe, expect, it } from 'vitest';

import { readMachineMcps } from './machineMcps';

const server = (name: string) => ({ name, transport: 'stdio' as const, enabled: true });

const report = () => ({
    machine: 'studio.234.bitspur.com',
    readAt: 1_700_000_000_000,
    harnesses: [
        {
            harness: 'claude',
            label: 'Claude Code',
            perAccount: true,
            scopes: [
                {
                    id: 'default',
                    label: 'default',
                    source: '~/.claude.json',
                    missing: false,
                    error: null,
                    servers: [server('pdf'), server('huly')],
                    count: 2,
                    divergence: null,
                },
            ],
            count: 2,
            configured: true,
            diverged: false,
        },
    ],
});

describe('reading this machine’s MCP config', () => {
    it('takes the bus answer when the bus answers', async () => {
        const result = await readMachineMcps({
            fetchBus: async () => report(),
            runCli: async () => {
                throw new Error('the wrapper must not be reached when the bus answered');
            },
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.report.harnesses[0].count).toBe(2);
    });

    it('falls back to the wrapper when the bus is down, because that is when you are looking', async () => {
        const result = await readMachineMcps({
            fetchBus: async () => {
                throw new Error('connect ECONNREFUSED 127.0.0.1:7970');
            },
            runCli: async () => JSON.stringify(report()),
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.report.machine).toBe('studio.234.bitspur.com');
    });

    it('falls back on a bus that answers with something that is not a report', async () => {
        const result = await readMachineMcps({
            fetchBus: async () => ({ error: 'not found' }),
            runCli: async () => JSON.stringify(report()),
        });
        expect(result.ok).toBe(true);
    });

    it('names BOTH failures when neither route worked, so the sentence is diagnosable', async () => {
        const result = await readMachineMcps({
            fetchBus: async () => {
                throw new Error('ECONNREFUSED');
            },
            runCli: async () => {
                throw new Error('drover: unknown verb mcps');
            },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('ECONNREFUSED');
            expect(result.error).toContain('unknown verb mcps');
        }
    });

    it('says where to point the daemon when the wrapper is not installed', async () => {
        const result = await readMachineMcps({
            fetchBus: async () => {
                throw new Error('ECONNREFUSED');
            },
            droverBin: '/nowhere/bin/drover',
            exists: () => false,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('/nowhere/bin/drover');
            expect(result.error).toContain('DROVER_BIN');
        }
    });

    it('REFUSES a report carrying an env block rather than stripping it', async () => {
        const leaky = report();
        (leaky.harnesses[0].scopes[0].servers[0] as unknown as Record<string, unknown>).env = {
            ANTHROPIC_API_KEY: 'sk-ant-leaked',
        };
        const result = await readMachineMcps({ fetchBus: async () => leaky });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            // The refusal must not quote the value it is refusing to send.
            expect(result.error).not.toContain('sk-ant-leaked');
            expect(result.error).toContain('credential-shaped');
            expect(result.error).toContain('Update cattle-drover');
        }
    });

    it('refuses a token hung off a scope, not only off a server', async () => {
        const leaky = report();
        (leaky.harnesses[0].scopes[0] as unknown as Record<string, unknown>).token = 'ghp_leaked';
        const result = await readMachineMcps({ fetchBus: async () => leaky });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).not.toContain('ghp_leaked');
    });

    it('passes a harness with nothing configured through, because none is an answer', async () => {
        const empty = {
            machine: 'studio.234.bitspur.com',
            readAt: 1,
            harnesses: [
                {
                    harness: 'opencode',
                    label: 'OpenCode',
                    perAccount: false,
                    scopes: [
                        {
                            id: 'global',
                            label: 'global',
                            source: '~/.config/opencode/opencode.json',
                            missing: true,
                            error: null,
                            servers: [],
                            count: 0,
                            divergence: null,
                        },
                    ],
                    count: 0,
                    configured: false,
                    diverged: false,
                },
            ],
        };
        const result = await readMachineMcps({ fetchBus: async () => empty });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.report.harnesses[0].configured).toBe(false);
    });

    it('accepts a report with fields this CLI has never heard of', async () => {
        // Version skew is the normal state: the drover ships on its own cadence
        // and a strict parse here would blank the page on every new field.
        const forward = report() as unknown as Record<string, unknown>;
        forward.somethingNew = 'later';
        const result = await readMachineMcps({ fetchBus: async () => forward });
        expect(result.ok).toBe(true);
    });
});
