/**
 * The vitest twin of the `drover sessions` bats (DROVE-315).
 *
 * The spec is spread over cattle-drover/tests: sessions-scan.bats (the three
 * bus failures, three sentences), surface.bats (the table — one session is one
 * row, at any width), fixture-store.bats (the sweep and the hidden rows) and
 * reclaim.bats (the `reclaim` noun). Those stay green until the shell file
 * leaves; this file is the same assertions against the node verb, plus one
 * DIFFERENTIAL smoke test that runs the SHELL verb and the node verb against
 * the same fixture body on the same loopback port and compares stdout byte for
 * byte — the jq program in libexec/drover-sessions is the renderer's spec, and
 * that test is the mechanical check that the port did not drift a character.
 *
 * Nothing here reaches the real bus, the real ~/.claude or ~/.happy.
 * HAPPY_HOME_DIR is pinned to a throwaway before the first import, the modules
 * a session registration goes through are mocked to THROW on import, and the
 * SessionsProbe handed to every render test throws if anything asks the
 * terminal how wide it is. The pin below says which night made that necessary
 * (DROVE-336).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';
import {
    duKb,
    fixtureCwd,
    fixtureProjectName,
    jqJson,
    parseArgs,
    renderClones,
    renderStaleNote,
    renderTable,
    resolveWidth,
    run,
    sweepPlan,
    transcriptCwd,
    type SessionsProbe,
} from './sessions';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import. On 2026-09-01 a bench
 * in this tree spawned the entry with no HAPPY_HOME_DIR set, so each spawn read
 * the real ~/.happy/access.key and registered a real session on Clay's phone —
 * seventy-eight of them. This verb never touches ~/.happy and this file never
 * spawns the entry, but the leak came from the same tree and nothing in it said
 * no. This does.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('sessions.test: configuration (the ~/.happy reader) was imported; the verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('sessions.test: persistence (access.key, settings) was imported; the verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('sessions.test: api/api (session registration) was imported; the verb must not reach the session machinery');
});
vi.mock('../../claude/runClaude', () => {
    throw new Error('sessions.test: claude/runClaude was imported; the verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
}

function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === resolve(realHappyHome)) {
        throw new Error(
            `${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome} (it is ${env.HAPPY_HOME_DIR ?? 'unset'}). Refusing.`,
        );
    }
}

beforeAll(() => {
    refuseRealHappyHome(process.env, 'sessions.test');
});

afterAll(() => {
    refuseRealHappyHome(process.env, 'sessions.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

/** A probe that proves the terminal is never consulted. */
const noProbe: SessionsProbe = {
    stdoutIsTty: () => {
        throw new Error('[ -t 1 ] was asked');
    },
    tputCols: () => {
        throw new Error('tput was asked');
    },
};

/** An empty STATE_DIR, so no local.env on this machine can redirect the verb. */
const emptyStateDir = mkdtempSync(join(tmpdir(), 'drover-sessions-test-'));

interface Captured {
    code: number;
    out: string;
    err: string;
    lines: string[];
}

async function capture(args: string[], env: Env, probe: SessionsProbe = noProbe): Promise<Captured> {
    refuseRealHappyHome(process.env, 'capture');
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
        const code = await run(args, { env: { STATE_DIR: emptyStateDir, ...env }, probe, home: env.HOME ?? '/Users/x' });
        const text = out.join('');
        return { code, out: text, err: err.join(''), lines: text.split('\n').filter((l) => l !== '') };
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
}

/** One fixed body on an ephemeral loopback port, the way surface.bats serves one. */
async function fakeBus(body: string): Promise<{ url: string; close: () => Promise<void> }> {
    const srv = createServer((_q, r) => {
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end(body);
    });
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => srv.close(() => res())),
    };
}

/** A loopback port that was bound and freed: connecting to it REFUSES rather than hangs. */
async function closedPort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise<void>((res) => srv.close(() => res()));
    return port;
}

// The row Clay reported, in its original shape: a 16-character account name in
// an 8-wide column, a title with a newline, and a cwd longer than any terminal.
const HOSTILE = JSON.stringify({
    stale: false,
    scannedAt: 1,
    sessions: [
        {
            id: 'aaaaaaaa-0000-0000-0000-000000000000',
            state: 'live',
            account: 'risserproperties',
            pane: '%43',
            paneAmbiguous: false,
            cwd: '/Users/x/Projects/evil\nnewline\tdir',
            title: 'a title\nwith a newline',
            subagents: [],
        },
        {
            id: 'bbbbbbbb-0000-0000-0000-000000000000',
            state: 'idle',
            account: null,
            pane: null,
            paneAmbiguous: true,
            cwd: '/Users/x/short',
            title: null,
            subagentsPending: true,
        },
        {
            id: 'cccccccc-0000-0000-0000-000000000000',
            state: 'ended',
            account: 'bitspur.com',
            pane: null,
            paneAmbiguous: false,
            cwd: '/Users/x/aaaaaaaaaa/bbbbbbbbbb/cccccccccc/dddddddddd/eeeeeeeeee/ffffffffff/gggggggggg/hhhhhhhhhh/iiiiiiiiii',
            title: 'an extremely long session title that will not fit',
            subagentsTruncated: 821,
            subagentsTotal: 1021,
            subagents: [],
        },
    ],
});

const FIXTURE_ROWS = JSON.stringify({
    stale: false,
    scannedAt: 1,
    sessions: [
        { id: '11111111-0000-0000-0000-000000000000', state: 'live', account: 'a', cwd: '/Users/x/Projects/real', title: 'real one', subagents: [] },
        { id: '22222222-0000-0000-0000-000000000000', state: 'idle', account: null, cwd: '/private/tmp/happy-testing-ground-0a1b2c3d', title: 'Say exactly ready', subagents: [] },
        { id: '33333333-0000-0000-0000-000000000000', state: 'idle', account: null, cwd: '/Users/x/happy/environments/data/envs/bold-forest/project', title: 'Count slowly from 1 to 40', subagents: [] },
        { id: '55555555-0000-0000-0000-000000000000', state: 'idle', account: 'b', cwd: '/Users/x/Projects/other', title: 'another real one', subagents: [] },
        { id: '66666666-0000-0000-0000-000000000000', state: 'live', account: 'a', cwd: '/Users/x/.cache/drover-worktrees/DROVE-81', title: 'a real session in a worktree', subagents: [] },
        { id: '77777777-0000-0000-0000-000000000000', state: 'idle', account: null, cwd: '/private/tmp/happy-claude-goal-fixtures', title: null, subagents: [] },
        { id: '88888888-0000-0000-0000-000000000000', state: 'ended', account: null, cwd: '/private/tmp/drover-trust-test', title: null, subagents: [] },
    ],
});

// --- the flag loop (surface.bats) ------------------------------------------------

describe('drover sessions — the flag loop is a loop', () => {
    it('takes --all and --json in either order', () => {
        expect(parseArgs(['--all', '--json'])).toEqual({ asJson: true, limit: '200', sweep: false, sweepApply: false });
        expect(parseArgs(['--json', '--all'])).toEqual({ asJson: true, limit: '200', sweep: false, sweepApply: false });
    });

    it('refuses an unknown argument rather than ignoring it', async () => {
        const r = await capture(['--nope'], {});
        expect(r.code).toBe(2);
        expect(r.err).toBe("drover sessions: unknown argument '--nope' (try --all, --json, --sweep-fixtures or --help)\n");
        expect(r.out).toBe('');
    });

    it('--apply without --sweep-fixtures is refused', async () => {
        const r = await capture(['--apply'], {});
        expect(r.code).toBe(2);
        expect(r.err).toBe('drover sessions: --apply only means something with --sweep-fixtures\n');
    });

    it('help answers before anything is looked at', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        for (const flag of ['--help', '-h']) {
            const r = await capture([flag], {});
            expect(r.code, flag).toBe(0);
            expect(r.err, flag).toBe('');
            expect(r.out, flag).toMatch(/^drover sessions — what is running, where, and on which account\.\n/);
            expect(r.out, flag).toContain('ONE SESSION IS ONE ROW');
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// --- the bus, three failures, three sentences (sessions-scan.bats) ---------------

describe('drover sessions — three bus outcomes, three answers', () => {
    it("refused: 'not running', and the start command — the only case that earns it", async () => {
        const port = await closedPort();
        const url = `http://127.0.0.1:${port}`;
        const r = await capture([], { DROVER_URL: url, DROVER_SESSIONS_TIMEOUT_S: '1' });
        expect(r.code).toBe(1);
        expect(r.err).toContain(`bus not running at ${url}`);
        expect(r.err).toContain('start it with: drover bus');
        expect(r.err).not.toContain('up but slow');
        expect(r.err).not.toContain('empty body');
        expect(r.err).not.toContain('unreachable');
    });

    it('empty 200: a bus bug, named as one — not a connection problem', async () => {
        const bus = await fakeBus('');
        try {
            const r = await capture([], { DROVER_URL: bus.url, DROVER_SESSIONS_TIMEOUT_S: '5', STATE_DIR: '/tmp/sd' });
            expect(r.code).toBe(1);
            expect(r.err).toContain('answered with an empty body');
            expect(r.err).toContain('not a connection problem');
            expect(r.err).toContain('Check its log: /tmp/sd/logs/bus.log');
            expect(r.err).not.toContain('not running');
            expect(r.err).not.toContain('up but slow');
            expect(r.err).not.toContain('unreachable');
        } finally {
            await bus.close();
        }
    });

    it('a body that is not the expected JSON says so, with the first 200 bytes of it', async () => {
        const bus = await fakeBus('<html>not json</html>');
        try {
            const r = await capture([], { DROVER_URL: bus.url, DROVER_SESSIONS_TIMEOUT_S: '5' });
            expect(r.code).toBe(1);
            expect(r.err).toBe(
                'drover sessions: the bus answered but the body is not the expected JSON:\n  <html>not json</html>\n',
            );
        } finally {
            await bus.close();
        }
    });
});

// --- the table (surface.bats) -----------------------------------------------------

describe('drover sessions — one session is one row', () => {
    const rows = (JSON.parse(HOSTILE) as { sessions: Record<string, unknown>[] }).sessions;

    it('three sessions render as exactly three rows plus a header', () => {
        expect(renderTable(rows, 100, '/Users/x')).toHaveLength(4);
    });

    it('no row is wider than the terminal, whatever is in it', () => {
        for (const line of renderTable(rows, 100, '/Users/x')) {
            expect(Array.from(line).length, line).toBeLessThanOrEqual(100);
        }
    });

    it('control characters become the middle dot rather than a second row', () => {
        const table = renderTable(rows, 100, '/Users/x').join('\n');
        expect(table).not.toContain('\t');
        expect(table.split('\n')).toHaveLength(4);
        expect(table).toContain('·');
    });

    it('an over-wide account name does not shift the columns after it', () => {
        const two = [
            { id: 'aaaaaaaa-0', state: 'live', account: 'a', cwd: '/tmp/one', title: null, subagents: [] },
            { id: 'bbbbbbbb-0', state: 'idle', account: 'risserproperties', cwd: '/tmp/two', title: null, subagents: [] },
        ];
        const table = renderTable(two, 100, '/Users/x');
        const at = table[0].indexOf('CWD');
        for (const line of table.slice(1)) {
            expect(line[at - 1], line).toBe(' ');
            expect(line[at], line).toBe('/');
        }
    });

    it('the title is a column with a header, not an unlabelled second line', () => {
        expect(renderTable(rows, 100, '/Users/x')[0]).toContain('TITLE');
    });

    it('? is a real unknown and N+ is a real cap, and ?pane is neither a pane nor none', () => {
        const table = renderTable(rows, 100, '/Users/x').join('\n');
        expect(table).toContain('?pane');
        expect(table).toContain('0+');
    });

    it('the permission mode has its own column, in the pane\'s own words (DROVE-36)', () => {
        const modes = [
            { id: 'a', state: 'live', account: 'a', pane: '%43', cwd: '/tmp/one', title: null, subagents: [], permissionMode: 'bypassPermissions' },
            { id: 'b', state: 'live', account: 'a', pane: '%44', cwd: '/tmp/two', title: null, subagents: [], permissionMode: 'default' },
            { id: 'c', state: 'live', account: 'a', pane: '%45', cwd: '/tmp/three', title: null, subagents: [], permissionMode: 'acceptEdits' },
            { id: 'd', state: 'live', account: 'a', pane: null, cwd: '/tmp/four', title: null, subagents: [], permissionMode: null },
        ];
        const table = renderTable(modes, 100, '/Users/x').join('\n');
        expect(table).toContain('MODE');
        expect(table).toContain('yolo');
        expect(table).toContain('manual');
        expect(table).toContain('edits');
        // A dash means we could not tell, never a mode.
        expect(renderTable(modes, 100, '/Users/x')[4]).toMatch(/ - /);
    });

    it('a paneless daemon session reads as phone, and a pane-only harness as no-input', () => {
        const table = renderTable([
            { id: 'a', state: 'live', cwd: '/tmp/a', title: null, subagents: [], origin: 'daemon' },
            { id: 'b', state: 'live', cwd: '/tmp/b', title: null, subagents: [], harness: 'cursor', inputChannel: 'pane' },
            { id: 'c', state: 'live', cwd: '/tmp/c', title: null, subagents: [], harness: 'opencode', inputChannel: 'api', endpoint: null },
        ], 100, '/Users/x').join('\n');
        expect(table).toContain('phone');
        expect(table).toContain('no-input');
        // Mixed harnesses, so the column appears.
        expect(table).toContain('HARNESS');
    });

    it('the harness column is hidden while every session is the same harness', () => {
        expect(renderTable(rows, 100, '/Users/x')[0]).not.toContain('HARNESS');
    });

    it('the cwd is elided from the LEFT and the title from the right', () => {
        const table = renderTable(rows, 100, '/Users/x');
        expect(table[3]).toContain('…');
        // The tail identifies the project, so the last segment survives.
        expect(table[3]).toContain('iiiiiiiiii');
    });

    it('$HOME becomes ~, and only a whole $HOME', () => {
        const table = renderTable([
            { id: 'a', state: 'live', cwd: '/Users/x/Projects/p', title: null, subagents: [] },
            { id: 'b', state: 'live', cwd: '/Users/xylophone/p', title: null, subagents: [] },
        ], 120, '/Users/x').join('\n');
        expect(table).toContain('~/Projects/p');
        expect(table).toContain('/Users/xylophone/p');
    });

    it('no row ever ends in whitespace', () => {
        for (const line of renderTable(rows, 200, '/Users/x')) expect(line).toBe(line.replace(/ +$/, ''));
    });
});

describe('drover sessions — the width', () => {
    it('DROVER_SESSIONS_WIDTH wins, a pipe assumes 120, and 60 is the floor', () => {
        expect(resolveWidth({ DROVER_SESSIONS_WIDTH: '140' }, noProbe)).toBe(140);
        expect(resolveWidth({ DROVER_SESSIONS_WIDTH: '10' }, noProbe)).toBe(60);
        expect(resolveWidth({ DROVER_SESSIONS_WIDTH: 'wide' }, noProbe)).toBe(120);
        expect(resolveWidth({}, { stdoutIsTty: () => false, tputCols: () => { throw new Error('asked'); } })).toBe(120);
        expect(resolveWidth({}, { stdoutIsTty: () => true, tputCols: () => '88' })).toBe(88);
        expect(resolveWidth({}, { stdoutIsTty: () => true, tputCols: () => '' })).toBe(120);
    });
});

describe('drover sessions — the notes under and beside the table', () => {
    it('the stale registry says how old the answer is, or that it never scanned', () => {
        expect(renderStaleNote({ stale: true, scannedAt: 1_700_000_000_000 }, 1_700_000_042_000))
            .toEqual(['note: the session registry is stale (last scanned 42s ago)']);
        expect(renderStaleNote({ stale: true }, 0)).toEqual(['note: the session registry is stale (never scanned)']);
        expect(renderStaleNote({ stale: false, scannedAt: 1 }, 0)).toEqual([]);
    });

    it('lineage is folded under the table, never a column (DROVE-58)', () => {
        expect(renderClones([
            { id: 'aaaaaaaa-1', clonedFrom: { session: 'bbbbbbbb-2', harness: 'codex' } },
            { id: 'cccccccc-3', clonedTo: [{ session: 'dddddddd-4', harness: 'cursor' }, { harness: 'pi' }] },
            { id: 'eeeeeeee-5' },
        ])).toEqual([
            '',
            'clones (drover clone --list):',
            '  aaaaaaaa was cloned from bbbbbbbb (codex)',
            '  cccccccc was cloned into dddddddd (cursor)',
            '  cccccccc was cloned into pi — that session has not spoken yet',
        ]);
        expect(renderClones([{ id: 'a' }])).toEqual([]);
    });
});

// --- fixtures (surface.bats, DROVE-81) --------------------------------------------

describe('drover sessions — fixture rows are hidden, and said out loud', () => {
    it('the rule is the three patterns and the envs copy, and nothing else', () => {
        expect(fixtureCwd('/private/tmp/happy-testing-ground-abc')).toBe(true);
        expect(fixtureCwd('/tmp/happy-testing-ground-abc')).toBe(true);
        expect(fixtureCwd('/private/tmp/happy-claude-goal-fixtures')).toBe(true);
        expect(fixtureCwd('/private/tmp/drover-trust-test')).toBe(true);
        expect(fixtureCwd('/Users/x/happy/environments/data/envs/bold-forest/project')).toBe(true);
        expect(fixtureCwd('/Users/x/happy/environments/data/envs/bold-forest/project/sub')).toBe(true);
        // A worktree is where a real session starts; only the envs copy is one.
        expect(fixtureCwd('/Users/x/.cache/drover-worktrees/DROVE-81')).toBe(false);
        expect(fixtureCwd('/Users/x/Projects/real')).toBe(false);
        expect(fixtureCwd(null)).toBe(false);
    });

    it('the table hides them, and one line on stderr says how many', async () => {
        const bus = await fakeBus(FIXTURE_ROWS);
        try {
            const r = await capture([], {
                DROVER_URL: bus.url,
                DROVER_SESSIONS_WIDTH: '120',
                DROVER_SESSIONS_TIMEOUT_S: '5',
                HOME: '/Users/x',
            });
            expect(r.code).toBe(0);
            expect(r.out).toContain('11111111');
            expect(r.out).toContain('55555555');
            expect(r.out).toContain('66666666');
            for (const gone of ['22222222', '33333333', '77777777', '88888888', 'happy-testing-ground', 'Say exactly ready']) {
                expect(r.out, gone).not.toContain(gone);
            }
            expect(r.err).toBe('note: 4 fixture row(s) hidden (test-harness cwd); DROVER_SHOW_FIXTURES=1 shows them\n');
            // Header, three rows, nothing else.
            expect(r.lines).toHaveLength(4);
        } finally {
            await bus.close();
        }
    });

    it('DROVER_SHOW_FIXTURES=1 shows every row and no note', async () => {
        const bus = await fakeBus(FIXTURE_ROWS);
        try {
            const r = await capture([], {
                DROVER_URL: bus.url,
                DROVER_SESSIONS_WIDTH: '120',
                DROVER_SESSIONS_TIMEOUT_S: '5',
                DROVER_SHOW_FIXTURES: '1',
                HOME: '/Users/x',
            });
            expect(r.code).toBe(0);
            expect(r.lines).toHaveLength(8);
            expect(r.err).toBe('');
        } finally {
            await bus.close();
        }
    });

    it('--json hides the same rows as the table, and shows them under the same switch', async () => {
        const bus = await fakeBus(FIXTURE_ROWS);
        try {
            const hidden = await capture(['--json'], { DROVER_URL: bus.url, DROVER_SESSIONS_TIMEOUT_S: '5' });
            expect(hidden.code).toBe(0);
            expect((JSON.parse(hidden.out) as { sessions: unknown[] }).sessions).toHaveLength(3);
            const shown = await capture(['--json'], { DROVER_URL: bus.url, DROVER_SESSIONS_TIMEOUT_S: '5', DROVER_SHOW_FIXTURES: '1' });
            expect((JSON.parse(shown.out) as { sessions: unknown[] }).sessions).toHaveLength(7);
        } finally {
            await bus.close();
        }
    });

    it('a list that is all fixtures reads as no sessions, with the count', async () => {
        const bus = await fakeBus(JSON.stringify({
            stale: false,
            scannedAt: 1,
            sessions: [{ id: '22222222-0', state: 'idle', cwd: '/tmp/happy-testing-ground-ffff', title: null, subagents: [] }],
        }));
        try {
            const r = await capture([], { DROVER_URL: bus.url, DROVER_SESSIONS_TIMEOUT_S: '5' });
            expect(r.code).toBe(0);
            expect(r.out).toBe('no sessions — the drover sees one once it starts, or once its transcript exists\n');
            expect(r.err).toContain('1 fixture row(s) hidden');
        } finally {
            await bus.close();
        }
    });

    it('--json is jq\'s own pretty print: two spaces, DEL escaped, non-ASCII raw', () => {
        expect(jqJson({ a: 1, b: [], c: {}, d: [1, { e: 'xé' }] }, 2)).toBe(
            '{\n  "a": 1,\n  "b": [],\n  "c": {},\n  "d": [\n    1,\n    {\n      "e": "x\\u007fé"\n    }\n  ]\n}',
        );
    });
});

// --- the sweep (fixture-store.bats) -------------------------------------------------

function transcript(dir: string, id: string, cwd: string): void {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), cwd
        ? `{"type":"user","cwd":"${cwd}","message":{"role":"user","content":"Say exactly ready"}}\n`
        : '{"type":"user","message":{"role":"user","content":"no cwd here"}}\n');
    writeFileSync(join(dir, id, 'custom-title.json'), '{"customTitle":"t"}\n');
}

function sweepStore(root: string): string {
    const sw = join(root, 'store');
    mkdirSync(sw, { recursive: true });
    transcript(join(sw, '-private-tmp-happy-testing-ground-0a1b2c3d'), 'aaaaaaaa-0000-4000-8000-000000000000', '/private/tmp/happy-testing-ground-0a1b2c3d');
    transcript(join(sw, '-Users-x-happy-environments-data-envs-bold-forest-project'), 'bbbbbbbb-0000-4000-8000-000000000000', '/Users/x/happy/environments/data/envs/bold-forest/project');
    transcript(join(sw, '-Users-x--cache-drover-worktrees-DROVE-1-a'), 'cccccccc-0000-4000-8000-000000000000', '/Users/x/.cache/drover-worktrees/DROVE-1/a');
    transcript(join(sw, '-private-tmp-drover-trust-test'), '56565656-0000-4000-8000-000000000000', '/private/tmp/drover-trust-test');
    // Looks like a fixture by NAME; its transcript says it ran in a real project.
    transcript(join(sw, '-tmp-happy-testing-ground-lookalike'), 'dddddddd-0000-4000-8000-000000000000', '/Users/x/Projects/real-work');
    // No cwd in any transcript, and a fixture-shaped name: swept on the name.
    transcript(join(sw, '-tmp-happy-testing-ground-nameonly'), 'eeeeeeee-0000-4000-8000-000000000000', '');
    transcript(join(sw, '-Users-x-Projects-real'), 'ffffffff-0000-4000-8000-000000000000', '/Users/x/Projects/real');
    return sw;
}

describe('drover sessions --sweep-fixtures', () => {
    it('the cwd the transcript recorded is the witness, never the name alone', () => {
        const root = mkdtempSync(join(tmpdir(), 'sweep-'));
        try {
            const sw = sweepStore(root);
            // Under en_US collation the leading dashes are ignored, so the
            // munged `-Users-…` name sorts after `-tmp-…`.
            expect(sweepPlan(sw, { LANG: 'en_US.UTF-8' }).map((p) => p.label)).toEqual([
                '/private/tmp/drover-trust-test',
                '/private/tmp/happy-testing-ground-0a1b2c3d',
                '-tmp-happy-testing-ground-nameonly',
                '/Users/x/happy/environments/data/envs/bold-forest/project',
            ]);
            // Under the C locale it is byte order, so it sorts first.
            const plan = sweepPlan(sw, {}).map((p) => p.label);
            expect(plan).toEqual([
                '/Users/x/happy/environments/data/envs/bold-forest/project',
                '/private/tmp/drover-trust-test',
                '/private/tmp/happy-testing-ground-0a1b2c3d',
                '-tmp-happy-testing-ground-nameonly',
            ]);
            // The plain worktree session is real and stays; so does the lookalike.
            expect(plan.join(' ')).not.toContain('lookalike');
            expect(plan.join(' ')).not.toContain('DROVE-1');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('the dry run lists exactly the fixtures, by path, and removes nothing', async () => {
        const root = mkdtempSync(join(tmpdir(), 'sweep-'));
        try {
            const sw = sweepStore(root);
            const r = await capture(['--sweep-fixtures'], { DROVER_PROJECTS_DIR: sw, DROVER_URL: 'http://127.0.0.1:45999' });
            expect(r.code).toBe(0);
            expect(r.out).toContain('DRY RUN: nothing will be removed.');
            expect(r.out).toContain(`store: ${sw}`);
            expect(r.out).toContain(`  would remove ${sw}/-private-tmp-happy-testing-ground-0a1b2c3d/aaaaaaaa-0000-4000-8000-000000000000.jsonl`);
            expect(r.out).toContain('sweep-fixtures: would remove 8 files in 4 project dirs (0 MB); re-run with --apply');
            // Never the bus, so a refused port cannot make this fail.
            expect(r.err).toBe('');
            expect(existsSync(join(sw, '-private-tmp-happy-testing-ground-0a1b2c3d'))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('--apply removes what the dry run listed, and a second apply finds nothing', async () => {
        const root = mkdtempSync(join(tmpdir(), 'sweep-'));
        try {
            const sw = sweepStore(root);
            const r = await capture(['--sweep-fixtures', '--apply'], { DROVER_PROJECTS_DIR: sw });
            expect(r.code).toBe(0);
            expect(r.out).not.toContain('DRY RUN');
            expect(r.out).toContain(`  remove ${sw}/-private-tmp-happy-testing-ground-0a1b2c3d/aaaaaaaa-0000-4000-8000-000000000000.jsonl`);
            expect(r.out).toContain(`sweep-fixtures: removed 8 files in 4 project dirs (0 MB) from ${sw}`);
            expect(existsSync(join(sw, '-private-tmp-happy-testing-ground-0a1b2c3d'))).toBe(false);
            expect(existsSync(join(sw, '-tmp-happy-testing-ground-lookalike'))).toBe(true);
            expect(existsSync(join(sw, '-Users-x--cache-drover-worktrees-DROVE-1-a'))).toBe(true);
            const again = await capture(['--sweep-fixtures', '--apply'], { DROVER_PROJECTS_DIR: sw });
            expect(again.out).toContain('removed 0 files in 0 project dirs');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a missing projects dir is an error, not an empty success', async () => {
        const r = await capture(['--sweep-fixtures'], { DROVER_PROJECTS_DIR: '/tmp/nowhere-sweep-12345' });
        expect(r.code).toBe(1);
        expect(r.err).toBe('drover sessions --sweep-fixtures: no projects dir at /tmp/nowhere-sweep-12345\n');
    });

    it('the head is read for a cwd, and a torn last line is skipped rather than fatal', () => {
        const dir = mkdtempSync(join(tmpdir(), 'head-'));
        try {
            writeFileSync(join(dir, 'a-0000-4000-8000-1.jsonl'), '{"type":"summary"}\n{"type":"user","cwd":"/real/here"}\n{"type":"user","cw');
            expect(transcriptCwd(dir)).toBe('/real/here');
            expect(transcriptCwd(join(dir, 'nope'))).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the name rule is the same three patterns, on a munged name', () => {
        expect(fixtureProjectName('-private-tmp-happy-testing-ground-x')).toBe(true);
        expect(fixtureProjectName('-tmp-drover-trust-test-x')).toBe(true);
        expect(fixtureProjectName('-Users-x-h-environments-data-envs-bold-project')).toBe(true);
        expect(fixtureProjectName('-Users-x-Projects-real')).toBe(false);
    });

    it('the disk figure is du -sk, counting the directories too', () => {
        const dir = mkdtempSync(join(tmpdir(), 'du-'));
        try {
            writeFileSync(join(dir, 'f'), 'x'.repeat(5000));
            const shell = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
            if (shell.status === 0) expect(duKb(dir)).toBe(Number(shell.stdout.split('\t')[0]));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// --- `reclaim` is a noun, not a flag (reclaim.bats) --------------------------------

describe('drover sessions reclaim', () => {
    it('reaches the reclaim verb without touching the bus', async () => {
        const r = await capture(['reclaim', '--help'], { DROVER_URL: 'http://127.0.0.1:45999' });
        expect(r.code).toBe(0);
        expect(r.out).toContain('drover sessions reclaim');
        expect(r.out).toContain('WHAT IT NEVER DELETES');
    });
});

// --- the shell verb, byte for byte -------------------------------------------------
//
// The jq program in libexec/drover-sessions IS the renderer's spec, so this
// runs it: the same fixture body on the same loopback port, through the shell
// verb and through the node verb, compared byte for byte.

const shellVerb = join(droverEnv().droverDir, 'libexec', 'drover-sessions');

/**
 * The fixture bus in a CHILD process, the way surface.bats runs it. An
 * in-process server cannot answer the shell verb: spawnSync blocks this
 * process's event loop, so curl would sit there until the CLI's own timeout
 * and the diff would compare a table against "the bus is up but slow".
 */
async function childBus(work: string, body: string): Promise<{ url: string; close: () => void }> {
    const bodyFile = join(work, 'body.json');
    const portFile = join(work, 'port');
    writeFileSync(bodyFile, body);
    writeFileSync(join(work, 'bus.cjs'), [
        'const http = require("http"), fs = require("fs");',
        'const body = fs.readFileSync(process.argv[2], "utf8");',
        'const s = http.createServer((q, r) => { r.writeHead(200, {"content-type":"application/json"}); r.end(body); });',
        's.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[3], String(s.address().port)));',
        '',
    ].join('\n'));
    const child = spawn(process.execPath, [join(work, 'bus.cjs'), bodyFile, portFile], { stdio: 'ignore' });
    for (let i = 0; i < 200; i += 1) {
        if (existsSync(portFile) && readFileSync(portFile, 'utf8').trim() !== '') break;
        await new Promise<void>((r) => setTimeout(r, 25));
    }
    return { url: `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`, close: () => child.kill() };
}

/**
 * jq is an asdf shim on this machine, and a shim resolves its version from the
 * cwd's .tool-versions or $HOME's — the fixture HOME below is a throwaway, so
 * the shim would answer "no version set" and every transcript would read as
 * having no cwd. The real binary, by path, before either (tests/pick.bats does
 * exactly this, for exactly this reason).
 */
function jqStub(work: string): string {
    const stub = join(work, 'stub');
    mkdirSync(stub, { recursive: true });
    const asdf = spawnSync('asdf', ['which', 'jq'], { encoding: 'utf8' });
    const real = asdf.status === 0 && asdf.stdout.trim()
        ? asdf.stdout.trim()
        : (spawnSync('command', ['-v', 'jq'], { encoding: 'utf8', shell: true }).stdout ?? '').trim();
    if (real) symlinkSync(real, join(stub, 'jq'));
    return stub;
}

function shellEnv(work: string, extra: Record<string, string>): Record<string, string> {
    mkdirSync(join(work, 'state'), { recursive: true });
    const env = {
        PATH: `${jqStub(work)}:${process.env.PATH ?? ''}`,
        HOME: join(work, 'home'),
        STATE_DIR: join(work, 'state'),
        HAPPY_HOME_DIR: join(work, 'happy'),
        ...extra,
    };
    refuseRealHappyHome(env, 'the shell verb spawn');
    return env;
}

describe.skipIf(!existsSync(shellVerb))('drover sessions — prints what the shell verb printed', () => {
    it('the hostile table matches libexec/drover-sessions on the same body, byte for byte', async () => {
        const work = mkdtempSync(join(tmpdir(), 'sessions-diff-'));
        const bus = await childBus(work, HOSTILE);
        try {
            const env = shellEnv(work, {
                DROVER_URL: bus.url,
                DROVER_SESSIONS_WIDTH: '100',
                DROVER_SESSIONS_TIMEOUT_S: '10',
            });
            const shell = spawnSync(shellVerb, [], { env, encoding: 'utf8' });
            expect(shell.status, shell.stderr).toBe(0);
            const node = await capture([], env);
            expect(node.code).toBe(0);
            expect(node.out).toBe(shell.stdout);
            expect(node.err).toBe(shell.stderr);
        } finally {
            bus.close();
            rmSync(work, { recursive: true, force: true });
        }
    });

    it('--json matches the shell verb byte for byte, fixtures hidden the same way', async () => {
        const work = mkdtempSync(join(tmpdir(), 'sessions-json-'));
        const bus = await childBus(work, FIXTURE_ROWS);
        try {
            const env = shellEnv(work, { DROVER_URL: bus.url, DROVER_SESSIONS_TIMEOUT_S: '10' });
            const shell = spawnSync(shellVerb, ['--json'], { env, encoding: 'utf8' });
            expect(shell.status, shell.stderr).toBe(0);
            const node = await capture(['--json'], env);
            expect(node.code).toBe(0);
            expect(node.out).toBe(shell.stdout);
            expect(node.err).toBe(shell.stderr);
        } finally {
            bus.close();
            rmSync(work, { recursive: true, force: true });
        }
    });

    it('--sweep-fixtures dry run matches the shell verb, path for path', async () => {
        const work = mkdtempSync(join(tmpdir(), 'sweep-diff-'));
        try {
            const sw = sweepStore(work);
            const env = shellEnv(work, { DROVER_PROJECTS_DIR: sw, DROVER_URL: 'http://127.0.0.1:45999' });
            const shell = spawnSync(shellVerb, ['--sweep-fixtures'], { env, encoding: 'utf8' });
            expect(shell.status, shell.stderr).toBe(0);
            const node = await capture(['--sweep-fixtures'], env);
            expect(node.code).toBe(0);
            // Same lines, and the summary and the labels exactly. `find`'s order
            // WITHIN one directory is the filesystem's, not a contract either
            // side owns, so the set is compared rather than the sequence.
            expect(node.out.split('\n').sort()).toEqual(shell.stdout.split('\n').sort());
            expect(node.out.split('\n').filter((l) => !l.startsWith('  '))).toEqual(
                shell.stdout.split('\n').filter((l) => !l.startsWith('  ')),
            );
            // A dry run removes nothing, so both saw the same tree.
            expect(statSync(join(sw, '-private-tmp-happy-testing-ground-0a1b2c3d')).isDirectory()).toBe(true);
            expect(readFileSync(join(sw, '-Users-x-Projects-real', 'ffffffff-0000-4000-8000-000000000000.jsonl'), 'utf8')).toContain('Projects/real');
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });
});
