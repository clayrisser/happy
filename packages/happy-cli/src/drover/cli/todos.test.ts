/**
 * The vitest twin of what cattle-drover/tests/needsyou.bats asserts about
 * `drover todos` (DROVE-315). needsyou.bats drives the shell verb against a
 * LIVE bus — list, close by the eight characters the list prints, refuse an
 * empty or an ambiguous id, the overlap rule, --mine — and it stays green until
 * the shell file leaves. Here the same assertions run against a fake bus that
 * answers the two endpoints the verb uses, with server.js's one rule that
 * matters to it (a to-do's done/drop pair stores ack/deny), so the verb is
 * driven end to end and no socket is opened.
 *
 * The render expectations are the OUTPUT of the shell's jq program run on the
 * same fixture (captured while porting, with `now` pinned), so a divergence
 * here is a divergence from the shell.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { droverVerbs } from './index';
import { age, matchId, openTodos, render, run, select, type TodoEvent } from './todos';

const NOW = 1_700_000_000_000;

/**
 * The fixture, in the order the bus would list it: a to-do in a session with
 * no cwd first, then a session-less to-do, then two in one session. Ages are
 * 1h, 30s, 2m and 3h: one per tier, and the 90m boundary.
 */
function fixture(): TodoEvent[] {
    return [
        {
            id: 'dddddddd-0000-1111-2222-333333333333',
            kind: 'todo',
            state: 'pending',
            createdAt: NOW - 5_400_000,
            ttlMs: 0,
            origin: { harness: 'claude-code', gate: 'needs-you', account: null, sessionId: 'sess-env-0000', cwd: null, surface: null },
            title: 'raised from a session',
            reason: '',
            preview: '',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
            channel: 'external',
            resolution: null,
        },
        {
            id: 'aaaaaaaa-1111-2222-3333-444444444444',
            kind: 'todo',
            state: 'pending',
            createdAt: NOW - 30_000,
            ttlMs: 0,
            origin: { harness: 'claude-code', gate: 'needs-you', account: null, sessionId: null, cwd: '/home/x', surface: null },
            title: 'log in to the box',
            reason: 'the deploy needs your session',
            preview: '',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
            channel: 'external',
            resolution: null,
        },
        {
            id: 'bbbbbbbb-5555-6666-7777-888888888888',
            kind: 'todo',
            state: 'pending',
            createdAt: NOW - 120_000,
            ttlMs: 0,
            origin: { harness: 'claude-code', gate: 'needs-you', account: null, sessionId: 'sess-53-0000-1111', cwd: '/home/x', surface: null },
            title: 'push the release',
            reason: 'the lane is blocked (by 10:00)',
            preview: 'git push',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
            channel: 'external',
            resolution: null,
        },
        {
            id: 'cccccccc-5555-6666-7777-888888888888',
            kind: 'todo',
            state: 'pending',
            createdAt: NOW - 3 * 3_600_000,
            ttlMs: 0,
            origin: { harness: 'claude-code', gate: 'needs-you', account: null, sessionId: 'sess-53-0000-1111', cwd: '/home/x', surface: null },
            title: 'plain one',
            reason: '',
            preview: '',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
            channel: 'external',
            resolution: null,
        },
    ];
}

/** What GET /v1/events?state=pending returns for the fixture, a question among them. */
function pendingBody(): string {
    const [d, a, b, c] = fixture();
    const question = {
        id: 'eeeeeeee-0000-1111-2222-333333333333',
        kind: 'question',
        state: 'pending',
        createdAt: NOW - 10_000,
        ttlMs: 60_000,
        origin: { harness: 'bats', sessionId: null, cwd: null },
        title: 'Which one?',
        options: [{ id: 'a', label: 'A' }],
        resolution: null,
    };
    return JSON.stringify({ events: [d, question, a, b, c] });
}

// --- the fake bus --------------------------------------------------------

interface FakeEvent extends TodoEvent {
    state: string;
    resolution: null | { action: string; optionId: string };
}

/**
 * The two endpoints `drover todos` uses, with the one server.js rule the verb
 * depends on: a to-do answered with the injected `done` stores ack, `drop`
 * stores deny, so `drover todos` and `drover needs --wait` test one field
 * whichever surface closed it.
 */
class FakeBus {
    readonly events: FakeEvent[] = [];
    readonly resolves: { id: string; body: Record<string, unknown> }[] = [];

    add(title: string, extra: { sessionId?: string | null; cwd?: string | null; reason?: string; preview?: string } = {}): FakeEvent {
        const ev: FakeEvent = {
            id: randomUUID(),
            kind: 'todo',
            state: 'pending',
            createdAt: Date.now(),
            ttlMs: 0,
            origin: { harness: 'claude-code', gate: 'needs-you', sessionId: extra.sessionId ?? null, cwd: extra.cwd ?? null },
            title,
            reason: extra.reason ?? '',
            preview: extra.preview ?? '',
            options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
            resolution: null,
        };
        this.events.push(ev);
        return ev;
    }

    pending(): FakeEvent[] {
        return this.events.filter((e) => e.state === 'pending');
    }

    handle(url: URL, init?: RequestInit): Response {
        if (init?.method === 'POST') {
            const m = url.pathname.match(/^\/v1\/events\/([^/]+)\/resolve$/);
            if (!m) return json(404, { error: `no route for POST ${url.pathname}` });
            const ev = this.events.find((e) => e.id === m[1]);
            if (!ev) return json(404, { error: `no event ${m[1]}` });
            if (ev.state !== 'pending') return json(409, { error: `event ${ev.id} is ${ev.state}` });
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            this.resolves.push({ id: ev.id, body });
            ev.state = 'resolved';
            ev.resolution = { action: body.optionId === 'drop' ? 'deny' : 'ack', optionId: String(body.optionId) };
            return json(200, ev);
        }
        if (url.pathname === '/v1/events' && url.searchParams.get('state') === 'pending') {
            return json(200, { events: this.pending() });
        }
        return json(404, { error: `no route for GET ${url.pathname}` });
    }
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An empty STATE_DIR, so no local.env on this machine can redirect the verb. */
const emptyStateDir = mkdtempSync(join(tmpdir(), 'drover-todos-test-'));

/** Point the verb at a FakeBus. The host never resolves; fetch is the fake. */
function useFakeBus(bus: FakeBus = new FakeBus()): FakeBus {
    vi.stubEnv('STATE_DIR', emptyStateDir);
    vi.stubEnv('DROVER_URL', 'http://bus.test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => bus.handle(new URL(String(input)), init));
    return bus;
}

/** Point the verb at a body of the caller's choosing, whatever the bus asked. */
function useBody(status: number, body: string): void {
    vi.stubEnv('STATE_DIR', emptyStateDir);
    vi.stubEnv('DROVER_URL', 'http://bus.test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status }));
}

function capture(): { out: () => string; err: () => string } {
    const o: string[] = [];
    const e: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (o.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (e.push(String(c)), true));
    return { out: () => o.join(''), err: () => e.join('') };
}

/** A loopback port that was just bound and freed — connecting to it refuses. */
function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

// --- age -------------------------------------------------------------------

describe('drover todos — age (jq `age($ms)`, three tiers)', () => {
    it('is whole seconds under 90s', () => {
        expect(age(NOW, NOW)).toBe('0s');
        expect(age(NOW - 30_000, NOW)).toBe('30s');
        expect(age(NOW - 89_999, NOW)).toBe('89s');
    });

    it('is whole minutes from 90s up to 90m', () => {
        expect(age(NOW - 90_000, NOW)).toBe('1m');
        expect(age(NOW - 120_000, NOW)).toBe('2m');
        expect(age(NOW - 5_399_000, NOW)).toBe('89m');
    });

    it('is whole hours from 90m', () => {
        expect(age(NOW - 5_400_000, NOW)).toBe('1h');
        expect(age(NOW - 3 * 3_600_000, NOW)).toBe('3h');
        expect(age(NOW - 47 * 3_600_000, NOW)).toBe('47h');
    });
});

// --- render ----------------------------------------------------------------

describe('drover todos — render (the jq program, line for line)', () => {
    it('draws the full view grouped by session, session-less first, exactly as the shell did', () => {
        expect(render(fixture(), {}, NOW)).toEqual([
            '  ID        AGE    WHAT',
            '',
            'no session (1)',
            '  aaaaaaaa  30s    log in to the box',
            '            the deploy needs your session',
            '',
            'session sess-53- (2)  /home/x',
            '  bbbbbbbb  2m     push the release',
            '            the lane is blocked (by 10:00)',
            '            $ git push',
            '  cccccccc  3h     plain one',
            '',
            'session sess-env (1)',
            '  dddddddd  1h     raised from a session',
            '',
            '  4 open · mark one done: drover todos --done <id>',
        ]);
    });

    it('--session draws only that session, header and summary included', () => {
        expect(render(fixture(), { wantSession: 'sess-53-0000-1111' }, NOW)).toEqual([
            '  ID        AGE    WHAT',
            '',
            'session sess-53- (2)  /home/x',
            '  bbbbbbbb  2m     push the release',
            '            the lane is blocked (by 10:00)',
            '            $ git push',
            '  cccccccc  3h     plain one',
            '',
            '  2 open · mark one done: drover todos --done <id>',
        ]);
    });

    it('--none draws only the session-less ones', () => {
        expect(render(fixture(), { onlyNone: true }, NOW)).toEqual([
            '  ID        AGE    WHAT',
            '',
            'no session (1)',
            '  aaaaaaaa  30s    log in to the box',
            '            the deploy needs your session',
            '',
            '  1 open · mark one done: drover todos --done <id>',
        ]);
    });

    it('a view with nothing in it is one line, not an empty table', () => {
        expect(render(fixture(), { wantSession: 'nope' }, NOW)).toEqual(['nothing is waiting on you']);
        expect(render([], {}, NOW)).toEqual(['nothing is waiting on you']);
        expect(render([], { onlyNone: true }, NOW)).toEqual(['nothing is waiting on you']);
    });

    it('a null, missing or empty reason and preview add no line', () => {
        const [, a] = fixture();
        a.reason = null;
        delete a.preview;
        expect(render([a], {}, NOW)).toEqual([
            '  ID        AGE    WHAT',
            '',
            'no session (1)',
            '  aaaaaaaa  30s    log in to the box',
            '',
            '  1 open · mark one done: drover todos --done <id>',
        ]);
    });
});

// --- the pieces the shell had as jq one-liners ----------------------------

describe('drover todos — openTodos (`[.events[]? | select(.kind == "todo")]`)', () => {
    it('keeps the to-dos and drops the question', () => {
        expect(openTodos(pendingBody()).map((e) => e.id.slice(0, 8))).toEqual(['dddddddd', 'aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    });

    it('a body that is not JSON, or has no events, is no to-dos — the shell\'s `|| open=\'[]\'`', () => {
        expect(openTodos('')).toEqual([]);
        expect(openTodos('<html>502</html>')).toEqual([]);
        expect(openTodos('{"error":"boom"}')).toEqual([]);
        expect(openTodos('{"events":null}')).toEqual([]);
    });
});

describe('drover todos — the overlap rule (a session\'s to-do is in BOTH views)', () => {
    it('is in its own list and in the all list, and not in --none', () => {
        const open = fixture();
        const own = select(open, { wantSession: 'sess-53-0000-1111' }).map((e) => e.title);
        const all = select(open, {}).map((e) => e.title);
        const none = select(open, { onlyNone: true }).map((e) => e.title);
        expect(own).toContain('push the release');
        expect(all).toContain('push the release');
        expect(none).not.toContain('push the release');
        expect(none).toEqual(['log in to the box']);
    });
});

describe('drover todos — matchId (eight characters must be enough)', () => {
    it('resolves a unique prefix to the whole id', () => {
        expect(matchId(fixture(), 'bbbbbbbb')).toEqual({ id: 'bbbbbbbb-5555-6666-7777-888888888888' });
        expect(matchId(fixture(), 'cccccccc-5555-6666-7777-888888888888')).toEqual({ id: 'cccccccc-5555-6666-7777-888888888888' });
    });

    it('refuses a prefix that matches more than one, naming the count', () => {
        const [, a] = fixture();
        const twin = { ...a, id: 'aaaaaaaa-9999-9999-9999-999999999999' };
        expect(matchId([a, twin], 'aaaaaaaa')).toEqual({ error: "drover todos: 'aaaaaaaa' matches 2 open to-dos — give more of the id" });
    });

    it('says so when nothing matches, rather than picking one', () => {
        expect(matchId(fixture(), 'deadbeef')).toEqual({ error: "drover todos: no open to-do starts with 'deadbeef'" });
    });
});

// --- run, against the fake bus: needsyou.bats, assertion for assertion ------

describe('drover todos — run (needsyou.bats, against a fake bus)', () => {
    it('lists an open to-do and closes it by its short id', async () => {
        const bus = useFakeBus();
        const ev = bus.add('log in to the box', { reason: 'the deploy needs your session' });
        let cap = capture();
        expect(await run([])).toBe(0);
        expect(cap.out()).toContain('log in to the box');
        expect(cap.out()).toContain('the deploy needs your session');
        vi.restoreAllMocks();

        // Eight characters is what the list prints, so eight characters must
        // be enough to close one.
        useFakeBus(bus);
        cap = capture();
        expect(await run(['--done', ev.id.slice(0, 8)])).toBe(0);
        expect(cap.out()).toMatch(/^done:/);
        expect(cap.out()).toBe('done: log in to the box\n');
        expect(ev.resolution?.action).toBe('ack');
        expect(bus.resolves).toEqual([{ id: ev.id, body: { action: 'option', optionId: 'done', by: 'drover-todos', channel: 'visual' } }]);
        vi.restoreAllMocks();

        useFakeBus(bus);
        cap = capture();
        expect(await run([])).toBe(0);
        expect(cap.out()).toContain('nothing is waiting on you');
    });

    it('drop is the one answer that is not done', async () => {
        const bus = useFakeBus();
        const ev = bus.add('ssh to the box');
        const cap = capture();
        expect(await run(['--drop', ev.id])).toBe(0);
        expect(cap.out()).toBe('dropped: ssh to the box\n');
        expect(ev.resolution?.action).toBe('deny');
    });

    it('an empty id is refused, not read as "just list them"', async () => {
        const bus = useFakeBus();
        bus.add('one thing');
        const cap = capture();
        expect(await run(['--done', ''])).toBe(2);
        expect(cap.err()).toContain('needs an event id');
        expect(cap.err()).toBe('drover todos: --done needs an event id\n');
        expect(cap.out()).toBe('');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(bus.pending()).toHaveLength(1);
    });

    it('an ambiguous short id is refused instead of closing the wrong to-do', async () => {
        const bus = useFakeBus();
        // Seventeen ids guarantee two share a first hex character
        // (pigeonhole), so the ambiguity is real rather than a coin flip.
        for (let i = 1; i <= 17; i++) bus.add(`thing ${i}`);
        const byFirst = new Map<string, number>();
        for (const e of bus.pending()) byFirst.set(e.id[0], (byFirst.get(e.id[0]) ?? 0) + 1);
        const [dupe, count] = [...byFirst.entries()].find(([, n]) => n > 1)!;
        const cap = capture();
        expect(await run(['--done', dupe])).toBe(1);
        expect(cap.err()).toContain('give more of the id');
        expect(cap.err()).toBe(`drover todos: '${dupe}' matches ${count} open to-dos — give more of the id\n`);
        // Nothing was closed by the refusal.
        expect(bus.resolves).toEqual([]);
        expect(bus.pending()).toHaveLength(17);
    });

    it('closing an id nothing matches says so rather than picking one', async () => {
        const bus = useFakeBus();
        bus.add('a thing');
        const cap = capture();
        expect(await run(['--done', 'deadbeef'])).toBe(1);
        expect(cap.err()).toContain('no open to-do');
        expect(cap.err()).toBe("drover todos: no open to-do starts with 'deadbeef'\n");
        expect(bus.pending()).toHaveLength(1);
    });

    it('a session\'s to-dos are in BOTH its own list and the all list', async () => {
        const bus = useFakeBus();
        bus.add('one for the session', { sessionId: 'sess-53' });
        let cap = capture();
        expect(await run(['--session', 'sess-53'])).toBe(0);
        expect(cap.out()).toContain('one for the session');
        vi.restoreAllMocks();

        // The overlap rule drover-questions documents: never in only one,
        // because whichever view a surface rendered would hide the other half.
        useFakeBus(bus);
        cap = capture();
        expect(await run([])).toBe(0);
        expect(cap.out()).toContain('one for the session');
        vi.restoreAllMocks();

        useFakeBus(bus);
        cap = capture();
        expect(await run(['--none'])).toBe(0);
        expect(cap.out()).toContain('nothing is waiting on you');
    });

    it('--mine reads CLAUDE_CODE_SESSION_ID, with the CODE_ in it', async () => {
        const bus = useFakeBus();
        bus.add('raised from a session', { sessionId: 'sess-env' });
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'sess-env');
        const cap = capture();
        expect(await run(['--mine'])).toBe(0);
        expect(cap.out()).toContain('raised from a session');
    });

    it('--mine outside a session is exit 2 and says which variable', async () => {
        useFakeBus();
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
        const cap = capture();
        expect(await run(['--mine'])).toBe(2);
        expect(cap.err()).toBe('drover todos: --mine needs CLAUDE_CODE_SESSION_ID, which is not set here\n');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('--json prints the view\'s raw events the way jq did, and [] for none', async () => {
        const bus = useFakeBus();
        bus.add('for a session', { sessionId: 'sess-53', cwd: '/home/x' });
        bus.add('for nobody');
        let cap = capture();
        expect(await run(['--json'])).toBe(0);
        expect(cap.out()).toBe(JSON.stringify(bus.pending(), null, 2) + '\n');
        vi.restoreAllMocks();

        useFakeBus(bus);
        cap = capture();
        expect(await run(['--session', 'sess-53', '--json'])).toBe(0);
        expect(JSON.parse(cap.out()).map((e: TodoEvent) => e.title)).toEqual(['for a session']);
        vi.restoreAllMocks();

        useFakeBus(bus);
        cap = capture();
        expect(await run(['--session', 'nope', '--json'])).toBe(0);
        expect(cap.out()).toBe('[]\n');
    });

    it('a body that is not a list of events lists nothing, as the shell\'s `|| open=\'[]\'` did', async () => {
        useBody(502, '<html>bad gateway</html>');
        const cap = capture();
        expect(await run([])).toBe(0);
        expect(cap.out()).toBe('nothing is waiting on you\n');
    });

    it('a resolve the bus refuses is exit 1 with its reason', async () => {
        const bus = useFakeBus();
        const ev = bus.add('twice');
        ev.state = 'resolved';
        // Still listed as pending by a bus mid-race; the resolve then answers
        // with an error body, which is the bus's sentence, prefixed.
        vi.spyOn(bus, 'pending').mockReturnValue([ev]);
        const cap = capture();
        expect(await run(['--done', ev.id])).toBe(1);
        expect(cap.err()).toBe(`drover todos: event ${ev.id} is resolved\n`);
    });
});

describe('drover todos — the argument loop (exit 2, the shell\'s sentences)', () => {
    it('--session with no id', async () => {
        const cap = capture();
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        expect(await run(['--session'])).toBe(2);
        expect(cap.err()).toBe('drover todos: --session needs an id\n');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('--done and --drop with no id', async () => {
        let cap = capture();
        expect(await run(['--done'])).toBe(2);
        expect(cap.err()).toBe('drover todos: --done needs an event id\n');
        vi.restoreAllMocks();
        cap = capture();
        expect(await run(['--drop'])).toBe(2);
        expect(cap.err()).toBe('drover todos: --drop needs an event id\n');
    });

    it('an unknown flag names itself', async () => {
        const cap = capture();
        expect(await run(['--bogus'])).toBe(2);
        expect(cap.err()).toBe("drover todos: unknown argument '--bogus' (try --help)\n");
    });

    it('--help and -h are exit 0, the shell\'s text, and reach the bus for nothing', async () => {
        for (const flag of ['--help', '-h']) {
            const cap = capture();
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            expect(await run([flag]), flag).toBe(0);
            const text = cap.out();
            expect(text, flag).toMatch(/^drover todos — the things a session needs you to do, until you have done them\.\n\nUSAGE\n/);
            expect(text, flag).toContain('  drover todos --mine               Only this session\'s ($CLAUDE_CODE_SESSION_ID)\n');
            expect(text, flag).toContain('  drover todos --done <id>          Mark one done. The session waiting on it\n');
            expect(text, flag).toMatch(/\nEnvelope: {3}docs\/hitl\.md\n$/);
            expect(fetchSpy, flag).not.toHaveBeenCalled();
            expect(cap.err(), flag).toBe('');
            vi.restoreAllMocks();
        }
    });
});

describe('drover todos — the bus, and telling the truth about it', () => {
    it('a refused connection is exit 1 with lib/drover-bus.sh\'s sentence, never "unreachable"', async () => {
        const port = await closedPort();
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', `http://127.0.0.1:${port}`);
        const cap = capture();
        expect(await run([])).toBe(1);
        expect(cap.err()).toBe(
            `drover: bus not running at http://127.0.0.1:${port} — start it with: drover bus\n`
            + '  (or run the supervised stack: make -C "$DROVER_DIR" launchd)\n',
        );
        expect(cap.out()).toBe('');
    });

    it('--done fetches the list first, so a down bus is reported once, as the list', async () => {
        const port = await closedPort();
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', `http://127.0.0.1:${port}`);
        const cap = capture();
        expect(await run(['--done', 'deadbeef'])).toBe(1);
        expect(cap.err()).toMatch(/^drover: bus not running at /);
    });
});

describe('drover todos — the dispatch table', () => {
    it('is one lazy row, and the row loads a module with run', async () => {
        const row = droverVerbs.find((v) => v.name === 'todos');
        expect(row).toBeDefined();
        expect(row!.summary).toBe('The things a session needs you to do, until you have done them.');
        const mod = await row!.load();
        expect(typeof mod.run).toBe('function');
    });
});
