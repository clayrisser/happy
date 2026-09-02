/**
 * The vitest twin of cattle-drover/tests/reading.bats (DROVE-315).
 *
 * reading.bats drives the shell verb against a live bus with
 * tests/fixtures/phone-stub.mjs at the far end, in three moods — a phone that
 * applies, one that refuses, one that is closed — and it stays green until the
 * shell file leaves. Every CLI-side test there is here, one for one, with the
 * same three moods played by a fake `fetch` instead of a socket. The three
 * bats tests that assert the BUS's own validation (an unknown verb, a bad
 * report, a double ack) are the bus's and stay there; what is here is the half
 * this module owns, plus what the terminal does with each of those answers.
 *
 * On top of the bats, one differential test runs the SHELL verb and the node
 * verb against the SAME loopback stub and compares stdout, stderr, the exit
 * code AND the JSON each one put on the wire, byte for byte.
 *
 * DROVE-283/318. Nothing here reads a log, a transcript or a session file, and
 * neither does the verb: the only text either of them prints is the phone's own
 * report over the bus. The `sentence` in these fixtures is invented for the
 * test, the way the phone stub invents it. No test points at ~/.happy or
 * ~/.claude, and HAPPY_HOME_DIR is pinned to a throwaway before the first
 * import — see the pin below for the night that made it necessary.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';
import { droverVerbs } from './index';
import { ago, parse, printState, run } from './read';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import.
 *
 * On 2026-09-01 a benchmark for this port spawned `node dist/index.mjs` with no
 * HAPPY_HOME_DIR set, so each spawn read the real ~/.happy/access.key and
 * registered a real session with the real daemon: seventy-eight of them from
 * one worktree, on Clay's phone. `drover read` never touches ~/.happy and this
 * file spawns only the SHELL verb, but the leak came from a tree where nothing
 * said no. This does.
 *
 * vi.hoisted runs before the static imports, so the pin is in place before
 * ./read, or anything it might one day import, is evaluated. The guard is
 * applied again at every boundary: each in-process run, and the shell spawn.
 * Unset resolves to ~/.happy too, and is refused too.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'read-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    return { happyHome, realHappyHome };
});

// The modules a session registration goes through. The verb imports none of
// them; a factory that throws turns a future import into a failure of this
// whole file at load, instead of a test that quietly reads ~/.happy.
vi.mock('../../configuration', () => {
    throw new Error('read.test: configuration (the ~/.happy reader) was imported; the verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('read.test: persistence (access.key, settings) was imported; the verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('read.test: api/api (session registration) was imported; the verb must not reach the session machinery');
});
vi.mock('../../claude/runClaude', () => {
    throw new Error('read.test: claude/runClaude was imported; the verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

/** Where HAPPY_HOME_DIR points, read the way configuration.ts reads it. */
function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
}

/** Refuse an environment whose HAPPY_HOME_DIR is the real one. */
function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === resolve(realHappyHome)) {
        throw new Error(
            `${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome} (it is ${env.HAPPY_HOME_DIR ?? 'unset'}). `
            + 'Anything that reached the entry from here would register sessions on the real daemon. Refusing.',
        );
    }
}

/** The files a session start leaves under a HAPPY_HOME_DIR. */
const REGISTRATION_FILES = ['access.key', 'daemon.state.json', 'daemon.state.json.lock', 'sessions.json', 'settings.json'];

beforeAll(() => {
    refuseRealHappyHome(process.env, 'read.test');
    if (happyHomeOf(process.env) !== happyHome) {
        throw new Error(`read.test: HAPPY_HOME_DIR moved off the pin (it is ${process.env.HAPPY_HOME_DIR}); refusing to run`);
    }
});

afterAll(() => {
    // Nothing in this file registered anything, or created anything: the pinned
    // home is exactly as empty as mkdtemp made it.
    refuseRealHappyHome(process.env, 'read.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
});

// --- the far end, in the phone stub's three moods -----------------------------

/**
 * tests/fixtures/phone-stub.mjs's defaultState, field for field. The sentence
 * is invented by that fixture and invented again here; nothing reads a real
 * transcript to get one.
 */
function phoneState(): Record<string, unknown> {
    return {
        global: 'on',
        playing: true,
        sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
        title: 'cattle-drover',
        sentence: 'The lane is green.',
        sessions: [
            { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', enabled: true, state: 'reading', title: 'cattle-drover' },
            { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', enabled: true, state: 'yielded', title: 'happy' },
        ],
    };
}

/** The stub's offState: a phone that refuses because read-aloud is off REPORTS being off. */
function offState(): Record<string, unknown> {
    return { global: 'off', playing: false, sessionId: null, title: null, sentence: null, sessions: [] };
}

/** The stub's applyVerb, so an `applied` verdict carries the state it left behind. */
function applyVerb(state: Record<string, unknown>, cmd: { verb: string; sessionId?: string }): Record<string, unknown> {
    const rows = state.sessions as { sessionId: string; state: string; title: string | null }[];
    if (cmd.verb === 'pause') state.playing = false;
    if (cmd.verb === 'resume') state.playing = true;
    for (const row of rows) {
        if (row.state === 'reading' || row.state === 'paused') row.state = state.playing ? 'reading' : 'paused';
    }
    if (cmd.verb === 'on' && cmd.sessionId) {
        for (const row of rows) if (row.state === 'reading') row.state = 'yielded';
        const row = rows.find((r) => r.sessionId === cmd.sessionId);
        if (row) row.state = 'reading';
        state.sessionId = cmd.sessionId;
        state.title = row?.title ?? null;
        state.playing = true;
    }
    if (cmd.verb === 'off' && cmd.sessionId) {
        state.sessions = rows.filter((r) => r.sessionId !== cmd.sessionId);
        if (state.sessionId === cmd.sessionId) {
            state.sessionId = null;
            state.title = null;
            state.sentence = null;
            state.playing = false;
        }
    }
    return state;
}

const SESSIONS = [
    { id: 'aaaaaaaa-1111-2222-3333-444444444444', state: 'running', pane: '%13', title: 'cattle-drover' },
    { id: 'bbbbbbbb-1111-2222-3333-444444444444', state: 'running', pane: '%14', title: 'happy' },
    { id: 'cccccccc-1111-2222-3333-444444444444', state: 'ended', pane: '%15', title: 'gone' },
];

/**
 * The bus and the phone behind it, as one fake. `mood` is the stub's argument:
 * `apply` acks, `refuse` acks with applied:false and a reason, `silent` never
 * acks at all — so the command expires on the bus, which is the answer the wait
 * returns.
 */
class FakePhone {
    mood: 'apply' | 'refuse' | 'silent' = 'apply';
    reason = 'read aloud is off on the phone';
    state: Record<string, unknown> = phoneState();
    sessions: unknown[] = SESSIONS;
    /** A bus that refuses the command outright, before any phone hears it. */
    refuseCommand: string | null = null;
    /** What GET /v1/reading answers. Null is a phone that has never reported. */
    reported: Record<string, unknown> | null = null;
    readonly posts: { path: string; body: string }[] = [];
    readonly gets: string[] = [];
    readonly commands: Record<string, unknown>[] = [];

    handle(url: URL, init?: RequestInit): Response {
        if (init?.method === 'POST') {
            this.posts.push({ path: url.pathname, body: String(init.body) });
            if (url.pathname !== '/v1/reading/commands') return json(404, { error: `no route for POST ${url.pathname}` });
            if (this.refuseCommand) return json(400, { error: this.refuseCommand });
            const cmd = JSON.parse(String(init.body)) as { verb: string; sessionId?: string; ttlMs: number };
            const id = `rd-${this.commands.length}`;
            if (this.mood === 'refuse') {
                this.state = offState();
                this.commands.push({ id, verb: cmd.verb, state: 'refused', reason: this.reason, snapshot: this.state });
            } else if (this.mood === 'silent') {
                this.commands.push({ id, verb: cmd.verb, state: 'expired', reason: 'the phone did not answer', snapshot: null });
            } else {
                this.state = applyVerb(this.state, cmd);
                this.commands.push({ id, verb: cmd.verb, state: 'applied', reason: null, snapshot: this.state });
            }
            return json(200, { id, verb: cmd.verb, state: 'pending', ttlMs: cmd.ttlMs });
        }
        this.gets.push(url.pathname + url.search);
        if (url.pathname === '/v1/sessions') return json(200, { sessions: this.sessions });
        const wait = url.pathname.match(/^\/v1\/reading\/commands\/([^/]+)\/wait$/);
        if (wait) {
            const cmd = this.commands.find((c) => c.id === wait[1]);
            if (!cmd) return json(404, { error: 'no such reading command' });
            return json(200, cmd);
        }
        if (url.pathname === '/v1/reading') {
            return json(200, this.reported ? { reported: this.reported, ageMs: 4000, stale: false } : { reported: null, ageMs: null, stale: true });
        }
        return json(404, { error: `no route for GET ${url.pathname}` });
    }
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An empty STATE_DIR, so no local.env on this machine can redirect the verb. */
const emptyStateDir = mkdtempSync(join(tmpdir(), 'drover-read-test-'));

function usePhone(phone: FakePhone = new FakePhone()): FakePhone {
    vi.stubEnv('STATE_DIR', emptyStateDir);
    vi.stubEnv('DROVER_URL', 'http://bus.test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => phone.handle(new URL(String(input)), init));
    return phone;
}

interface Captured {
    code: number;
    out: string;
    err: string;
    lines: string[];
}

async function capture(args: string[], env: Env = {}): Promise<Captured> {
    refuseRealHappyHome(process.env, 'capture');
    const o: string[] = [];
    const e: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (o.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (e.push(String(c)), true));
    try {
        const code = await run(args, { env });
        const out = o.join('');
        return { code, out, err: e.join(''), lines: (out + e.join('')).split('\n').filter((l) => l !== '') };
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
}

/** A loopback port that was just bound and freed — connecting to it refuses. */
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

// --- reading.bats, test for test ---------------------------------------------

describe('drover read — help, and the promise in it (reading.bats)', () => {
    it('--help answers without touching the bus, and says the Mac never speaks', async () => {
        // The load-time rule (DROVE-256) plus the ticket's headline claim. A
        // help text that does not say which device makes the noise is how
        // somebody ends up believing `drover read` is a `say` wrapper.
        for (const flag of ['--help', '-h', 'help']) {
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            const r = await capture([flag]);
            expect(r.code, flag).toBe(0);
            expect(r.err, flag).toBe('');
            expect(r.out, flag).toContain('The Mac never speaks');
            expect(r.out, flag).toContain('drover read pause');
            expect(r.out, flag).toContain('drover read here');
            expect(r.out, flag).toMatch(/^drover read — steer what the PHONE reads aloud\. The Mac never speaks\.\n/);
            expect(r.out.trimEnd(), flag).toMatch(/See also: drover sessions \(the ids\) · drover settings \(the channels\)$/);
            expect(fetchSpy, flag).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        }
    });

    it('nothing in the read path can make a sound on this machine', async () => {
        // The acceptance criterion that is easiest to regress and cheapest to
        // pin: one careless `say(sentence)` and the Mac starts talking over
        // him. The verb is a remote control, so the absence of a local player
        // is the feature. Comments stripped first, because this file and
        // read.ts both TALK about not speaking and a prose match would fire on
        // the sentence that promises the behaviour.
        const source = readFileSync(join(__dirname, 'read.ts'), 'utf8')
            .split('\n')
            .map((l) => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*.*$/, ''))
            .join('\n');
        expect(source).not.toMatch(/(^|[^-\w.])(say|afplay|speechd|espeak)([^-\w]|$)/m);
        // And the port cannot reach one either: no shell, no spawn, no audio.
        expect(source).not.toMatch(/child_process|execFile|spawn/);
    });

    it('the dispatch table carries it as one lazy row', async () => {
        const row = droverVerbs.find((v) => v.name === 'read');
        expect(row).toBeDefined();
        expect(row!.summary).toBe('Steer what the PHONE reads aloud. The Mac never speaks.');
        const mod = await row!.load();
        expect(typeof mod.run).toBe('function');
    });
});

describe('drover read — what the phone answers (reading.bats)', () => {
    it('reports what the phone answers, sentence and all', async () => {
        usePhone();
        const r = await capture(['--timeout', '10']);
        expect(r.code).toBe(0);
        // Tighter than the bats' four `has` lines: the whole picture, in order.
        expect(r.out).toBe([
            'reading   playing · cattle-drover (just now)',
            'sentence  The lane is green.',
            '',
            '  session   state      what it means',
            '  aaaaaaaa  reading    has the voice · cattle-drover',
            '  bbbbbbbb  yielded    on, waiting its turn · happy',
            '',
        ].join('\n'));
        // The visible half of DROVE-297's rule: yielded must be tellable from off.
        expect(r.out).toContain('on, waiting its turn');
        expect(r.out).toContain('has the voice');
    });

    it('pause and resume are the PHONE\'s, and it says what it did', async () => {
        const phone = usePhone();
        let r = await capture(['pause', '--timeout', '10']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('holding its place');
        // The state it prints is the one the phone was left in, not the one it
        // had before. A verdict that says "paused" over a table saying
        // "playing" is a terminal contradicting itself about a device you
        // cannot see.
        expect(r.out).toContain('paused ·');
        expect(r.out).toContain('you are holding it');
        expect(phone.state.playing).toBe(false);
        vi.restoreAllMocks();

        usePhone(phone);
        r = await capture(['resume', '--timeout', '10']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('from where it stopped');
        expect(r.out).toContain('playing ·');
        expect(phone.state.playing).toBe(true);
    });

    it('a closed phone changes nothing, says so, and QUEUES NOTHING', async () => {
        // The first edge case, and the one with teeth. A command nobody
        // collected must die on the bus: an app that opens an hour later and
        // starts talking in his pocket is the surprise this whole ticket
        // refuses.
        const phone = usePhone();
        phone.mood = 'silent';
        const r = await capture(['pause', '--timeout', '2']);
        expect(r.code).toBe(5);
        expect(r.err).toContain('did not answer');
        expect(r.err).toContain('Nothing was changed');
        expect(r.err).toBe(
            'drover read: the phone did not answer in 2s. Nothing was changed.\n'
            + '  The app may be closed, asleep or offline. Check the path: drover status\n',
        );
        // The command DIED rather than waiting: expired, nothing pending.
        expect(phone.commands.map((c) => c.state)).toEqual(['expired']);
        expect(phone.commands.map((c) => c.reason)).toEqual(['the phone did not answer']);
        // Its life was the caller's own patience, to the millisecond.
        expect(JSON.parse(phone.posts[0].body).ttlMs).toBe(2000);
        // And ONE command was asked for, not a retry that could still land.
        expect(phone.posts).toHaveLength(1);
    });

    it('a closed phone still shows what the phone last reported, and how long ago', async () => {
        const phone = usePhone();
        phone.mood = 'silent';
        phone.reported = phoneState();
        const r = await capture(['pause', '--timeout', '2']);
        expect(r.code).toBe(5);
        expect(r.err).toBe(
            'drover read: the phone did not answer in 2s. Nothing was changed.\n'
            + '  The app may be closed, asleep or offline. Check the path: drover status\n'
            + '\n'
            + 'reading   playing · cattle-drover (4s ago)\n'
            + 'sentence  The lane is green.\n'
            + '\n'
            + '  session   state      what it means\n'
            + '  aaaaaaaa  reading    has the voice · cattle-drover\n'
            + '  bbbbbbbb  yielded    on, waiting its turn · happy\n',
        );
        expect(phone.gets).toContain('/v1/reading');
    });

    it('a phone with reading OFF is reported, never quietly switched on', async () => {
        // The third edge case, in Clay's own words on the ticket: enabling
        // audio on a device in his pocket from a terminal is a surprise. So the
        // refusal is the answer, and the exit code says the ask did not take.
        const phone = usePhone();
        phone.mood = 'refuse';
        const r = await capture(['pause', '--timeout', '10']);
        expect(r.code).toBe(4);
        expect(r.err).toContain('the phone refused');
        expect(r.err).toContain('read aloud is off');
        // and the state it prints AGREES with the refusal. A refusal over a
        // table showing something speaking is a contradiction about a device he
        // cannot see, which is the confusion this verb exists to remove.
        expect(r.err).toContain('OFF on the phone');
        expect(r.err).toContain('Settings > Voice');
        expect(r.err).toBe(
            'drover read: the phone refused — read aloud is off on the phone\n'
            + 'reading   OFF on the phone (just now) — turn it on in Settings > Voice\n',
        );
        expect(r.out).toBe('');
    });

    it('a refusal with no reason still says something rather than nothing', async () => {
        const phone = usePhone();
        phone.mood = 'refuse';
        phone.reason = '';
        const r = await capture(['pause', '--timeout', '10']);
        expect(r.code).toBe(4);
        expect(r.err).toContain('drover read: the phone refused — no reason given');
    });

    it('an answer that is not a verdict is exit 5, naming what came back', async () => {
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', 'http://bus.test');
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => (
            init?.method === 'POST'
                ? json(200, { id: 'rd-0', state: 'pending' })
                : json(200, { id: 'rd-0', state: 'sulking' })
        ));
        const r = await capture(['--timeout', '3']);
        expect(r.code).toBe(5);
        expect(r.err).toBe("drover read: the bus answered 'sulking', which is not a verdict\n");
    });

    it('an answer that is not JSON at all is exit 5 too, rather than a silent success', async () => {
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', 'http://bus.test');
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => (
            init?.method === 'POST' ? json(200, { id: 'rd-0', state: 'pending' }) : new Response('<html>502</html>', { status: 502 })
        ));
        const r = await capture(['--timeout', '3']);
        expect(r.code).toBe(5);
        expect(r.err).toBe("drover read: the bus answered '', which is not a verdict\n");
    });
});

describe('drover read — naming a session (reading.bats)', () => {
    it('an unknown session is refused BY NAME, before the phone is asked', async () => {
        // The second edge case. Refused here rather than by the phone, because
        // a shrug from a device you cannot see reads exactly like a phone that
        // is switched off, and those two have different fixes.
        const phone = usePhone();
        const r = await capture(['on', '9f9f9f9f-dead-dead-dead-999999999999', '--timeout', '3']);
        expect(r.code).toBe(3);
        expect(r.err).toContain('no session');
        expect(r.err).toBe(
            "drover read: no session '9f9f9f9f-dead-dead-dead-999999999999'.\n"
            + '  Try: drover sessions   (an id, or its first 8 characters)\n',
        );
        // AND IT NEVER ASKED. A refusal that still put a command on the wire
        // would leave the phone free to apply it a moment later, which is the
        // whole difference between refusing by name and shrugging.
        expect(phone.posts).toEqual([]);
    });

    it('a verb wins over a session name, and `on` is the escape hatch', async () => {
        // DROVE-152's rule, which is why this is a noun with verbs at all: a
        // first argument that is a VALUE can never also be a verb. `pause` is
        // the verb; a session that happens to be called `pause` is still
        // addressable through `on`, which is what `use` is for accounts.
        const phone = usePhone();
        let r = await capture(['pause', '--timeout', '10']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('holding its place');
        expect(phone.commands[0].verb).toBe('pause');
        vi.restoreAllMocks();

        usePhone(phone);
        r = await capture(['on', 'pause', '--timeout', '3']);
        expect(r.code).toBe(3);
        expect(r.err).toContain("no session 'pause'");
    });

    it('the voice has no session, so pause refuses to be given one', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const r = await capture(['pause', '--session', 'aaaaaaaa-1111-2222-3333-444444444444']);
        expect(r.code).toBe(2);
        expect(r.err).toContain('the phone has one speaker');
        expect(r.err).toBe('drover read: `pause` acts on the voice, not on a session — the phone has one speaker\n');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('`here` outside tmux says what to type instead of guessing a session', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const r = await capture(['here', '--timeout', '3'], {});
        expect(r.code).toBe(2);
        expect(r.err).toContain('there is no pane here');
        expect(r.err).toContain('drover read on <session>');
        expect(r.err).toBe(
            'drover read: `here` means this tmux pane and there is no pane here.\n'
            + '  Name the session instead: drover read on <session>  (drover sessions lists them)\n',
        );
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('`here` inside tmux resolves the pane\'s live session and gives it the voice', async () => {
        const phone = usePhone();
        const r = await capture(['here', '--timeout', '10'], { TMUX_PANE: '%14' });
        expect(r.code).toBe(0);
        expect(r.out).toContain('the voice is on bbbbbbbb-1111-2222-3333-444444444444 now');
        expect(JSON.parse(phone.posts[0].body).sessionId).toBe('bbbbbbbb-1111-2222-3333-444444444444');
    });

    it('a pane no live session claims is exit 3, naming the pane', async () => {
        const phone = usePhone();
        const r = await capture(['here', '--timeout', '10'], { TMUX_PANE: '%99' });
        expect(r.code).toBe(3);
        expect(r.err).toBe(
            'drover read: no live session on this pane (%99).\n'
            + '  A session started with plain `claude` is not on the bus; start it with `drover`.\n',
        );
        expect(phone.posts).toEqual([]);
    });

    it('an ended session is refused rather than asked about', async () => {
        const phone = usePhone();
        const r = await capture(['on', 'cccccccc', '--timeout', '3']);
        expect(r.code).toBe(3);
        expect(r.err).toBe('drover read: session cccccccc-1111-2222-3333-444444444444 has ended — nothing there to read.\n');
        expect(phone.posts).toEqual([]);
    });

    it('an ambiguous prefix is refused, and lists every id it could have meant', async () => {
        // Picking one of two sessions for him is how the voice lands on the
        // wrong conversation.
        const phone = usePhone();
        phone.sessions = [
            { id: 'abc11111-1111-1111-1111-111111111111', state: 'running', pane: '%1' },
            { id: 'abc22222-2222-2222-2222-222222222222', state: 'running', pane: '%2' },
        ];
        const r = await capture(['on', 'abc', '--timeout', '3']);
        expect(r.code).toBe(3);
        expect(r.err).toBe(
            "drover read: 'abc' names 2 sessions. Give more of the id:\n"
            + '    abc11111-1111-1111-1111-111111111111\n'
            + '    abc22222-2222-2222-2222-222222222222\n',
        );
        expect(phone.posts).toEqual([]);
    });

    it('the eight characters `drover sessions` prints are enough to name one', async () => {
        const phone = usePhone();
        const r = await capture(['aaaaaaaa', '--timeout', '10']);
        expect(r.code).toBe(0);
        expect(JSON.parse(phone.posts[0].body)).toEqual({
            verb: 'on',
            ttlMs: 10000,
            by: 'cli',
            sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
        });
    });

    it('`off` with no argument means this pane, and says which session it turned off', async () => {
        const phone = usePhone();
        const r = await capture(['off', '--timeout', '10'], { TMUX_PANE: '%13' });
        expect(r.code).toBe(0);
        expect(r.out).toContain('reading is off for aaaaaaaa-1111-2222-3333-444444444444.');
        expect(JSON.parse(phone.posts[0].body).verb).toBe('off');
    });

    it('`on` with nothing to name is exit 2, and never reaches the bus', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const r = await capture(['on']);
        expect(r.code).toBe(2);
        expect(r.err).toBe('drover read: `on` needs a session (or `here` for this pane)\n');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// --- the wire, and what the terminal does with what comes back ----------------

describe('drover read — the command it puts on the wire', () => {
    it('status is a COMMAND, not a plain read of the last report', async () => {
        // A snapshot with no round trip cannot tell a phone that is awake and
        // quiet from one that has been shut for a week, and telling those two
        // apart is most of what this verb is for.
        const phone = usePhone();
        await capture(['--timeout', '8']);
        expect(phone.posts).toEqual([{ path: '/v1/reading/commands', body: '{"verb":"status","ttlMs":8000,"by":"cli"}' }]);
    });

    it('the timeout is the command\'s whole life, and the wait\'s budget', async () => {
        const phone = usePhone();
        await capture(['pause', '--timeout', '12']);
        expect(JSON.parse(phone.posts[0].body).ttlMs).toBe(12000);
        expect(phone.gets).toContain('/v1/reading/commands/rd-0/wait?timeout_ms=12000');
    });

    it('DROVER_READ_BY names who asked, and defaults to cli', async () => {
        let phone = usePhone();
        await capture(['pause']);
        expect(JSON.parse(phone.posts[0].body).by).toBe('cli');
        vi.restoreAllMocks();
        phone = usePhone();
        await capture(['pause'], { DROVER_READ_BY: 'watch' });
        expect(JSON.parse(phone.posts[0].body).by).toBe('watch');
    });

    it('a bus that refuses the command says why, and it is exit 2', async () => {
        const phone = usePhone();
        phone.refuseCommand = '`on` names a session: pass sessionId';
        const r = await capture(['pause']);
        expect(r.code).toBe(2);
        expect(r.err).toBe('drover read: the bus refused this command: `on` names a session: pass sessionId\n');
    });

    it('a refusal with no error field still says the command was refused', async () => {
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', 'http://bus.test');
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>502</html>', { status: 502 }));
        const r = await capture(['pause']);
        expect(r.code).toBe(2);
        expect(r.err).toBe('drover read: the bus refused this command\n');
    });

    it('--json prints the phone\'s answer unformatted, and nothing else', async () => {
        const phone = usePhone();
        const r = await capture(['pause', '--json', '--timeout', '10']);
        expect(r.code).toBe(0);
        expect(r.err).toBe('');
        expect(r.out).toBe(JSON.stringify(phone.commands[0]) + '\n');
        // No prose beside it: a script parsing this gets one document.
        expect(r.out).not.toContain('holding its place');
    });

    it('--json on a refusal is the answer on stdout and the sentence on stderr, with no table', async () => {
        const phone = usePhone();
        phone.mood = 'refuse';
        const r = await capture(['pause', '--json', '--timeout', '10']);
        expect(r.code).toBe(4);
        expect(r.out).toBe(JSON.stringify(phone.commands[0]) + '\n');
        expect(r.err).toBe('drover read: the phone refused — read aloud is off on the phone\n');
    });
});

describe('drover read — the bus, and telling the truth about it', () => {
    it('a refused connection on the session list is exit 5 with drover-bus.sh\'s sentence', async () => {
        const port = await closedPort();
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', `http://127.0.0.1:${port}`);
        const r = await capture(['on', 'aaaaaaaa']);
        expect(r.code).toBe(5);
        expect(r.err).toBe(
            `drover: bus not running at http://127.0.0.1:${port} — start it with: drover bus\n`
            + '  (or run the supervised stack: make -C "$DROVER_DIR" launchd)\n',
        );
    });

    it('a refused connection on the command is exit 5, never "unreachable"', async () => {
        const port = await closedPort();
        vi.stubEnv('STATE_DIR', emptyStateDir);
        vi.stubEnv('DROVER_URL', `http://127.0.0.1:${port}`);
        const r = await capture(['pause']);
        expect(r.code).toBe(5);
        expect(r.err).toMatch(/^drover: bus not running at /);
    });
});

// --- the argument scan --------------------------------------------------------

describe('drover read — the resolution order and the argument scan', () => {
    it('resolves the four rules in order, help first', () => {
        expect(parse(['--help'])).toEqual({ help: true });
        expect(parse(['status'])).toMatchObject({ verb: 'status', session: '', sawTarget: false });
        expect(parse(['here'])).toMatchObject({ verb: 'on', session: 'here', sawTarget: true });
        expect(parse(['on', 'x'])).toMatchObject({ verb: 'on', session: 'x', sawTarget: true });
        expect(parse(['off'])).toMatchObject({ verb: 'off', session: '', sawTarget: false });
        expect(parse(['some-session'])).toMatchObject({ verb: 'on', session: 'some-session', sawTarget: true });
        expect(parse([])).toMatchObject({ verb: 'status', timeout: 8 });
    });

    it('--session, --json and --timeout are read from anywhere in the line', () => {
        expect(parse(['--json', 'pause'])).toMatchObject({ verb: 'pause', asJson: true });
        expect(parse(['pause', '--json'])).toMatchObject({ verb: 'pause', asJson: true });
        expect(parse(['on', '--session', 'x'])).toMatchObject({ verb: 'on', session: 'x' });
        expect(parse(['--session=x', 'on'])).toMatchObject({ verb: 'on', session: 'x' });
        expect(parse(['--timeout', '30', 'pause'])).toMatchObject({ verb: 'pause', timeout: 30 });
        expect(parse(['pause', '--timeout=30'])).toMatchObject({ verb: 'pause', timeout: 30 });
    });

    it('a flag in the last position has no value to take, and says which flag', () => {
        // The shell's `[ $i -lt $argc ]`: by then `$1` is an argument already
        // rotated to the back, so "the value follows" and "the flag was last"
        // are different questions.
        expect(parse(['--session'])).toEqual({ code: 2, error: ['drover read: --session needs an id'] });
        expect(parse(['pause', '--session'])).toEqual({ code: 2, error: ['drover read: --session needs an id'] });
        expect(parse(['--timeout'])).toEqual({ code: 2, error: ['drover read: --timeout needs seconds'] });
        expect(parse(['pause', '--timeout'])).toEqual({ code: 2, error: ['drover read: --timeout needs seconds'] });
    });

    it('the timeout is whole seconds, clamped to 1..60', () => {
        expect(parse(['--timeout', '0'])).toMatchObject({ timeout: 1 });
        expect(parse(['--timeout', '1'])).toMatchObject({ timeout: 1 });
        expect(parse(['--timeout', '61'])).toMatchObject({ timeout: 60 });
        expect(parse(['--timeout', '600'])).toMatchObject({ timeout: 60 });
        for (const bad of ['', 'soon', '1.5', '-3', '8s']) {
            expect(parse(['--timeout', bad]), bad).toEqual({
                code: 2,
                error: [`drover read: --timeout takes whole seconds, not '${bad}'`],
            });
        }
    });

    it('an unknown option names itself, and so does an extra argument', () => {
        expect(parse(['--wat'])).toEqual({ code: 2, error: ["drover read: unknown option '--wat' (try: drover read --help)"] });
        expect(parse(['-x'])).toEqual({ code: 2, error: ["drover read: unknown option '-x' (try: drover read --help)"] });
        expect(parse(['pause', 'extra'])).toEqual({
            code: 2,
            error: ["drover read: too many arguments, starting at 'extra' (try: drover read --help)"],
        });
        expect(parse(['on', 'a', 'b'])).toEqual({
            code: 2,
            error: ["drover read: too many arguments, starting at 'b' (try: drover read --help)"],
        });
    });

    it('every verb that is not on or off refuses a target', () => {
        for (const verb of ['status', 'pause', 'resume']) {
            expect(parse([verb, '--session', 'x']), verb).toEqual({
                code: 2,
                error: [`drover read: \`${verb}\` acts on the voice, not on a session — the phone has one speaker`],
            });
        }
        expect(parse(['--session', 'x'])).toEqual({
            code: 2,
            error: ['drover read: `status` acts on the voice, not on a session — the phone has one speaker'],
        });
    });
});

// --- the two shell functions --------------------------------------------------

describe('drover read — ago (how stale an answer is, in words)', () => {
    it('is `just now` under two seconds', () => {
        expect(ago(0)).toBe('just now');
        expect(ago(1999)).toBe('just now');
    });

    it('is whole seconds under 90, then minutes, then hours', () => {
        expect(ago(2000)).toBe('2s ago');
        expect(ago(89_999)).toBe('89s ago');
        expect(ago(90_000)).toBe('1m ago');
        expect(ago(5_399_000)).toBe('89m ago');
        expect(ago(5_400_000)).toBe('1h ago');
        expect(ago(47 * 3_600_000)).toBe('47h ago');
    });
});

describe('drover read — print_state (the jq program, line for line)', () => {
    it('says so when the phone has never reported', () => {
        expect(printState({ reported: null, ageMs: null, stale: true })).toEqual(['reading   the phone has not reported yet']);
        expect(printState('not json')).toEqual(['reading   the phone has not reported yet']);
        expect(printState({})).toEqual(['reading   the phone has not reported yet']);
    });

    it('draws the whole picture for a phone that is reading', () => {
        expect(printState({ reported: phoneState(), ageMs: 0, stale: false })).toEqual([
            'reading   playing · cattle-drover (just now)',
            'sentence  The lane is green.',
            '',
            '  session   state      what it means',
            '  aaaaaaaa  reading    has the voice · cattle-drover',
            '  bbbbbbbb  yielded    on, waiting its turn · happy',
        ]);
    });

    it('OFF is its own line, with the switch that turns it back on', () => {
        expect(printState({ reported: offState(), ageMs: 125_000, stale: true })).toEqual([
            'reading   OFF on the phone (2m ago) — turn it on in Settings > Voice',
            '',
            'That is the last thing the phone said. It has not reported since.',
        ]);
    });

    it('names the session when there is no title, and `nothing` when there is neither', () => {
        const a = { ...phoneState(), title: null, sentence: null, sessions: [] };
        expect(printState({ reported: a, ageMs: 0, stale: false })).toEqual([
            'reading   playing · aaaaaaaa-1111-2222-3333-444444444444 (just now)',
        ]);
        const b = { ...a, sessionId: null };
        expect(printState({ reported: b, ageMs: 0, stale: false })).toEqual(['reading   playing · nothing (just now)']);
    });

    it('pads the state column to nine, and every DROVE-297 state has its sentence', () => {
        const rows = [
            { sessionId: 'r1111111-x', enabled: true, state: 'reading', title: null },
            { sessionId: 'p2222222-x', enabled: true, state: 'paused', title: null },
            { sessionId: 'y3333333-x', enabled: true, state: 'yielded', title: null },
            { sessionId: 'o4444444-x', enabled: false, state: 'off', title: null },
        ];
        expect(printState({ reported: { ...phoneState(), sentence: null, sessions: rows }, ageMs: 0, stale: false })).toEqual([
            'reading   playing · cattle-drover (just now)',
            '',
            '  session   state      what it means',
            '  r1111111  reading    has the voice',
            '  p2222222  paused     you are holding it',
            '  y3333333  yielded    on, waiting its turn',
            '  o4444444  off        reading off',
        ]);
    });

    it('a report with no sessions draws no table at all', () => {
        // Almost every session is off almost all the time, and a line saying so
        // for each of them says nothing.
        expect(printState({ reported: { ...phoneState(), sessions: [] }, ageMs: 0, stale: false })).toEqual([
            'reading   playing · cattle-drover (just now)',
            'sentence  The lane is green.',
        ]);
    });
});

// --- the shell verb, byte for byte --------------------------------------------
//
// Both verbs, against ONE loopback stub standing in for the bus and the phone.
// Not the real bus, not the real daemon and not a socket anybody else can
// reach: a server bound to 127.0.0.1 on an ephemeral port, torn down after.

const shellVerb = join(droverEnv().droverDir, 'libexec', 'drover-read');

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


interface Stub {
    server: Server;
    url: string;
    posts: string[];
}

function startStub(answer: (cmd: Record<string, unknown>) => Record<string, unknown>, reported: unknown): Promise<Stub> {
    const posts: string[] = [];
    const commands = new Map<string, Record<string, unknown>>();
    const reply = (res: ServerResponse, body: unknown): void => {
        const text = JSON.stringify(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(text);
    };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'POST') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                posts.push(body);
                const cmd = JSON.parse(body) as Record<string, unknown>;
                const id = 'rd-fixed';
                commands.set(id, { id, ...answer(cmd) });
                reply(res, { id, verb: cmd.verb, state: 'pending', ttlMs: cmd.ttlMs });
            });
            return;
        }
        if (url.pathname === '/v1/sessions') return reply(res, { sessions: SESSIONS });
        if (url.pathname === '/v1/reading') return reply(res, reported ? { reported, ageMs: 4000, stale: false } : { reported: null, ageMs: null, stale: true });
        const wait = url.pathname.match(/^\/v1\/reading\/commands\/([^/]+)\/wait$/);
        if (wait) return reply(res, commands.get(wait[1]) ?? { error: 'no such reading command' });
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

const haveJq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!existsSync(shellVerb) || !haveJq)('drover read — prints what the shell verb printed, byte for byte', () => {
    it('every verdict, every verb: same stdout, same stderr, same code, same wire bytes', async () => {
        const moods: { name: string; answer: (cmd: Record<string, unknown>) => Record<string, unknown>; reported: unknown }[] = [
            {
                name: 'applied',
                answer: (cmd) => ({ verb: cmd.verb, state: 'applied', reason: null, snapshot: applyVerb(phoneState(), cmd as { verb: string; sessionId?: string }) }),
                reported: null,
            },
            {
                name: 'refused',
                answer: (cmd) => ({ verb: cmd.verb, state: 'refused', reason: 'read aloud is off on the phone', snapshot: offState() }),
                reported: null,
            },
            {
                name: 'expired',
                answer: (cmd) => ({ verb: cmd.verb, state: 'expired', reason: 'the phone did not answer', snapshot: null }),
                reported: phoneState(),
            },
        ];
        const lines = [
            ['--timeout', '3'],
            ['status', '--timeout', '3'],
            ['pause', '--timeout', '3'],
            ['resume', '--timeout', '3'],
            ['on', 'aaaaaaaa', '--timeout', '3'],
            ['off', 'bbbbbbbb', '--timeout', '3'],
            ['pause', '--json', '--timeout', '3'],
            ['on', 'nope', '--timeout', '3'],
            ['on', 'cccccccc', '--timeout', '3'],
            ['pause', '--session', 'x'],
            ['--timeout', 'soon'],
            ['--wat'],
            ['pause', 'extra'],
            ['--help'],
        ];
        for (const mood of moods) {
            const stub = await startStub(mood.answer, mood.reported);
            try {
                const env = {
                    ...process.env,
                    STATE_DIR: emptyStateDir,
                    DROVER_URL: stub.url,
                    DROVER_READ_BY: 'cli',
                    TMUX_PANE: undefined,
                } as NodeJS.ProcessEnv;
                delete env.TMUX_PANE;
                refuseRealHappyHome(env, 'the shell verb spawn');
                for (const args of lines) {
                    const where = `${mood.name}: drover read ${args.join(' ')}`;
                    stub.posts.length = 0;
                    const shell = await spawnShell(shellVerb, args, env, emptyStateDir);
                    const shellPosts = [...stub.posts];
                    stub.posts.length = 0;
                    vi.stubEnv('STATE_DIR', emptyStateDir);
                    vi.stubEnv('DROVER_URL', stub.url);
                    const node = await capture(args, { DROVER_URL: stub.url, DROVER_READ_BY: 'cli' });
                    vi.unstubAllEnvs();
                    expect(node.out, `${where} (stdout)`).toBe(shell.stdout);
                    expect(node.err, `${where} (stderr)`).toBe(shell.stderr);
                    expect(node.code, `${where} (code)`).toBe(shell.status);
                    expect(stub.posts, `${where} (wire)`).toEqual(shellPosts);
                }
            } finally {
                await new Promise<void>((done) => stub.server.close(() => done()));
            }
        }
    }, 120_000);
});

// --- the guards, proven armed -------------------------------------------------

/** The innermost message of a failed import: vitest wraps a throwing mock factory. */
async function trapped(load: () => Promise<unknown>): Promise<string> {
    try {
        await load();
    } catch (e) {
        let err = e as { message?: string; cause?: unknown } | undefined;
        while (err && typeof err === 'object' && err.cause && typeof err.cause === 'object') err = err.cause as typeof err;
        return String(err?.message ?? e);
    }
    return '';
}

describe('drover read — the guards are armed', () => {
    it('the pin holds: this file runs under a throwaway HAPPY_HOME_DIR, not ~/.happy', () => {
        expect(process.env.HAPPY_HOME_DIR).toBe(happyHome);
        expect(happyHome).not.toBe(realHappyHome);
        expect(happyHome.startsWith(realHappyHome)).toBe(false);
    });

    it('the guard refuses the real ~/.happy, whether spelled out, as ~, or left unset', () => {
        expect(() => refuseRealHappyHome({}, 'unset')).toThrow(/resolves to the real/);
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: '~/.happy' }, 'tilde')).toThrow(/resolves to the real/);
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: join(homedir(), '.happy') }, 'spelled out')).toThrow(/resolves to the real/);
        expect(() => refuseRealHappyHome({ HAPPY_HOME_DIR: happyHome }, 'pinned')).not.toThrow();
    });

    it('importing the session machinery fails before it can read ~/.happy', async () => {
        expect(await trapped(() => import('../../configuration'))).toMatch(/configuration .* must not reach the session machinery/);
        expect(await trapped(() => import('../../persistence'))).toMatch(/persistence .* must not reach the session machinery/);
        expect(await trapped(() => import('../../api/api'))).toMatch(/api\/api .* must not reach the session machinery/);
        expect(await trapped(() => import('../../claude/runClaude'))).toMatch(/runClaude .* must not reach the session machinery/);
        expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
        expect(REGISTRATION_FILES.filter((f) => existsSync(join(happyHome, f)))).toEqual([]);
    });
});
