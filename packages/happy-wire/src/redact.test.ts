import { describe, it, expect } from 'vitest';
import {
    credentialKeys,
    isCredentialKey,
    pickForLog,
    redactSecrets,
    redactSecretsInText,
    redactedMarker,
} from './redact';
import { mcpForbiddenKeys, mcpReportLeaks } from './mcp';

// FIXTURESECRET is the suite's planted marker, borrowed from the drover's
// tests/mcp.bats (DROVE-296) so one grep covers every value hidden in a fixture
// on either side of the wire. Nothing real is ever in this file.
const planted = 'sk-ant-FIXTURESECRET304';

describe('isCredentialKey', () => {
    it('does not care how the name is punctuated or cased', () => {
        for (const name of ['apiKey', 'api_key', 'API-KEY', 'apikey', 'ApiKey']) {
            expect(isCredentialKey(name)).toBe(true);
        }
    });

    it('says no to the names a log line legitimately carries', () => {
        // The whole reason redact.ts keeps a shorter list than mcp.ts. A
        // redactor that masked every url and command leaves a daemon log
        // nobody can debug with, and that redactor gets switched off.
        for (const name of ['url', 'command', 'args', 'directory', 'sessionId', 'agent']) {
            expect(isCredentialKey(name)).toBe(false);
        }
    });
});

describe('redactSecrets', () => {
    it('masks the two fields the leak was actually made of', () => {
        const params = {
            directory: '/Users/x/proj',
            agent: 'claude',
            token: planted,
            environmentVariables: { ANTHROPIC_API_KEY: planted },
        };
        const safe = redactSecrets(params);
        expect(JSON.stringify(safe)).not.toContain('FIXTURESECRET');
        expect(safe.token).toBe(redactedMarker);
        expect(safe.environmentVariables).toBe(redactedMarker);
        // And the parts worth logging survive, or nobody keeps the line.
        expect(safe.directory).toBe('/Users/x/proj');
        expect(safe.agent).toBe('claude');
    });

    it('reaches a credential nested anywhere, at any depth', () => {
        const deep = { a: [{ b: { c: { authorization: planted } } }] };
        expect(JSON.stringify(redactSecrets(deep))).not.toContain('FIXTURESECRET');
    });

    it('never mutates the input, because the input is live', () => {
        // This runs on the very params the daemon is about to spawn with. A
        // redactor that scrubbed the token out of those would be a far worse
        // bug than the one it fixes.
        const params = { token: planted };
        redactSecrets(params);
        expect(params.token).toBe(planted);
    });

    it('survives a cycle rather than hanging', () => {
        const cyclic: Record<string, unknown> = { name: 'x' };
        cyclic.self = cyclic;
        expect(() => redactSecrets(cyclic)).not.toThrow();
    });

    it('leaves an Error alone, so a log line still says what broke', () => {
        const err = new Error('boom');
        expect(redactSecrets({ err }).err).toBe(err);
    });

    it('passes primitives and null through untouched', () => {
        expect(redactSecrets(null)).toBe(null);
        expect(redactSecrets(undefined)).toBe(undefined);
        expect(redactSecrets(7)).toBe(7);
        expect(redactSecrets('plain')).toBe('plain');
    });
});

describe('redactSecretsInText', () => {
    it('finds a credential by the key next to it, in every punctuation', () => {
        for (const line of [
            `token: ${planted}`,
            `"token":"${planted}"`,
            `token='${planted}'`,
            `API_KEY=${planted}`,
            `{ apiKey: "${planted}", directory: "/x" }`,
        ]) {
            expect(redactSecretsInText(line)).not.toContain('FIXTURESECRET');
        }
    });

    it('keeps the line the shape it was, so a grep still finds it', () => {
        expect(redactSecretsInText(`"token":"${planted}"`)).toBe(`"token":"${redactedMarker}"`);
    });

    it('finds the known vendor shapes with no key to go on at all', () => {
        for (const literal of [
            'sk-ant-FIXTURESECRETaaaaaaaaaa',
            'ghp_FIXTURESECRETaaaaaaaaaaaaaaa',
            'github_pat_FIXTURESECRETaaaaaaaaaaaa',
            'xoxb-FIXTURESECRETaaaa-aaaa',
            'AIzaFIXTURESECRETaaaaaaaaaaaaaaaaaaa',
            'sk_live_FIXTURESECRETaaaaaaaaa',
            'eyJhbGciOiJIUzI1NiJ9.eyJGSVhUVVJF.FIXTURESECRETsig',
        ]) {
            expect(redactSecretsInText(`spawn failed with ${literal} oops`)).not.toContain('FIXTURESECRET');
        }
    });

    it('masks a bearer header whatever the token looks like', () => {
        expect(redactSecretsInText('Authorization: Bearer FIXTURESECRETopaque123')).not.toContain('FIXTURESECRET');
    });

    it('leaves an ordinary line completely alone', () => {
        // A redactor that mangles normal lines is a redactor somebody deletes.
        const line = '[API MACHINE] Spawned session abc-123 in /Users/x/proj with agent claude';
        expect(redactSecretsInText(line)).toBe(line);
    });

    it('refuses to half-mask a block, which would only look redacted', () => {
        // Masking the `{` and leaving what is inside is worse than nothing: the
        // line reads redacted and stops anyone looking. Objects belong to
        // redactSecrets, which runs first on this path.
        const line = `env: { ANTHROPIC_API_KEY: 'plain' }`;
        expect(redactSecretsInText(line)).toBe(line);
    });

    it('handles empty input without throwing', () => {
        expect(redactSecretsInText('')).toBe('');
    });

    it('is not left stateful by a previous call', () => {
        // Every pattern is /g, and a /g regex carries lastIndex between calls.
        // Two identical calls must give two identical answers.
        const line = `token: ${planted}`;
        expect(redactSecretsInText(line)).toBe(redactSecretsInText(line));
        expect(redactSecretsInText(line)).not.toContain('FIXTURESECRET');
    });
});

describe('pickForLog', () => {
    it('is an allowlist: an unnamed field cannot ride along', () => {
        const picked = pickForLog(
            { directory: '/x', token: planted, surprise: planted },
            ['directory'],
        );
        expect(picked).toEqual({ directory: '/x' });
        expect(JSON.stringify(picked)).not.toContain('FIXTURESECRET');
    });

    it('still redacts a field that was named but should not have been', () => {
        // A caller who allowlists `token` by mistake gets a marker, not a key.
        const picked = pickForLog({ token: planted }, ['token']);
        expect(picked.token).toBe(redactedMarker);
    });

    it('skips a key the object does not have rather than writing undefined', () => {
        expect(pickForLog({ a: 1 } as { a: number; b?: string }, ['a', 'b'])).toEqual({ a: 1 });
    });

    it('is empty for null, because a log line about nothing says nothing', () => {
        expect(pickForLog(null, ['a'] as never[])).toEqual({});
    });
});

describe('the vocabulary is shared with the MCP report ban list', () => {
    it('every credential name is also banned from a report', () => {
        // The composition in mcp.ts, asserted rather than assumed. This is what
        // makes DROVE-296 adding a name in one place enough.
        const banned = new Set(mcpForbiddenKeys.map((k) => k.toLowerCase()));
        for (const key of credentialKeys) {
            expect(banned.has(key.toLowerCase())).toBe(true);
        }
    });

    it('the report ban list is still wider, and deliberately so', () => {
        for (const structural of ['url', 'command', 'args']) {
            expect(mcpForbiddenKeys).toContain(structural);
            expect(isCredentialKey(structural)).toBe(false);
        }
    });

    it('a clean report is still clean, so the wider list broke nothing', () => {
        const report = {
            machine: 'mac',
            readAt: 1,
            harnesses: [
                {
                    harness: 'claude',
                    label: 'Claude Code',
                    perAccount: true,
                    count: 1,
                    configured: true,
                    diverged: false,
                    scopes: [
                        {
                            id: 'default',
                            label: 'Default',
                            source: '~/.claude.json',
                            missing: false,
                            error: null,
                            count: 1,
                            divergence: null,
                            servers: [{ name: 'huly', transport: 'stdio', enabled: true }],
                        },
                    ],
                },
            ],
        };
        expect(mcpReportLeaks(report)).toEqual([]);
    });
});
