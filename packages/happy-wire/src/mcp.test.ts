import { describe, expect, it } from 'vitest';
import {
    mcpDivergenceSummary,
    mcpForbiddenKeys,
    mcpReportLeaks,
    mcpServerAllowedKeys,
    type McpHarnessReport,
    type McpReport,
} from './mcp';

const server = (name: string, transport = 'stdio' as const, enabled = true) => ({ name, transport, enabled });

const scope = (id: string, servers: ReturnType<typeof server>[], over: Record<string, unknown> = {}) => ({
    id,
    label: id,
    source: `~/.claude-accounts/${id}/.claude.json`,
    missing: false,
    error: null,
    servers,
    count: servers.length,
    divergence: null,
    ...over,
});

const clean = (): McpReport => ({
    machine: 'studio.234.bitspur.com',
    readAt: 1_700_000_000_000,
    harnesses: [
        {
            harness: 'claude',
            label: 'Claude Code',
            perAccount: true,
            scopes: [scope('default', [server('pdf'), server('huly')]), scope('alt', [server('pdf'), server('huly')])],
            count: 2,
            configured: true,
            diverged: false,
        },
    ],
});

describe('what may cross the bus', () => {
    it('passes a report carrying only names, transport and enabled', () => {
        expect(mcpReportLeaks(clean())).toEqual([]);
    });

    it('catches an env block hung off a server, which is the whole risk', () => {
        const bad = clean();
        (bad.harnesses[0].scopes[0].servers[0] as unknown as Record<string, unknown>).env = { ANTHROPIC_API_KEY: 'sk-ant-leak' };
        const problems = mcpReportLeaks(bad);
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.join('\n')).toContain('env');
    });

    it('catches args and command too, which carry secrets just as often', () => {
        for (const key of ['args', 'command', 'url', 'headers']) {
            const bad = clean();
            (bad.harnesses[0].scopes[0].servers[0] as unknown as Record<string, unknown>)[key] = 'anything';
            expect(mcpReportLeaks(bad).join('\n')).toContain(key);
        }
    });

    it('catches a credential hung off a SCOPE, where the per-server check would miss it', () => {
        const bad = clean();
        (bad.harnesses[0].scopes[0] as unknown as Record<string, unknown>).token = 'ghp_leak';
        expect(mcpReportLeaks(bad).join('\n')).toContain('token');
    });

    it('catches a key nobody put on the denylist, because the server check is an allowlist', () => {
        const bad = clean();
        (bad.harnesses[0].scopes[0].servers[0] as unknown as Record<string, unknown>).oauthRefresh = 'whatever';
        expect(mcpReportLeaks(bad).join('\n')).toContain('oauthRefresh');
    });

    it('names the offending server so a failure is actionable', () => {
        const bad = clean();
        (bad.harnesses[0].scopes[1].servers[1] as unknown as Record<string, unknown>).cookie = 'x';
        expect(mcpReportLeaks(bad).join('\n')).toContain('claude/alt/huly');
    });

    it('is case-insensitive, so API_KEY does not slip past apiKey', () => {
        const bad = clean();
        (bad.harnesses[0].scopes[0] as unknown as Record<string, unknown>).API_KEY = 'x';
        expect(mcpReportLeaks(bad).length).toBeGreaterThan(0);
    });

    it('answers on junk instead of throwing — it runs on whatever arrived', () => {
        expect(mcpReportLeaks(null)).toEqual([]);
        expect(mcpReportLeaks('nope')).toEqual([]);
        expect(mcpReportLeaks({ harnesses: 'not an array' })).toEqual([]);
    });

    it('terminates on a cycle rather than hanging the relay', () => {
        const bad: Record<string, unknown> = { harnesses: [] };
        bad.self = bad;
        expect(mcpReportLeaks(bad)).toEqual([]);
    });

    it('keeps the two lists in sync with what the interface declares', () => {
        expect([...mcpServerAllowedKeys].sort()).toEqual(['enabled', 'name', 'transport']);
        // The forbidden list is the one that grows. If a config format sprouts a
        // new credential-shaped key, it belongs here and this test says so.
        expect(mcpForbiddenKeys).toContain('env');
        expect(mcpForbiddenKeys).toContain('args');
        expect(mcpForbiddenKeys).toContain('url');
    });
});

describe('what the per-account header says', () => {
    const harness = (over: Partial<McpHarnessReport>): McpHarnessReport => ({
        harness: 'claude',
        label: 'Claude Code',
        perAccount: true,
        scopes: [],
        count: 0,
        configured: true,
        diverged: false,
        ...over,
    });

    it('says nothing for a harness that has one config file', () => {
        expect(mcpDivergenceSummary(harness({ perAccount: false, scopes: [scope('global', [])] }))).toBeNull();
    });

    it('says nothing when there is only the default account to compare', () => {
        expect(mcpDivergenceSummary(harness({ scopes: [scope('default', [])] }))).toBeNull();
    });

    it('says the healthy thing out loud, because silence reads as unchecked', () => {
        expect(mcpDivergenceSummary(clean().harnesses[0])).toBe('Same on all 2 accounts');
    });

    it('counts what an account is missing — the DROVE-252 failure', () => {
        const h = harness({
            diverged: true,
            scopes: [
                scope('default', [server('a'), server('b'), server('c')]),
                scope('short', [server('a')], { divergence: { missing: ['b', 'c'], extra: [] } }),
            ],
        });
        expect(mcpDivergenceSummary(h)).toBe('short is missing 2');
    });

    it('reports an extra differently from a missing, because only one is a bug', () => {
        const h = harness({
            diverged: true,
            scopes: [
                scope('default', [server('a')]),
                scope('bespoke', [server('a'), server('z')], { divergence: { missing: [], extra: ['z'] } }),
            ],
        });
        expect(mcpDivergenceSummary(h)).toBe('bespoke has 1 of its own');
    });

    it('reports an unreadable account rather than folding it into a count', () => {
        const h = harness({
            scopes: [scope('default', [server('a')]), scope('corrupt', [], { error: 'unparseable' })],
        });
        expect(mcpDivergenceSummary(h)).toBe('corrupt could not be read');
    });
});
