/**
 * The vitest twin of what cattle-drover/tests/hitl.bats asserts about `drover
 * questions` (DROVE-315). hitl.bats drives the verb against a LIVE bus end to
 * end — the overlap rule, the no-session bucket, --answer — and it stays green
 * until the shell file leaves. What ports to a unit test is the render, which
 * in the shell was a jq program and here is `render`/`age`: the exact lines a
 * person reads. These expectations are the OUTPUT of that jq program run on the
 * same fixture (captured while porting), so a divergence here is a divergence
 * from the shell.
 */

import { describe, expect, it, vi } from 'vitest';

import { age, render, run, type InboxBody } from './questions';

const NOW = 1_700_000_000_000;

/** The fixture hitl.bats builds: one session-less prompt, one prompt in a session. */
function fixture(): InboxBody {
    return {
        counts: { pending: 3, unassigned: 1, sessions: 1 },
        pending: [],
        unassigned: [
            {
                id: 'aaaaaaaa-1111-2222-3333-444444444444',
                kind: 'external',
                title: 'from a cron job',
                createdAt: NOW - 30_000,
                source: 'script',
                sessionId: null,
                cwd: null,
            },
        ],
        bySession: [
            {
                sessionId: 'deadbeef-0000-1111-2222-333333333333',
                cwd: '/home/x',
                events: [
                    {
                        id: 'bbbbbbbb-5555-6666-7777-888888888888',
                        kind: 'permission',
                        title: 'Roll the stack?',
                        createdAt: NOW - 120_000,
                        source: 'gate',
                        sessionId: 'deadbeef-0000-1111-2222-333333333333',
                        cwd: '/home/x',
                    },
                ],
            },
        ],
    };
}

describe('drover questions — age (jq `age($ms)`)', () => {
    it('is whole seconds under 90s', () => {
        expect(age(NOW - 0, NOW)).toBe('0s');
        expect(age(NOW - 30_000, NOW)).toBe('30s');
        expect(age(NOW - 89_000, NOW)).toBe('89s');
    });

    it('flips to whole minutes at 90s, the way jq floors it', () => {
        expect(age(NOW - 90_000, NOW)).toBe('1m');
        expect(age(NOW - 120_000, NOW)).toBe('2m');
    });
});

describe('drover questions — render (the jq program, line for line)', () => {
    it('draws the full view session-less-first, exactly as the shell did', () => {
        expect(render(fixture(), {}, NOW)).toEqual([
            '  ID        SOURCE   KIND        AGE  TITLE',
            '',
            'no session (1)',
            '  aaaaaaaa  script   external    30s  from a cron job',
            '',
            'session deadbeef (1)  /home/x',
            '  bbbbbbbb  gate     permission  2m  Roll the stack?',
            '',
            '  3 waiting · 1 with no session · answer one: drover questions --answer <id> <option>',
        ]);
    });

    it('--none shows the header and only the unassigned rows', () => {
        expect(render(fixture(), { onlyNone: true }, NOW)).toEqual([
            '  ID        SOURCE   KIND        AGE  TITLE',
            '  aaaaaaaa  script   external    30s  from a cron job',
        ]);
    });

    it('--none with nothing unassigned says so in one line, no header', () => {
        const body = fixture();
        body.unassigned = [];
        expect(render(body, { onlyNone: true }, NOW)).toEqual([
            'no prompt is waiting outside a session',
        ]);
    });

    it('--session prints only that session, no header and no summary', () => {
        expect(render(fixture(), { wantSession: 'deadbeef-0000-1111-2222-333333333333' }, NOW)).toEqual([
            '  bbbbbbbb  gate     permission  2m  Roll the stack?',
        ]);
    });

    it('--session for an id that owns nothing prints nothing', () => {
        expect(render(fixture(), { wantSession: 'no-such-session' }, NOW)).toEqual([]);
    });

    it('an empty inbox is one line, not an empty table', () => {
        const body = fixture();
        body.counts = { pending: 0, unassigned: 0, sessions: 0 };
        body.unassigned = [];
        body.bySession = [];
        expect(render(body, {}, NOW)).toEqual(['nothing is waiting']);
    });

    it('a session with a null cwd omits the trailing path', () => {
        const body = fixture();
        body.bySession[0].cwd = null;
        const line = render(body, {}, NOW).find((l) => l.startsWith('session '));
        expect(line).toBe('session deadbeef (1)');
    });
});

describe('drover questions — the argument loop (the `shift 2` trap the shell closed)', () => {
    it('--session with no id is exit 2, not a silent set -e abort', async () => {
        const err: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        expect(await run(['--session'])).toBe(2);
        expect(err.join('')).toContain('drover questions: --session needs an id');
        vi.restoreAllMocks();
    });

    it('--answer with a missing option is exit 2', async () => {
        const err: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        expect(await run(['--answer', 'some-id'])).toBe(2);
        expect(err.join('')).toContain('drover questions: --answer needs an event id and an option');
        vi.restoreAllMocks();
    });

    it('an unknown flag is exit 2 and names itself', async () => {
        const err: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        expect(await run(['--bogus'])).toBe(2);
        expect(err.join('')).toContain("drover questions: unknown argument '--bogus'");
        vi.restoreAllMocks();
    });

    it('--help is exit 0 and reaches the bus for nothing', async () => {
        const out: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        expect(await run(['--help'])).toBe(0);
        expect(out.join('')).toContain('drover questions — every prompt still waiting for an answer.');
        expect(fetchSpy).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });
});
