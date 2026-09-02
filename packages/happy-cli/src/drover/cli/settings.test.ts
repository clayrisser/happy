/**
 * The vitest twin of cattle-drover/tests/settings.bats (DROVE-315 wave 4).
 *
 * settings.bats is mostly about the BUS, because the store is what BASED-118
 * drives; its CLI half — the three tests that run `bin/drover settings` — is
 * here, plus everything the shell file does that no bats test reaches. Both
 * halves run against ONE fixture bus.
 *
 * THE FIXTURE BUS IS THE REAL STORE. `engine/settings.js` is imported from the
 * cattle-drover checkout and wrapped in the smallest HTTP server that mirrors
 * server.js's settingsRoute. That is the point of the verb: the store stays
 * there, one reader serves the terminal and the phone, and a differential
 * against a hand-written stub of the store would prove nothing about the
 * validation, the cascade or the mode macro. It listens on 127.0.0.1 on an
 * ephemeral port, is reachable from nowhere else, and is closed in afterAll.
 *
 * WHAT IS COMPARED. For every line: stdout, stderr, the exit code, and the
 * BYTES on the wire — method, path, Content-Type, X-Drover-By and body — for
 * every request each side made. The store is reset to the same seed before the
 * shell run and again before the node run, so both sides see the same bus.
 * Wire equality is what catches a port that renders correctly off a request
 * the shell never made.
 *
 * Then the bus-down case, DROVER_URL pointed at a port nothing listens on, for
 * bus_explain's sentences and exit 1 — the deliberate refusal to fall back to
 * the file when two writers would race.
 *
 * DROVE-336. Nothing here starts a session. HAPPY_HOME_DIR is pinned to a
 * throwaway before the first import, the session machinery is mocked to throw
 * on import, HOME is a mkdtemp, and the pinned home is asserted still empty in
 * afterAll. A bench that skipped this once registered seventy-eight real
 * sessions on Clay's phone.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadEngine } from './engine';
import { droverEnv } from './env';
import { droverVerbs } from './index';
import { mergedChains, printList, printModes, printShow, rotate, run, typedPatch } from './settings';

/**
 * A throwaway HAPPY_HOME_DIR and a throwaway state dir, pinned above every
 * import. vi.hoisted runs before the static imports, so DROVER_STATE_DIR is in
 * place before engine/settings.js is loaded — that module reads it once, at
 * load, and a store pointed at ~/.drover would be Clay's real settings.
 */
const { happyHome, realHappyHome, storeDir, emptyStateDir } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-happy-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-store-'));
    const emptyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-state-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    process.env.DROVER_STATE_DIR = storeDir;
    return { happyHome, realHappyHome, storeDir, emptyStateDir };
});

vi.mock('../../configuration', () => {
    throw new Error('settings.test: configuration was imported; this verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('settings.test: api/api was imported; this verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('settings.test: persistence was imported; this verb must not reach the session machinery');
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

beforeAll(() => {
    refuseRealHappyHome(process.env, 'settings.test');
    if (happyHomeOf(process.env) !== happyHome) {
        throw new Error(`settings.test: HAPPY_HOME_DIR moved off the pin (it is ${process.env.HAPPY_HOME_DIR}); refusing to run`);
    }
});

afterAll(() => {
    refuseRealHappyHome(process.env, 'settings.test (afterAll)');
    // Nothing here registered anything: the pinned home is as empty as mkdtemp
    // made it.
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    for (const dir of [happyHome, storeDir, emptyStateDir]) rmSync(dir, { recursive: true, force: true });
});

// --- the fixture bus ----------------------------------------------------------

const SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
/** A fixed stamp, so `last changed <local time>` is the same on both sides. */
const STAMP = 1756800000000;

/**
 * The store as both sides find it, before every single run. Chosen so all
 * three sources appear in one `show`: onLimit is the session's, onLimitTimeout
 * and announceHaptic are the machine's, onFamilyExhausted is built-in.
 */
function seed(): Record<string, unknown> {
    return {
        version: 1,
        defaults: {
            onLimitTimeout: 'stop',
            announceHaptic: false,
            mode: 'direct',
            modes: { driving: { announceVisual: false, announceHaptic: true, announceAudio: true, answerAudio: 'click' } },
        },
        sessions: {
            [SESSION]: {
                onLimit: 'auto',
                familyFallback: { fable: ['haiku'], opus: ['sonnet'] },
                updatedAt: STAMP,
                updatedBy: 'phone',
            },
            [OTHER]: { onLimit: 'prompt', updatedAt: STAMP, updatedBy: 'cli' },
        },
    };
}

interface SettingsEngine {
    SETTINGS_PATH: string;
    BUILT_IN_DEFAULTS: Record<string, unknown>;
    validSessionId(id: unknown): boolean;
    validate(patch: unknown): { error?: string; value?: Record<string, unknown> };
    defaults(): Record<string, unknown>;
    effective(id: string): Record<string, unknown>;
    read(): Record<string, unknown>;
    patchSession(id: string, patch: unknown, by: string): { error?: string };
    putSession(id: string, value: unknown, by: string): { error?: string };
    deleteSession(id: string): unknown;
    patchDefaults(patch: unknown, by: string): { error?: string };
}

/** One request as the bus saw it. Method, path, the two headers this verb sets, body. */
interface Wire {
    method: string;
    path: string;
    contentType: string | null;
    by: string | null;
    body: string;
}

interface Answer {
    status: number;
    body: unknown;
}

/**
 * server.js's settingsRoute, transcribed onto the same engine module the real
 * bus imports. Only the settings routes; anything else is the 404 the bus
 * gives.
 */
function route(engine: SettingsEngine, method: string, url: URL, raw: string, byHeader: string | null): Answer {
    const m = url.pathname.match(/^\/v1\/settings(?:\/(defaults|sessions))?(?:\/([^/]+))?$/);
    if (!m) return { status: 404, body: { error: 'not found' } };
    const sub = m[1] ?? null;
    const sessionId = m[2] ? decodeURIComponent(m[2]) : null;
    const by = url.searchParams.get('by') || byHeader || 'bus';

    let body: unknown = {};
    if (method !== 'GET' && method !== 'DELETE') {
        if (raw.length) {
            try {
                body = JSON.parse(raw);
            } catch {
                return { status: 400, body: { error: 'invalid JSON' } };
            }
        }
    }
    const store = engine.read();

    if (sub === null && method === 'GET') {
        return { status: 200, body: { ...store, path: engine.SETTINGS_PATH, builtIn: engine.BUILT_IN_DEFAULTS } };
    }
    if (sub === 'defaults' && method === 'GET') {
        return { status: 200, body: { defaults: engine.defaults(), builtIn: engine.BUILT_IN_DEFAULTS } };
    }
    if (sub === 'defaults' && (method === 'PATCH' || method === 'POST')) {
        const v = engine.validate(body);
        if (v.error) return { status: 400, body: { error: v.error } };
        const w = engine.patchDefaults(v.value, by);
        if (w.error) return { status: 400, body: { error: w.error } };
        return { status: 200, body: { defaults: engine.defaults(), builtIn: engine.BUILT_IN_DEFAULTS } };
    }
    if (sub === 'sessions' && sessionId === null && method === 'GET') {
        return { status: 200, body: { sessions: store.sessions, defaults: engine.defaults() } };
    }
    if (sub === 'sessions' && sessionId !== null) {
        if (!engine.validSessionId(sessionId)) {
            return { status: 400, body: { error: 'session id must be [A-Za-z0-9._:-], 1-128 chars' } };
        }
        if (method === 'GET') return { status: 200, body: { sessionId, ...engine.effective(sessionId) } };
        if (method === 'PATCH' || method === 'POST' || method === 'PUT') {
            const v = engine.validate(body);
            if (v.error) return { status: 400, body: { error: v.error } };
            const w = method === 'PUT'
                ? engine.putSession(sessionId, v.value, by)
                : engine.patchSession(sessionId, v.value, by);
            if (w.error) return { status: 400, body: { error: w.error } };
            return { status: 200, body: { sessionId, ...engine.effective(sessionId) } };
        }
        if (method === 'DELETE') {
            engine.deleteSession(sessionId);
            return { status: 200, body: { sessionId, ...engine.effective(sessionId) } };
        }
    }
    return { status: 404, body: { error: 'not found' } };
}

class Fixture {
    url = '';
    constructor(readonly engine: SettingsEngine, readonly server: Server, readonly wire: Wire[]) {}

    /** Back to the seed, so the shell run and the node run see one bus. */
    reset(): void {
        writeFileSync(this.engine.SETTINGS_PATH, JSON.stringify(seed(), null, 2) + '\n', { mode: 0o600 });
        this.wire.length = 0;
    }

    /** What has been asked since the last reset, and clear it. */
    take(): Wire[] {
        const seen = [...this.wire];
        this.wire.length = 0;
        return seen;
    }

    close(): Promise<void> {
        return new Promise((done) => this.server.close(() => done()));
    }
}

async function startFixture(): Promise<Fixture> {
    const engine = await loadEngine<SettingsEngine>('settings.js');
    if (resolve(engine.SETTINGS_PATH) !== resolve(join(storeDir, 'session-settings.json'))) {
        throw new Error(
            `settings.test: engine/settings.js resolved its store to ${engine.SETTINGS_PATH}, not the throwaway `
            + `${join(storeDir, 'session-settings.json')}. Refusing to run against a real settings file.`,
        );
    }
    const wire: Wire[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const by = req.headers['x-drover-by'];
            wire.push({
                method: req.method ?? '',
                path: url.pathname + url.search,
                contentType: (req.headers['content-type'] as string | undefined) ?? null,
                by: typeof by === 'string' ? by : null,
                body: raw,
            });
            let answer: Answer;
            try {
                answer = route(engine, req.method ?? 'GET', url, raw, typeof by === 'string' ? by : null);
            } catch (e) {
                answer = { status: 500, body: { error: String((e as Error).message ?? e) } };
            }
            res.writeHead(answer.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(answer.body));
        });
    });
    const fixture = new Fixture(engine, server, wire);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const addr = server.address();
    fixture.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    return fixture;
}

// --- running the two sides ----------------------------------------------------

const shellVerb = join(droverEnv().droverDir, 'libexec', 'drover-settings');
const haveJq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
const haveCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).status === 0;
const haveEngine = existsSync(join(droverEnv().droverDir, 'engine', 'settings.js'));

/**
 * The env both sides get. CLAUDE_CODE_SESSION_ID is DELETED unless the case
 * wants it: this suite runs inside a drover session, and inheriting Clay's own
 * id would make `drover settings show` read a session nobody asked about.
 *
 * HOME is left alone, deliberately. asdf resolves `jq` through
 * `$HOME/.tool-versions`, so a throwaway HOME makes the SHELL side die with
 * "No version is set for command jq" and the differential compares two errors
 * instead of two answers. What has to be a throwaway is HAPPY_HOME_DIR, and
 * that is pinned above every import and asserted still empty in afterAll;
 * STATE_DIR is a throwaway too, so no local.env can move DROVER_URL off the
 * fixture.
 */
function busEnv(url: string, sessionId: string | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        STATE_DIR: emptyStateDir,
        DROVER_URL: url,
    };
    delete env.CLAUDE_CODE_SESSION_ID;
    if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId;
    return env;
}

/**
 * The shell verb, run ASYNCHRONOUSLY. spawnSync would block this process's
 * event loop, and the fixture bus lives in this process — curl would connect,
 * wait its ten seconds and report a bus that is "up but slow".
 */
function spawnShell(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
    refuseRealHappyHome(env, 'the shell verb spawn');
    return new Promise((done, fail) => {
        const child = spawn(shellVerb, args, { env, cwd: emptyStateDir, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('error', fail);
        child.stdin.end('');
        child.on('close', (status) => done({ status, stdout, stderr }));
    });
}

interface Captured {
    code: number;
    out: string;
    err: string;
}

async function capture(args: string[], env: NodeJS.ProcessEnv): Promise<Captured> {
    refuseRealHappyHome(process.env, 'capture');
    refuseRealHappyHome(env, 'capture (the verb env)');
    const o: string[] = [];
    const e: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (o.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (e.push(String(c)), true));
    try {
        const code = await run(args, { env });
        return { code, out: o.join(''), err: e.join('') };
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

// --- the lines both sides are asked --------------------------------------------

interface Line {
    args: string[];
    /** What $CLAUDE_CODE_SESSION_ID is, or null for a shell with none. */
    inSession?: string | null;
}

const MODE_ROW = '{"announceVisual":false,"announceHaptic":true,"announceAudio":true,"answerAudio":"click"}';

const LINES: Line[] = [
    // help, three spellings, and the load-time rule: no bus call at all
    { args: ['--help'] },
    { args: ['-h'] },
    { args: ['help'] },
    { args: ['--json', '--help'] },

    // show, and the argv rotate around it
    { args: [] },
    { args: ['show'] },
    { args: ['--json'] },
    { args: ['show', '--json'] },
    { args: ['--session', SESSION], inSession: null },
    { args: [`--session=${SESSION}`, 'show'], inSession: null },
    { args: ['show', `--session=${OTHER}`] },
    { args: ['--json', 'show', '--session', OTHER] },
    // `--session` LAST is the flag with no value, whatever got rotated behind it
    { args: ['show', '--session'] },
    { args: ['--session'] },
    { args: ['--help', '--session'] },
    // `--session` takes the next word even when the next word is a verb
    { args: ['--session', 'set', 'onLimit', 'auto'] },
    // no --session and no CLAUDE_CODE_SESSION_ID: the three-line complaint
    { args: ['show'], inSession: null },
    { args: ['clear'], inSession: null },
    { args: ['fallback', 'fable', 'opus'], inSession: null },
    // a session id the bus will not have: GET answers 400 and print_show
    // renders the null document rather than dying
    { args: ['show', '--session', 'bad+id'] },

    // set — the types, enforced before the bus is called
    { args: ['set', 'onLimit', 'auto'] },
    { args: ['set', 'onLimit', 'maybe'] },
    { args: ['set', 'onlimit', 'auto'] },
    { args: ['set', 'onLimitPromptTtlMs', 'abc'] },
    { args: ['set', 'onLimitPromptTtlMs', ''] },
    { args: ['set', 'onLimitPromptTtlMs', '90000'] },
    { args: ['set', 'familyFallback', 'not json'] },
    { args: ['set', 'familyFallback', 'null'] },
    { args: ['set', 'familyFallback', '{"fable":["opus","sonnet"]}'] },
    { args: ['set', 'announceAudio', 'yes'] },
    { args: ['set', 'announceAudio', 'off'] },
    { args: ['set', 'announceAudio', 'nope'] },
    { args: ['set', 'announceVisual', '0'] },
    { args: ['set', 'announceHaptic', '1'] },
    { args: ['set', 'modes', 'nope'] },
    { args: ['set', 'modes', '[]'] },
    { args: ['set', 'answerAudio', 'speech'] },
    { args: ['set', 'mode', 'none'] },
    { args: ['set'] },
    { args: ['set', 'onLimit'] },
    { args: ['set', 'onLimit', 'auto', '--session', 'bad+id'] },

    // unset, clear
    { args: ['unset', 'onLimit'] },
    { args: ['unset', 'onFamilyExhausted'] },
    { args: ['unset'] },
    { args: ['clear'] },
    { args: ['clear', '--session', OTHER] },

    // list
    { args: ['list'] },
    { args: ['list', '--json'] },

    // defaults
    { args: ['defaults'] },
    { args: ['defaults', '--json'] },
    { args: ['defaults', 'show'] },
    { args: ['defaults', 'set', 'onLimit', 'auto'] },
    { args: ['defaults', 'set', 'onLimitPromptTtlMs', 'abc'] },
    { args: ['defaults', 'set', 'announceAudio', 'true'] },
    { args: ['defaults', 'set'] },
    { args: ['defaults', 'set', 'onLimit'] },
    { args: ['defaults', 'wat'] },

    // mode
    { args: ['mode'] },
    { args: ['mode', '--json'] },
    { args: ['mode', 'driving'] },
    { args: ['mode', 'driving', '--session', SESSION] },
    { args: ['mode', 'none'] },
    { args: ['mode', 'none', '--session', SESSION] },
    { args: ['mode', 'nosuch'] },
    { args: ['mode', 'save', 'quiet', '{"announceVisual":false,"announceHaptic":false,"announceAudio":false,"answerAudio":"off"}'] },
    { args: ['mode', 'save', 'driving', MODE_ROW] },
    { args: ['mode', 'save', 'driving'] },
    { args: ['mode', 'save'] },
    { args: ['mode', 'save', 'driving', 'nope'] },
    { args: ['mode', 'save', 'driving', '[]'] },

    // fallback — merged onto the EFFECTIVE map, not the session's overrides
    { args: ['fallback', 'fable', 'haiku'] },
    { args: ['fallback', 'fable', 'none'] },
    { args: ['fallback', 'mythos', ' opus , sonnet '] },
    { args: ['fallback', 'fable', ''] },
    { args: ['fallback', 'fable'] },
    { args: ['fallback'] },

    // and the words this verb does not know
    { args: ['wat'] },
    { args: ['--json', 'wat'] },
    { args: ['Set', 'onLimit', 'auto'] },
];

describe.skipIf(!existsSync(shellVerb) || !haveJq || !haveCurl || !haveEngine)(
    'drover settings — prints what the shell verb printed, byte for byte, off the same wire',
    () => {
        let fixture: Fixture;

        beforeAll(async () => {
            fixture = await startFixture();
        });

        afterAll(async () => {
            if (fixture) await fixture.close();
        });

        it('every branch: same stdout, same stderr, same code, same requests', async () => {
            for (const line of LINES) {
                const where = `drover settings ${line.args.join(' ')}${line.inSession === null ? ' (no CLAUDE_CODE_SESSION_ID)' : ''}`;
                const env = busEnv(fixture.url, line.inSession === undefined ? SESSION : line.inSession);

                fixture.reset();
                const shell = await spawnShell(line.args, env);
                const shellWire = fixture.take();

                fixture.reset();
                const node = await capture(line.args, env);
                const nodeWire = fixture.take();

                expect(node.out, `${where} (stdout)`).toBe(shell.stdout);
                expect(node.err, `${where} (stderr)`).toBe(shell.stderr);
                expect(node.code, `${where} (exit code)`).toBe(shell.status);
                expect(nodeWire, `${where} (wire)`).toEqual(shellWire);
            }
        }, 300_000);

        // Not a tautology of two empty answers: these are the sentences and the
        // requests that must really have been there.
        it('the compared bytes are load-bearing, not two silences', async () => {
            const env = busEnv(fixture.url, SESSION);

            fixture.reset();
            const shown = await capture(['show'], env);
            expect(shown.code).toBe(0);
            // The value AND the layer it came from, which is the whole point.
            expect(shown.out).toMatch(/^ {2}onLimit {14}auto {3}\(session\)$/m);
            expect(shown.out).toMatch(/^ {2}onLimitTimeout {7}stop {3}\(machine default\)$/m);
            expect(shown.out).toMatch(/^ {2}onFamilyExhausted {4}flip-then-downgrade {3}\(built-in\)$/m);
            expect(shown.out).toMatch(/^ {2}familyFallback {7}fable -> haiku; opus -> sonnet {3}\(session\)$/m);
            expect(shown.out).toContain('  delivery: announce visual · answer visual');
            expect(shown.out).toContain(' by phone');

            // A real boolean on the wire, never the string "false" (DROVE-72).
            fixture.reset();
            const set = await capture(['set', 'announceVisual', 'off'], env);
            expect(set.code).toBe(0);
            expect(set.out).toBe('announceVisual = false for this session\n');
            const wire = fixture.take();
            expect(wire).toEqual([{
                method: 'PATCH',
                path: `/v1/settings/sessions/${SESSION}`,
                contentType: 'application/json',
                by: 'cli',
                body: '{"announceVisual":false}',
            }]);

            // A refused value ABORTS: exit 2, and nothing on the wire at all.
            fixture.reset();
            const bad = await capture(['set', 'onLimitPromptTtlMs', 'abc'], env);
            expect(bad.code).toBe(2);
            expect(bad.err).toContain('whole number of milliseconds');
            expect(fixture.take()).toEqual([]);

            // An unknown key is refused by the bus, not swallowed.
            fixture.reset();
            const typo = await capture(['set', 'onlimit', 'auto'], env);
            expect(typo.code).toBe(1);
            expect(typo.err).toMatch(/^drover settings: unknown setting 'onlimit'/);

            // The fallback edit keeps the families it inherited.
            fixture.reset();
            const chain = await capture(['fallback', 'fable', 'sonnet'], env);
            expect(chain.code).toBe(0);
            expect(chain.out).toBe('familyFallback = fable -> sonnet; opus -> sonnet\n');
        });

        it('--help touches no bus at all', async () => {
            const env = busEnv(fixture.url, SESSION);
            fixture.reset();
            const help = await capture(['--help'], env);
            expect(help.code).toBe(0);
            expect(help.out).toContain('drover settings — the per-session flip policy');
            expect(fixture.take()).toEqual([]);
        });
    },
);

// --- the bus down -------------------------------------------------------------

describe.skipIf(!existsSync(shellVerb) || !haveJq || !haveCurl || !haveEngine)('drover settings — when the bus is down it FAILS, it does not fall back', () => {
    it('every path says bus_explain\'s sentences and exits 1', async () => {
        const port = await closedPort();
        const env = busEnv(`http://127.0.0.1:${port}`, SESSION);
        const paths: string[][] = [
            ['show'],
            ['list'],
            ['defaults'],
            ['defaults', 'set', 'onLimit', 'auto'],
            ['set', 'onLimit', 'auto'],
            ['unset', 'onLimit'],
            ['clear'],
            ['mode'],
            ['mode', 'direct'],
            ['mode', 'direct', '--session', SESSION],
            ['mode', 'save', 'quiet', '{"announceVisual":false,"announceHaptic":false,"announceAudio":false,"answerAudio":"off"}'],
            ['fallback', 'fable', 'opus'],
        ];
        for (const args of paths) {
            const where = `drover settings ${args.join(' ')} (bus down)`;
            const shell = await spawnShell(args, env);
            const node = await capture(args, env);
            expect(node.out, `${where} (stdout)`).toBe(shell.stdout);
            expect(node.err, `${where} (stderr)`).toBe(shell.stderr);
            expect(node.code, `${where} (exit code)`).toBe(shell.status);
            // The sentence that names the fix, not "bus unreachable" (BASED-110).
            expect(node.code, where).toBe(1);
            expect(node.err, where).toContain('start it with: drover bus');
        }
    }, 120_000);
});

// --- the pieces, without a shell ----------------------------------------------

describe('drover settings — the argv rotate', () => {
    it('takes --session and --json from anywhere and leaves the order alone', () => {
        expect(rotate(['set', '--json', 'onLimit', '--session', 'abc', 'auto'])).toEqual({
            session: 'abc',
            asJson: true,
            rest: ['set', 'onLimit', 'auto'],
        });
        expect(rotate([`--session=${SESSION}`, 'show'])).toEqual({ session: SESSION, asJson: false, rest: ['show'] });
        expect(rotate([])).toEqual({ session: '', asJson: false, rest: [] });
    });

    it('--session LAST is the flag with no value, not a session called `show`', () => {
        // `[ "$i" -lt "$argc" ]` is the whole trick: by then $1 may be an
        // argument already rotated to the back.
        expect(rotate(['show', '--session'])).toEqual({ error: ['drover settings: --session needs an id'], code: 2 });
        expect(rotate(['--session'])).toEqual({ error: ['drover settings: --session needs an id'], code: 2 });
    });

    it('--session takes the next word even when the next word is a verb', () => {
        expect(rotate(['--session', 'set', 'onLimit', 'auto'])).toEqual({
            session: 'set',
            asJson: false,
            rest: ['onLimit', 'auto'],
        });
    });
});

describe('drover settings — typed_patch types the value BEFORE the bus is called', () => {
    it('onLimitPromptTtlMs is a whole number or nothing at all', () => {
        expect(typedPatch('onLimitPromptTtlMs', '90000')).toEqual({ patch: { onLimitPromptTtlMs: 90000 } });
        expect(typedPatch('onLimitPromptTtlMs', 'abc')).toEqual({
            error: ['drover settings: onLimitPromptTtlMs must be a whole number of milliseconds'],
        });
        expect(typedPatch('onLimitPromptTtlMs', '')).toEqual({
            error: ['drover settings: onLimitPromptTtlMs must be a whole number of milliseconds'],
        });
    });

    it('the three announce toggles go on the wire as real BOOLEANS', () => {
        // The string "false" is truthy to every reader; that is the bug.
        for (const yes of ['true', 'on', 'yes', '1']) {
            expect(typedPatch('announceVisual', yes)).toEqual({ patch: { announceVisual: true } });
        }
        for (const no of ['false', 'off', 'no', '0']) {
            expect(typedPatch('announceHaptic', no)).toEqual({ patch: { announceHaptic: false } });
        }
        expect(typedPatch('announceAudio', 'maybe')).toEqual({ error: ['drover settings: announceAudio takes true or false'] });
    });

    it('mode none and mode null send a JSON null, and a name sends the name', () => {
        expect(typedPatch('mode', 'none')).toEqual({ patch: { mode: null } });
        expect(typedPatch('mode', 'null')).toEqual({ patch: { mode: null } });
        expect(typedPatch('mode', 'driving')).toEqual({ patch: { mode: 'driving' } });
    });

    it('familyFallback and modes take JSON, and say what to type instead', () => {
        expect(typedPatch('familyFallback', '{"fable":["opus"]}')).toEqual({ patch: { familyFallback: { fable: ['opus'] } } });
        // `jq -e .` exits 1 on null and on false as well as on bad JSON.
        for (const bad of ['not json', 'null', 'false']) {
            expect(typedPatch('familyFallback', bad)).toEqual({
                error: [
                    'drover settings: familyFallback takes JSON — or use:',
                    '  drover settings fallback <family> <f2,f3|none>',
                ],
            });
        }
        expect(typedPatch('modes', '[]')).toEqual({
            error: [
                'drover settings: modes takes a JSON object of name -> row — or use:',
                '  drover settings mode save <name> <json>',
            ],
        });
        expect(typedPatch('onLimit', 'auto')).toEqual({ patch: { onLimit: 'auto' } });
    });

    it('a refused value has no patch to send, which is the whole fix', () => {
        // The shell posted an EMPTY body because `exit 2` inside `$(...)` kills
        // only the subshell. Here the union has no member that is both.
        const refused = typedPatch('announceAudio', 'sometimes');
        expect('patch' in refused).toBe(false);
        expect('error' in refused).toBe(true);
    });
});

describe('drover settings — the jq programs', () => {
    const doc = {
        effective: {
            onLimit: 'auto',
            onLimitTimeout: 'stop',
            onLimitPromptTtlMs: 600000,
            onFamilyExhausted: 'flip-then-downgrade',
            familyFallback: { fable: ['haiku'], opus: ['sonnet'] },
            announceVisual: true,
            announceHaptic: false,
            announceAudio: true,
            answerAudio: 'click',
            mode: null,
            modes: { driving: {}, direct: {} },
        },
        overrides: { onLimit: 'auto', familyFallback: { fable: ['haiku'] } },
        machine: { onLimitTimeout: 'stop', announceHaptic: false },
        updatedAt: STAMP,
        updatedBy: 'phone',
    };

    it('prints the effective value with the layer that won beside it', () => {
        const lines = printShow(doc, SESSION);
        expect(lines[0]).toBe(`session ${SESSION}`);
        expect(lines[2]).toBe('  onLimit              auto   (session)');
        expect(lines[3]).toBe('  onLimitTimeout       stop   (machine default)');
        expect(lines[5]).toBe('  onFamilyExhausted    flip-then-downgrade   (built-in)');
        expect(lines[6]).toBe('  familyFallback       fable -> haiku; opus -> sonnet   (session)');
        expect(lines[8]).toBe('  delivery: announce visual,audio · answer visual,audio (click)');
        // `keys` SORTS, so the modes list is alphabetical however it was stored.
        expect(lines).toContain('  modes                direct, driving');
        expect(lines[lines.length - 1]).toMatch(/^ {2}last changed \d{4}-\d{2}-\d{2} \d{2}:\d{2} by phone$/);
    });

    it('with every announce off it still says the terminal is reachable', () => {
        const quiet = { ...doc, effective: { ...doc.effective, announceVisual: false, announceAudio: false, answerAudio: 'off' } };
        expect(printShow(quiet, SESSION)).toContain('  delivery: announce none (terminal only) · answer visual');
    });

    it('a session with no override at all still renders, and says built-in', () => {
        // The bus's 400 for a bad id has neither .effective nor .overrides, and
        // jq 1.7's `null | has(k)` is false rather than an error.
        const lines = printShow({ error: 'session id must be [A-Za-z0-9._:-], 1-128 chars' }, 'bad+id');
        expect(lines[0]).toBe('session bad+id');
        expect(lines[2]).toBe('  onLimit              null   (built-in)');
        expect(lines.some((l) => l.includes('last changed'))).toBe(false);
    });

    it('list says so when nothing is customised, and drops the stamps when something is', () => {
        expect(printList({ sessions: {} })).toEqual(['no session has an override; every session is on the defaults']);
        expect(printList({
            sessions: { [SESSION]: { onLimit: 'auto', familyFallback: { fable: ['haiku'] }, updatedAt: STAMP, updatedBy: 'cli' } },
        })).toEqual([`  ${SESSION}  onLimit=auto familyFallback={"fable":["haiku"]}`]);
    });

    it('the mode table reads the row, and names the machine mode', () => {
        expect(printModes({
            defaults: {
                mode: 'direct',
                modes: {
                    direct: { announceVisual: true, announceHaptic: false, announceAudio: false, answerAudio: 'off' },
                    'hands-free-voice': { announceVisual: false, announceHaptic: false, announceAudio: true, answerAudio: 'speech' },
                },
            },
        })).toEqual([
            'machine mode: direct',
            '',
            '  direct               announce visual · answer visual',
            '  hands-free-voice     announce audio · answer visual,audio (speech)',
        ]);
        expect(printModes({ defaults: { mode: null, modes: {} } })[0]).toBe('machine mode: none (set by hand)');
    });

    it('a fallback edit merges onto the EFFECTIVE map, keeping inherited families', () => {
        const effective = { effective: { familyFallback: { fable: ['opus', 'sonnet'], mythos: ['opus', 'sonnet'] } } };
        expect(mergedChains(effective, 'fable', 'haiku')).toEqual({ fable: ['haiku'], mythos: ['opus', 'sonnet'] });
        expect(mergedChains(effective, 'fable', 'none')).toEqual({ mythos: ['opus', 'sonnet'] });
        expect(mergedChains(effective, 'fable', ' opus , sonnet ')).toEqual({ fable: ['opus', 'sonnet'], mythos: ['opus', 'sonnet'] });
        expect(mergedChains(effective, 'fable', '')).toEqual({ fable: [], mythos: ['opus', 'sonnet'] });
    });
});

describe('drover settings — the verb is registered, lazily', () => {
    it('index.ts carries the row, and loads it with a dynamic import', async () => {
        const row = droverVerbs.find((v) => v.name === 'settings');
        expect(row).toBeDefined();
        expect(row?.summary).toContain('per-session flip policy');
        const mod = await row?.load();
        expect(typeof mod?.run).toBe('function');
    });
});

describe('drover settings — the guards are armed', () => {
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

    it.skipIf(!haveEngine)('the settings store under test is the throwaway one, never ~/.drover', async () => {
        const engine = await loadEngine<SettingsEngine>('settings.js');
        expect(engine.SETTINGS_PATH).toBe(join(storeDir, 'session-settings.json'));
    });
});
