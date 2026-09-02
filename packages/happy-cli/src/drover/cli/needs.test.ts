/**
 * The vitest twin of what cattle-drover/tests/needsyou.bats asserts about
 * `drover needs` (DROVE-315). The `drover todos` half of that bats file is
 * ported in todos.test.ts and is not re-tested here.
 *
 * needsyou.bats drives the shell verb against a LIVE bus — raise a to-do that
 * never expires, fold the deadline into the reason, land it on the session that
 * raised it, and block on --wait until any surface closes it — and it stays
 * green until the shell file leaves. Here the same assertions run against a
 * fake bus that answers the two endpoints the verb uses, so no socket is
 * opened, plus one differential that runs the SHELL verb and the node verb
 * against the same loopback stub and compares the JSON each put on the wire,
 * byte for byte.
 *
 * HAPPY_HOME_DIR is pinned to a throwaway before the first import (DROVE-336),
 * and applied again at the shell spawn.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';
import { droverVerbs } from './index';
import { foldDeadline, parse, payload, run } from './needs';

const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('needs.test: configuration (the ~/.happy reader) was imported; the verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('needs.test: persistence (access.key, settings) was imported; the verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('needs.test: api/api (session registration) was imported; the verb must not reach the session machinery');
});
vi.mock('../../claude/runClaude', () => {
    throw new Error('needs.test: claude/runClaude was imported; the verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
}

function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === resolve(realHappyHome)) {
        throw new Error(
            `${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome} (it is ${env.HAPPY_HOME_DIR ?? 'unset'}). `
            + 'Anything that reached the entry from here would register sessions on the real daemon. Refusing.',
        );
    }
}

beforeAll(() => {
    refuseRealHappyHome(process.env, 'needs.test');
    if (happyHomeOf(process.env) !== happyHome) {
        throw new Error(`needs.test: HAPPY_HOME_DIR moved off the pin (it is ${process.env.HAPPY_HOME_DIR}); refusing to run`);
    }
});

afterAll(() => {
    refuseRealHappyHome(process.env, 'needs.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
});

// --- the fake bus -------------------------------------------------------------

interface FakeEvent {
    id: string;
    state: string;
    title: string;
    resolution: null | { action: string; by: string };
    [extra: string]: unknown;
}

/**
 * The two endpoints `drover needs` uses, with the one server.js rule it depends
 * on: an injected `done` stores ack and `drop` stores deny, so `--wait` tests a
 * single field whichever surface closed the to-do.
 */
class FakeBus {
    readonly posts: { path: string; body: string }[] = [];
    readonly waits: string[] = [];
    readonly events: FakeEvent[] = [];
    /** How many polls answer `pending` before the real verdict lands. */
    pendingPolls = 0;
    verdict: null | { action: string; by: string } = null;
    endState = 'resolved';

    handle(url: URL, init?: RequestInit): Response {
        if (init?.method === 'POST') {
            this.posts.push({ path: url.pathname, body: String(init.body) });
            const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
            const ev: FakeEvent = {
                id: `ev-${this.events.length}`,
                state: 'pending',
                title: String(sent.title),
                resolution: null,
                ...sent,
                options: [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
            };
            ev.id = `ev-${this.events.length}`;
            ev.state = 'pending';
            ev.resolution = null;
            this.events.push(ev);
            return json(200, ev);
        }
        const wait = url.pathname.match(/^\/v1\/events\/([^/]+)\/wait$/);
        if (wait) {
            this.waits.push(url.pathname + url.search);
            const ev = this.events.find((e) => e.id === wait[1]);
            if (!ev) return json(404, { error: 'no such event' });
            if (this.pendingPolls > 0) {
                this.pendingPolls -= 1;
                return json(200, { ...ev, state: 'pending' });
            }
            return json(200, { ...ev, state: this.endState, resolution: this.verdict });
        }
        return json(404, { error: `no route for GET ${url.pathname}` });
    }
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An empty STATE_DIR, so no local.env on this machine can redirect the verb. */
const emptyStateDir = mkdtempSync(join(tmpdir(), 'drover-needs-test-'));

function useFakeBus(bus: FakeBus = new FakeBus()): FakeBus {
    vi.stubEnv('STATE_DIR', emptyStateDir);
    vi.stubEnv('DROVER_URL', 'http://bus.test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => bus.handle(new URL(String(input)), init));
    return bus;
}

interface Captured {
    code: number;
    out: string;
    err: string;
}

async function capture(args: string[], env: Env = {}, now?: () => number): Promise<Captured> {
    refuseRealHappyHome(process.env, 'capture');
    const o: string[] = [];
    const e: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (o.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (e.push(String(c)), true));
    try {
        const code = await run(args, { env, now });
        return { code, out: o.join(''), err: e.join('') };
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
}

function closedPort(): Promise<number> {
    return new Promise((res, rej) => {
        const srv = createSocket();
        srv.on('error', rej);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => res(port));
        });
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

// --- the payload, which IS the wire format ------------------------------------

describe('drover needs — the payload (the `jq -n` program, key for key)', () => {
    it('is the shell\'s object, in jq\'s emission order', () => {
        const p = parse(['push the release', '--why', 'the lane is blocked', '--do', 'git push', '--by', '10:00'], {
            PWD: '/home/x',
        });
        expect('title' in p).toBe(true);
        const built = payload(p as never, 'work');
        expect(JSON.stringify(built)).toBe(
            '{"kind":"todo","title":"push the release","reason":"the lane is blocked (by 10:00)","preview":"git push",'
            + '"ttlMs":0,"channel":"external","origin":{"harness":"claude-code","gate":"needs-you","sessionId":null,'
            + '"cwd":"/home/x","account":"work","surface":null}}',
        );
    });

    it('maps every empty string to null, so no surface groups under a session named ""', () => {
        const p = parse(['a thing'], { PWD: '' }) as never;
        const origin = payload(p, '').origin as Record<string, unknown>;
        expect(origin).toEqual({
            harness: 'claude-code',
            gate: 'needs-you',
            sessionId: null,
            cwd: null,
            account: null,
            surface: null,
        });
    });

    it('ttlMs is 0 — a to-do that timed out is a to-do nobody did', () => {
        expect(payload(parse(['x'], {}) as never, '').ttlMs).toBe(0);
    });

    it('channel is external: nothing in a harness is blocked on this', () => {
        // Even with --wait it is this process waiting, not a hook holding a
        // tool call open, so nobody-answered must never fall through to a deny.
        expect(payload(parse(['x', '--wait'], {}) as never, '').channel).toBe('external');
    });

    it('the deadline rides in the reason rather than in a field of its own', () => {
        expect(foldDeadline('the lane is blocked', '10:00')).toBe('the lane is blocked (by 10:00)');
        expect(foldDeadline('', '10:00')).toBe('(by 10:00)');
        expect(foldDeadline('the lane is blocked', '')).toBe('the lane is blocked');
        expect(foldDeadline('', '')).toBe('');
    });
});

// --- the argument loop --------------------------------------------------------

describe('drover needs — the argument loop (exit 2, the shell\'s sentences)', () => {
    it('every option that takes a value says so by name when it is short', () => {
        // `shift 2` with one argument left is an error and under `set -e` that
        // aborted with no message at all.
        for (const flag of ['--why', '--reason', '--do', '--command', '--by', '--deadline', '--timeout', '--session', '--cwd', '--harness']) {
            expect(parse(['a thing', flag], {}), flag).toEqual({ code: 2, error: [`drover needs: ${flag} needs a value`] });
        }
    });

    it('a title is required, quoted, and there is only one', () => {
        expect(parse([], {})).toEqual({ code: 2, error: ['drover needs: say what you need done (try --help)'] });
        expect(parse(['--wait'], {})).toEqual({ code: 2, error: ['drover needs: say what you need done (try --help)'] });
        expect(parse(['one', 'two'], {})).toEqual({
            code: 2,
            error: ["drover needs: one title, quoted (got an extra argument 'two')"],
        });
    });

    it('an unknown option names itself', () => {
        expect(parse(['--bogus'], {})).toEqual({ code: 2, error: ["drover needs: unknown option '--bogus' (try --help)"] });
    });

    it('--timeout takes whole seconds', () => {
        expect(parse(['x', '--timeout', 'soon'], {})).toEqual({ code: 2, error: ['drover needs: --timeout takes whole seconds'] });
        expect(parse(['x', '--timeout', '-1'], {})).toEqual({ code: 2, error: ['drover needs: --timeout takes whole seconds'] });
        expect(parse(['x', '--timeout', '30'], {})).toMatchObject({ timeoutS: 30 });
    });

    it('the session defaults to CLAUDE_CODE_SESSION_ID, with the CODE_ in it', () => {
        // Reading the shorter name filed every to-do a session raised under no
        // session at all: `drover todos --mine` empty, the session's own list
        // empty, and the to-do only ever visible in the all view.
        expect(parse(['x'], { CLAUDE_CODE_SESSION_ID: 'sess-env' })).toMatchObject({ session: 'sess-env' });
        expect(parse(['x'], { CLAUDE_SESSION_ID: 'sess-short' })).toMatchObject({ session: '' });
        expect(parse(['x', '--session', 'told'], { CLAUDE_CODE_SESSION_ID: 'sess-env' })).toMatchObject({ session: 'told' });
    });

    it('--help is exit 0 and the shell\'s text', async () => {
        for (const flag of ['--help', '-h']) {
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            const r = await capture([flag]);
            expect(r.code, flag).toBe(0);
            expect(r.err, flag).toBe('');
            expect(r.out, flag).toMatch(/^drover needs — ask the human to DO something, and keep it on a list until it is\.\n/);
            expect(r.out, flag).toContain('  --wait             block until it is marked done anywhere.');
            expect(r.out.trimEnd(), flag).toMatch(/List them: {2}drover todos {10}Close one: {2}drover todos --done <id>$/);
            expect(fetchSpy, flag).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        }
    });
});

// --- run, against the fake bus: needsyou.bats's `needs` half -------------------

describe('drover needs — run (needsyou.bats, against a fake bus)', () => {
    it('raises a to-do that never expires, and prints its id', async () => {
        const bus = useFakeBus();
        const r = await capture(['push the release', '--why', 'the lane is blocked', '--do', 'git push', '--by', '10:00'], {
            PWD: '/home/x',
        });
        expect(r.code).toBe(0);
        expect(r.out).toBe('ev-0\n');
        const sent = JSON.parse(bus.posts[0].body);
        expect(bus.posts[0].path).toBe('/v1/events');
        expect(sent.kind).toBe('todo');
        expect(sent.ttlMs).toBe(0);
        expect(sent.reason).toBe('the lane is blocked (by 10:00)');
        expect(sent.preview).toBe('git push');
    });

    it('a to-do raised inside a session lands on THAT session without being told', async () => {
        const bus = useFakeBus();
        const r = await capture(['raised from a session'], { CLAUDE_CODE_SESSION_ID: 'sess-env', PWD: '/home/x' });
        expect(r.code).toBe(0);
        expect(JSON.parse(bus.posts[0].body).origin.sessionId).toBe('sess-env');
    });

    it('--json prints the created event instead of the id', async () => {
        const bus = useFakeBus();
        const r = await capture(['a thing', '--json'], { PWD: '/home/x' });
        expect(r.code).toBe(0);
        expect(r.out).toBe(JSON.stringify(bus.events[0], null, 2) + '\n');
        expect(r.out).not.toBe('ev-0\n');
    });

    it('--wait blocks until another surface marks it done', async () => {
        const bus = useFakeBus();
        bus.verdict = { action: 'ack', by: 'watch' };
        const r = await capture(['restart the daemon', '--wait'], { PWD: '/home/x' });
        expect(r.code).toBe(0);
        expect(r.err).toBe('done, by watch\n');
        // Without --json and with --wait the id is not printed: the answer is.
        expect(r.out).toBe('');
    });

    it('--wait exits 1 when the to-do is dropped rather than done', async () => {
        const bus = useFakeBus();
        bus.verdict = { action: 'deny', by: 'watch' };
        const r = await capture(['call the bank', '--wait'], { PWD: '/home/x' });
        expect(r.code).toBe(1);
        expect(r.err).toBe('dropped, by watch\n');
    });

    it('an answer with no `by` still names somebody', async () => {
        const bus = useFakeBus();
        bus.verdict = { action: 'ack' } as never;
        const r = await capture(['x', '--wait'], { PWD: '/home/x' });
        expect(r.code).toBe(0);
        expect(r.err).toBe('done, by somebody\n');
    });

    it('a to-do that ended some other way is exit 1, naming how it ended', async () => {
        const bus = useFakeBus();
        bus.endState = 'canceled';
        bus.verdict = null;
        const r = await capture(['x', '--wait'], { PWD: '/home/x' });
        expect(r.code).toBe(1);
        expect(r.err).toBe('drover needs: ev-0 ended canceled\n');
    });

    it('the long poll re-arms at ten minutes, because a to-do never expires', async () => {
        // The bus caps timeout_ms at 30 minutes, so one request can never be
        // the whole wait.
        const bus = useFakeBus();
        bus.pendingPolls = 2;
        bus.verdict = { action: 'ack', by: 'phone' };
        const r = await capture(['x', '--wait'], { PWD: '/home/x' });
        expect(r.code).toBe(0);
        expect(bus.waits).toEqual([
            '/v1/events/ev-0/wait?timeout_ms=600000',
            '/v1/events/ev-0/wait?timeout_ms=600000',
            '/v1/events/ev-0/wait?timeout_ms=600000',
        ]);
    });

    it('--wait with a timeout gives up and says the to-do is still on the list', async () => {
        const bus = useFakeBus();
        bus.pendingPolls = 99;
        // `date +%s`, injected: the first poll returns pending, the clock has
        // moved past the deadline, and the wait ends without closing anything.
        let t = 1_000_000;
        const r = await capture(['x', '--wait', '--timeout', '5'], { PWD: '/home/x' }, () => (t += 10));
        expect(r.code).toBe(3);
        expect(r.err).toBe('drover needs: still open after 5s — it is on the list as ev-0\n');
        // NO WITHDRAWAL TRAP: nothing was canceled on the way out.
        expect(bus.posts.map((p) => p.path)).toEqual(['/v1/events']);
    });

    it('a bus that answers without an id is exit 5, quoting what it said', async () => {
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', 'http://bus.test');
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":"kind must be one of"}', { status: 400 }));
        const r = await capture(['x'], { PWD: '/home/x' });
        expect(r.code).toBe(5);
        expect(r.err).toBe('drover needs: the bus refused it: {"error":"kind must be one of"}\n');
    });

    it('a refused connection is exit 5 with lib/drover-bus.sh\'s sentence', async () => {
        const port = await closedPort();
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', `http://127.0.0.1:${port}`);
        const r = await capture(['x'], { PWD: '/home/x' });
        expect(r.code).toBe(5);
        expect(r.err).toBe(
            `drover: bus not running at http://127.0.0.1:${port} — start it with: drover bus\n`
            + '  (or run the supervised stack: make -C "$DROVER_DIR" launchd)\n',
        );
    });

    it('a connection lost mid-wait says so, and the to-do stays on the list', async () => {
        const bus = useFakeBus();
        let first = true;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            if (first && String(input).includes('/wait')) {
                first = false;
                const err = new Error('socket hang up') as Error & { cause: { code: string } };
                err.cause = { code: 'ECONNRESET' };
                throw err;
            }
            return bus.handle(new URL(String(input)), init);
        });
        const r = await capture(['x', '--wait'], { PWD: '/home/x' });
        expect(r.code).toBe(5);
        expect(r.err).toBe('drover needs: lost the connection while waiting on ev-0\n');
    });

    it('the dispatch table carries it as one lazy row', async () => {
        const row = droverVerbs.find((v) => v.name === 'needs');
        expect(row).toBeDefined();
        expect(row!.summary).toBe('Ask the human to DO something, and keep it on a list until it is.');
        const mod = await row!.load();
        expect(typeof mod.run).toBe('function');
    });
});

// --- the shell verb, byte for byte --------------------------------------------

const shellVerb = join(droverEnv().droverDir, 'libexec', 'drover-needs');

/**
 * The shell verb, run ASYNCHRONOUSLY. spawnSync blocks this process's event
 * loop, so the loopback stub below — which lives in this process — could never
 * answer it: curl connected, waited its ten seconds and reported a bus that was
 * "up but slow". One `spawn` instead of one `spawnSync` is the whole fix.
 */
function spawnShell(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((done, fail) => {
        const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('error', fail);
        child.stdin.end('');
        child.on('close', (status) => done({ status, stdout, stderr }));
    });
}

const haveJq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

interface Stub {
    server: Server;
    url: string;
    posts: string[];
}

function startStub(): Promise<Stub> {
    const posts: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                posts.push(body);
                const sent = JSON.parse(body) as Record<string, unknown>;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ id: 'ev-fixed', state: 'pending', ...sent }));
            });
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"no route"}');
    });
    return new Promise((done) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            done({ server, url: `http://127.0.0.1:${port}`, posts });
        });
    });
}

describe.skipIf(!existsSync(shellVerb) || !haveJq)('drover needs — puts the same bytes on the wire as the shell verb', () => {
    it('the smoke fixture: same stdout, same code, same JSON payload', async () => {
        const stub = await startStub();
        try {
            const args = ['push the release', '--why', 'the lane is blocked', '--do', 'git push', '--by', '10:00', '--session', 'sess-53'];
            const env = {
                ...process.env,
                STATE_DIR: emptyStateDir,
                DROVER_URL: stub.url,
                DROVER_ACCOUNT: 'work',
                PWD: emptyStateDir,
            } as NodeJS.ProcessEnv;
            refuseRealHappyHome(env, 'the shell verb spawn');
            const shell = await spawnShell(shellVerb, args, env, emptyStateDir);
            const shellPost = stub.posts.pop();
            vi.stubEnv('STATE_DIR', emptyStateDir);
            vi.stubEnv('DROVER_URL', stub.url);
            const node = await capture(args, { DROVER_ACCOUNT: 'work', PWD: emptyStateDir });
            vi.unstubAllEnvs();
            expect(node.out).toBe(shell.stdout);
            expect(node.err).toBe(shell.stderr);
            expect(node.code).toBe(shell.status);
            // The jq -n payload. `jq -n` PRETTY-PRINTS, so the shell's body
            // carries two-space indent and newlines where JSON.stringify sends
            // one line; re-serialising both normalises that whitespace and
            // NOTHING else, so this compares the keys, their order and every
            // value byte for byte.
            const nodePost = stub.posts.pop();
            expect(nodePost).toBeDefined();
            expect(shellPost).toBeDefined();
            expect(JSON.stringify(JSON.parse(nodePost!))).toBe(JSON.stringify(JSON.parse(shellPost!)));
            expect(JSON.parse(shellPost!)).toEqual(JSON.parse(nodePost!));
        } finally {
            await new Promise<void>((done) => stub.server.close(() => done()));
        }
    }, 30_000);
});

describe('drover needs — the guards are armed', () => {
    it('the pin holds: this file runs under a throwaway HAPPY_HOME_DIR, not ~/.happy', () => {
        expect(process.env.HAPPY_HOME_DIR).toBe(happyHome);
        expect(happyHome).not.toBe(realHappyHome);
        expect(() => refuseRealHappyHome({}, 'unset')).toThrow(/resolves to the real/);
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: join(homedir(), '.happy') }, 'spelled out')).toThrow(/resolves to the real/);
    });
});
