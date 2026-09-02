/**
 * The vitest twin of cattle-drover/tests/pick.bats (DROVE-315).
 *
 * pick.bats is the spec for `drover pick-session` and it stays green until the
 * shell file leaves. Its `drover --resume` half belongs to bin/drover, which
 * this port does not touch; everything the PICKER itself owns is here — the
 * rows, the three answers, and the fixture rule (DROVE-81) — plus one
 * DIFFERENTIAL test that runs the SHELL verb and the node verb over the same
 * fixture projects dir and compares `--list` byte for byte.
 *
 * NO TEST EVER RAISES A POPUP. Every gum, `command -v`, `[ -t 0 ]`, `[ -t 2 ]`
 * and `read` goes through one injectable PickProbe, and the default double here
 * THROWS on all of them — so a picker that reached for a real gum would fail
 * the test rather than draw a chooser over Clay's terminal. The bus is pointed
 * at a port nothing listens on, or switched off with DROVER_PICK_BUS=0.
 *
 * HAPPY_HOME_DIR is pinned to a throwaway before the first import and the
 * modules a session registration goes through are mocked to THROW on import.
 * The pin says which night made that necessary (DROVE-336).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from './env';
import { age, clean, fixtureCwd, parseArgs, readRegistry, readWhereabouts, rowTitle, run, scanRows, type PickProbe } from './pick-session';

const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-session-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('pick-session.test: configuration (the ~/.happy reader) was imported; the verb must not reach the session machinery');
});
vi.mock('../../persistence', () => {
    throw new Error('pick-session.test: persistence (access.key, settings) was imported; the verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('pick-session.test: api/api (session registration) was imported; the verb must not reach the session machinery');
});
vi.mock('../../claude/runClaude', () => {
    throw new Error('pick-session.test: claude/runClaude was imported; the verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

function happyHomeOf(env: Env): string {
    const raw = env.HAPPY_HOME_DIR;
    return raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
}

function refuseRealHappyHome(env: Env, where: string): void {
    if (happyHomeOf(env) === resolve(realHappyHome)) {
        throw new Error(`${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome}. Refusing.`);
    }
}

beforeAll(() => refuseRealHappyHome(process.env, 'pick-session.test'));

afterAll(() => {
    refuseRealHappyHome(process.env, 'pick-session.test (afterAll)');
    expect(existsSync(happyHome) ? readdirSync(happyHome) : []).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

/** A probe that proves no popup is ever drawn and no terminal is ever read. */
const noProbe: PickProbe = {
    stdinIsTty: () => {
        throw new Error('[ -t 0 ] was asked');
    },
    stderrIsTty: () => {
        throw new Error('[ -t 2 ] was asked');
    },
    hasGum: () => {
        throw new Error('command -v gum was asked');
    },
    gumChoose: () => {
        throw new Error('gum was run');
    },
    readAnswer: () => {
        throw new Error('stdin was read');
    },
};

// The pick.bats fixture, id for id.
const A = 'a1111111-1111-4111-8111-111111111111';
const B = 'b2222222-2222-4222-8222-222222222222';
const C = 'c3333333-3333-4333-8333-333333333333';
const G = 'e5555555-5555-4555-8555-555555555555';
const H = 'f6666666-6666-4666-8666-666666666666';

interface Fixture {
    root: string;
    cwd: string;
    projects: string;
    proj: string;
    state: string;
    accounts: string;
    env: Env;
}

/** The pick.bats setup_file, on disk. */
function fixture(): Fixture {
    const root = mkdtempSync(join(tmpdir(), 'pick-'));
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });
    const cwd = realpathSync(work);
    const projects = join(root, 'projects');
    const munged = Array.from(cwd).map((ch) => (/[A-Za-z0-9-]/.test(ch) ? ch : '-')).join('');
    const proj = join(projects, munged);
    const state = join(root, 'state');
    const home = join(root, 'home');
    mkdirSync(join(proj, A), { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(home, { recursive: true });

    // A: renamed by hand (custom-title.json wins over the transcript), last on
    //    `alt`, older than B.
    writeFileSync(join(proj, `${A}.jsonl`), [
        '{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>injected</system-reminder>"}}',
        '{"type":"user","message":{"role":"user","content":"Fix the picker so it lists titles"}}',
        '',
    ].join('\n'));
    writeFileSync(join(proj, A, 'custom-title.json'), '{"customTitle":"Renamed by hand"}\n');
    // B: the newest; no title anywhere, so the first prompt names it. Its
    //    whereabouts name an account that is NOT in the registry.
    writeFileSync(join(proj, `${B}.jsonl`),
        '{"type":"user","message":{"role":"user","content":"Count slowly from 1 to 40, one number per line, nothing else at all please"}}\n');
    // C: a carried transcript — the custom-title line at the top of the file.
    writeFileSync(join(proj, `${C}.jsonl`), [
        `{"type":"custom-title","customTitle":"Carried title","sessionId":"${A}"}`,
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"count to 40"}]}}',
        '',
    ].join('\n'));
    // G: recorded on `alt`, but for ANOTHER cwd — must not apply.
    writeFileSync(join(proj, `${G}.jsonl`),
        '{"type":"user","message":{"role":"user","content":"a different project once had this id"}}\n');
    // Not conversations: a subagent transcript (not a UUID name) and a file
    // with no user entry at all.
    writeFileSync(join(proj, 'agent-deadbeef.jsonl'), '{"type":"user","message":{"role":"user","content":"agent"}}\n');
    writeFileSync(join(proj, 'd4444444-4444-4444-8444-444444444444.jsonl'), '{"type":"summary","summary":"never got a prompt"}\n');
    // H: no user entry within the head window, but LONGER than it.
    writeFileSync(join(proj, `${H}.jsonl`),
        `${'{"type":"summary","summary":"a long run of padding with no user entry in it at all, repeated"}\n'.repeat(3000)}`);

    const at = (f: string, iso: number): void => utimesSync(f, iso, iso);
    at(join(proj, `${A}.jsonl`), 1_756_425_600);
    at(join(proj, `${C}.jsonl`), 1_754_006_400);
    at(join(proj, `${G}.jsonl`), 1_751_328_000);
    at(join(proj, `${H}.jsonl`), 1_748_736_000);
    const now = Math.floor(Date.now() / 1000);
    at(join(proj, `${B}.jsonl`), now);

    writeFileSync(join(state, 'whereabouts.json'), JSON.stringify({
        [A]: { account: 'alt', cwd, at: 1 },
        [B]: { account: 'ghost', cwd, at: 1 },
        [G]: { account: 'alt', cwd: '/elsewhere', at: 1 },
    }));
    const accounts = join(root, 'accounts.json');
    writeFileSync(accounts, JSON.stringify([
        { name: 'main', configDir: 'default' },
        { name: 'alt', configDir: '~/.claude-accounts/alt' },
    ]));

    return {
        root,
        cwd,
        projects,
        proj,
        state,
        accounts,
        env: {
            HOME: home,
            STATE_DIR: state,
            DROVER_PROJECTS_DIR: projects,
            DROVER_ACCOUNTS: accounts,
            // The live marker is best effort and must not need a bus.
            DROVER_PICK_BUS: '0',
            DROVER_URL: 'http://127.0.0.1:45999',
        },
    };
}

interface Captured {
    code: number;
    out: string;
    err: string;
    lines: string[];
}

async function capture(args: string[], fx: Fixture, probe: PickProbe = noProbe, extra: Env = {}): Promise<Captured> {
    refuseRealHappyHome(process.env, 'capture');
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
        const env = { ...fx.env, ...extra };
        const code = await run(args, { env, probe, home: env.HOME, cwd: fx.cwd });
        const text = out.join('');
        return { code, out: text, err: err.join(''), lines: text.split('\n').filter((l) => l !== '') };
    } finally {
        so.mockRestore();
        se.mockRestore();
    }
}

// --- the rows -------------------------------------------------------------------

describe('drover pick-session — the rows', () => {
    let fx: Fixture;
    beforeAll(() => {
        fx = fixture();
    });
    afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

    it('rows are newest first, one per conversation, and say id, age, account, title', async () => {
        const r = await capture(['--list'], fx);
        expect(r.code).toBe(0);
        expect(r.lines).toHaveLength(5);
        expect(r.lines.map((l) => l.slice(0, 8))).toEqual(['b2222222', 'a1111111', 'c3333333', 'e5555555', 'f6666666']);
        // B was written last: "just now". A is pinned to a date: days.
        expect(r.lines[0]).toContain('just now');
        expect(r.lines[1]).toContain('d ago');
        // The rename beside the transcript wins for A; C keeps its carried title.
        expect(r.lines[1]).toContain('Renamed by hand');
        expect(r.lines[2]).toContain('Carried title');
        // A is on alt. C was never recorded here, so it says so.
        expect(r.lines[1]).toContain('  alt  ');
        expect(r.lines[2]).toContain('  -  ');
    });

    it('a conversation with no title anywhere is named by its first prompt, clipped', async () => {
        const r = await capture(['--list'], fx);
        expect(r.out).toContain('Count slowly from 1 to 40');
        // Clipped at 60 with an ellipsis, so one row stays one line.
        expect(r.out).not.toContain('nothing else at all please');
        expect(r.out).toContain('…');
    });

    it('an injected meta prompt never names a conversation', async () => {
        const r = await capture(['--list'], fx);
        expect(r.out).not.toContain('system-reminder');
        expect(r.out).not.toContain('injected');
    });

    it('a subagent transcript and a transcript with no user entry are not offered', async () => {
        const r = await capture(['--list'], fx);
        expect(r.out).not.toContain('agent-de');
        expect(r.out).not.toContain('d4444444');
    });

    it('a transcript longer than the head window is listed even when the head has no user entry', async () => {
        // The head is read to NAME a row, not to decide one exists. A 190 MB
        // transcript that opens with a summary would otherwise vanish — and
        // `drover -c` takes the top row, so a vanished row means resuming the
        // wrong conversation.
        const r = await capture(['--list'], fx);
        expect(r.out).toContain('f6666666');
        expect(r.lines[4]).toContain('(untitled)');
    });

    it('an account recorded for another cwd, or missing from the registry, reads as none', async () => {
        const r = await capture(['--list'], fx);
        // G is on alt for /elsewhere: not here.
        expect(r.lines[3]).toContain('  -  ');
        // B's record names `ghost`, which `drover account use` would refuse.
        expect(r.out).not.toContain('ghost');
    });

    it('nothing to resume is exit 1 and says where it looked', async () => {
        const empty = join(fx.root, 'empty');
        mkdirSync(empty, { recursive: true });
        const r = await capture(['--list', '--cwd', empty], fx);
        expect(r.code).toBe(1);
        expect(r.err).toContain('nothing to resume in');
        expect(r.out).toBe('');
    });

    it('a directory that is not there stops with exit 1 rather than a stack trace', async () => {
        const r = await capture(['--list', '--cwd', join(fx.root, 'nope')], fx);
        expect(r.code).toBe(1);
        expect(r.out).toBe('');
    });
});

// --- the three answers -------------------------------------------------------------

describe('drover pick-session — the three ways out', () => {
    let fx: Fixture;
    beforeAll(() => {
        fx = fixture();
    });
    afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

    it('--latest is the newest row\'s id, no picker, and nothing else', async () => {
        const r = await capture(['--latest'], fx);
        expect(r.code).toBe(0);
        // The id alone: bin/drover turns this straight into `--resume <id>`.
        expect(r.out).toBe(`${B}\n`);
    });

    it('--latest follows the newest transcript, not the newest row it saw last time', async () => {
        const now = Math.floor(Date.now() / 1000);
        utimesSync(join(fx.proj, `${A}.jsonl`), now, now);
        try {
            const r = await capture(['--latest'], fx);
            expect(r.code).toBe(0);
            expect(r.out).toBe(`${A}\n`);
        } finally {
            utimesSync(join(fx.proj, `${A}.jsonl`), 1_756_425_600, 1_756_425_600);
        }
    });

    it('without a terminal the picker numbers the rows and reads the number from stdin', async () => {
        const probe: PickProbe = { ...noProbe, readAnswer: () => '2' };
        const r = await capture([], fx, probe, { DROVER_PICKER: 'plain' });
        expect(r.code).toBe(0);
        expect(r.err).toContain('resume which conversation?');
        expect(r.err).toContain('   1) b2222222');
        expect(r.err).toContain('   2) a1111111');
        expect(r.out).toBe(`${A}\n`);
    });

    it('the numbered fallback refuses q, an out-of-range number, and end of input', async () => {
        for (const answer of ['q', '9', null]) {
            const r = await capture([], fx, { ...noProbe, readAnswer: () => answer }, { DROVER_PICKER: 'plain' });
            expect(r.code, String(answer)).toBe(1);
            expect(r.out, String(answer)).toBe('');
            expect(r.err, String(answer)).toContain('no session picked');
        }
    });

    it('gum is shown every row, label first, and the pick comes back as the id', async () => {
        let seen = '';
        let header = '';
        let height = 0;
        const probe: PickProbe = {
            ...noProbe,
            gumChoose: (input, h, n) => {
                seen = input;
                header = h;
                height = n;
                // The stub answers with the VALUE of row 2, after the delimiter.
                return seen.split('\n')[1].split('\t')[1];
            },
        };
        const r = await capture([], fx, probe, { DROVER_PICKER: 'gum' });
        expect(r.code).toBe(0);
        expect(r.out).toBe(`${A}\n`);
        expect(seen).toContain('Renamed by hand');
        expect(seen).toContain('Carried title');
        expect(seen).toContain('Count slowly');
        // `label<TAB>id`, so nothing has to be parsed back out of a padded label.
        expect(seen.split('\n')[0].split('\t')[1]).toBe(B);
        expect(seen.split('\n')[1].split('\t')[1]).toBe(A);
        // The row's account is on the label: worth seeing before you pick, even
        // though `pick-account` (DROVE-21) is what decides where a start lands.
        expect(seen.split('\n')[1]).toContain('  alt  ');
        expect(header).toBe(`resume which conversation?  ${fx.cwd}`);
        expect(height).toBe(5);
    });

    it('escaping out of gum picks nothing and exits 1', async () => {
        const r = await capture([], fx, { ...noProbe, gumChoose: () => null }, { DROVER_PICKER: 'gum' });
        expect(r.code).toBe(1);
        expect(r.err).toContain('no session picked');
        expect(r.out).toBe('');
    });

    it('DROVER_PICKER=plain forces the numbered list even when gum is available', async () => {
        const probe: PickProbe = {
            ...noProbe,
            readAnswer: () => '3',
            gumChoose: () => {
                throw new Error('gum was run under DROVER_PICKER=plain');
            },
        };
        const r = await capture([], fx, probe, { DROVER_PICKER: 'plain' });
        expect(r.code).toBe(0);
        expect(r.out).toBe(`${C}\n`);
    });
});

// --- arguments and helpers ----------------------------------------------------------

describe('drover pick-session — the arguments', () => {
    it('--cwd needs a directory, and an unknown argument is refused', () => {
        expect(parseArgs(['--cwd'])).toEqual({ code: 2, error: 'drover pick-session: --cwd needs a directory' });
        expect(parseArgs(['--nope'])).toEqual({ code: 2, error: "drover pick-session: unknown argument '--nope' (try --help)" });
        expect(parseArgs(['--list'])).toEqual({ mode: 'list', cwd: '' });
        expect(parseArgs(['--latest', '--cwd', '/x'])).toEqual({ mode: 'latest', cwd: '/x' });
        expect(parseArgs(['--help'])).toEqual({ help: true });
    });

    it('age is the coarsest unit that still says something', () => {
        expect(age(0)).toBe('just now');
        expect(age(59)).toBe('just now');
        expect(age(60)).toBe('1m ago');
        expect(age(3600)).toBe('1h ago');
        expect(age(86_400)).toBe('1d ago');
        expect(age(3 * 86_400 + 5)).toBe('3d ago');
    });

    it('control characters become spaces, so a title cannot be a second row', () => {
        expect(clean('a\nb\tc')).toBe('a b c');
        expect(clean(null)).toBe('');
    });

    it('a torn or doubled whereabouts file reads as no record rather than aborting the pick', () => {
        const dir = mkdtempSync(join(tmpdir(), 'where-'));
        try {
            const f = join(dir, 'whereabouts.json');
            writeFileSync(f, '{"a":{"account":"alt","cwd":"/x"},"b":{"account":"m","cwd":"/y"}}');
            expect(readWhereabouts(f, '/x')).toEqual({ a: 'alt' });
            writeFileSync(f, '{"a":{}}{"a":{}}');
            expect(readWhereabouts(f, '/x')).toEqual({});
            expect(readWhereabouts(join(dir, 'nope.json'), '/x')).toEqual({});
            writeFileSync(join(dir, 'reg.json'), '[{"name":"main"},{"configDir":"x"},{"name":"alt"}]');
            expect(readRegistry(join(dir, 'reg.json'))).toEqual(['main', 'alt']);
            expect(readRegistry(join(dir, 'nope.json'))).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// --- fixture directories (DROVE-81) ---------------------------------------------------

describe('drover pick-session — a fixture cwd has nothing to pick', () => {
    let fx: Fixture;
    let fixDir: string;

    beforeAll(() => {
        fx = fixture();
        fixDir = join(fx.root, 'environments', 'data', 'envs', 'bold-forest', 'project');
        mkdirSync(fixDir, { recursive: true });
        fixDir = realpathSync(fixDir);
        const munged = Array.from(fixDir).map((ch) => (/[A-Za-z0-9-]/.test(ch) ? ch : '-')).join('');
        mkdirSync(join(fx.projects, munged), { recursive: true });
        writeFileSync(join(fx.projects, munged, `${B}.jsonl`),
            '{"type":"user","message":{"role":"user","content":"Say exactly ready"}}\n');
    });
    afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

    it('says why, and shows nothing', async () => {
        const r = await capture(['--list', '--cwd', fixDir], fx);
        expect(r.code).toBe(1);
        expect(r.err).toContain('test-harness fixture directory');
        expect(r.err).toContain('DROVER_SHOW_FIXTURES=1');
        expect(r.out).not.toContain('Say exactly ready');
    });

    it('DROVER_SHOW_FIXTURES=1 lists a fixture cwd like any other', async () => {
        const r = await capture(['--list', '--cwd', fixDir], fx, noProbe, { DROVER_SHOW_FIXTURES: '1' });
        expect(r.code).toBe(0);
        expect(r.out).toContain('Say exactly ready');
        expect(r.err).not.toContain('fixture directory');
    });

    it('a plain worktree cwd is not a fixture; only the envs copy inside one is', () => {
        expect(fixtureCwd('/Users/x/.cache/drover-worktrees/DROVE-81')).toBe(false);
        expect(fixtureCwd('/Users/x/.cache/drover-worktrees/DROVE-81/environments/data/envs/keen-cloud/project')).toBe(true);
        expect(fixtureCwd('/private/tmp/happy-testing-ground-abc')).toBe(true);
        expect(fixtureCwd('/tmp/drover-trust-test-1')).toBe(true);
        expect(fixtureCwd('/Users/x/Projects/real')).toBe(false);
    });

    it('the rows a picker shows in a real cwd are unchanged by the fixture rule', async () => {
        const r = await capture(['--list'], fx);
        expect(r.code).toBe(0);
        expect(r.lines).toHaveLength(5);
        expect(r.out).not.toContain('fixture');
    });
});

// --- the readers, on their own ---------------------------------------------------------

describe('drover pick-session — one read of the head names the row', () => {
    it('ranks the rename, then the carried title, then the first thing the user typed', () => {
        const dir = mkdtempSync(join(tmpdir(), 'title-'));
        try {
            mkdirSync(join(dir, A));
            writeFileSync(join(dir, `${A}.jsonl`), '{"type":"user","message":{"role":"user","content":"typed first"}}\n');
            expect(rowTitle(dir, A, join(dir, `${A}.jsonl`))).toBe('typed first');
            writeFileSync(join(dir, `${A}.jsonl`), [
                '{"type":"custom-title","customTitle":"Carried"}',
                '{"type":"user","message":{"role":"user","content":"typed first"}}',
                '',
            ].join('\n'));
            expect(rowTitle(dir, A, join(dir, `${A}.jsonl`))).toBe('Carried');
            writeFileSync(join(dir, A, 'custom-title.json'), '{"customTitle":"Renamed"}');
            expect(rowTitle(dir, A, join(dir, `${A}.jsonl`))).toBe('Renamed');
            // Claude Code's own scaffolding never names a conversation.
            rmSync(join(dir, A, 'custom-title.json'));
            writeFileSync(join(dir, `${A}.jsonl`), [
                '{"type":"user","isMeta":true,"message":{"role":"user","content":"injected"}}',
                '{"type":"user","message":{"role":"user","content":"<local-command>"}}',
                '{"type":"user","message":{"role":"user","content":"Caveat: the messages below"}}',
                '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"real prompt"}]}}',
                '',
            ].join('\n'));
            expect(rowTitle(dir, A, join(dir, `${A}.jsonl`))).toBe('real prompt');
            // No user entry at all is "not a conversation".
            writeFileSync(join(dir, `${A}.jsonl`), '{"type":"summary","summary":"none"}\n');
            expect(rowTitle(dir, A, join(dir, `${A}.jsonl`))).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the scan takes UUID names only, newest first, and stops at the limit', () => {
        const dir = mkdtempSync(join(tmpdir(), 'scan-'));
        try {
            for (const [i, id] of [A, B, C].entries()) {
                writeFileSync(join(dir, `${id}.jsonl`), `{"type":"user","message":{"role":"user","content":"p${i}"}}\n`);
                utimesSync(join(dir, `${id}.jsonl`), 1_700_000_000 + i, 1_700_000_000 + i);
            }
            writeFileSync(join(dir, 'agent-deadbeef.jsonl'), '{"type":"user","message":{"role":"user","content":"agent"}}\n');
            expect(scanRows(dir, 40).map((r) => r.id)).toEqual([C, B, A]);
            expect(scanRows(dir, 2).map((r) => r.id)).toEqual([C, B]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// --- the shell verb, byte for byte ---------------------------------------------------

const shellVerb = join(droverEnv().droverDir, 'libexec', 'drover-pick-session');

describe.skipIf(!existsSync(shellVerb))('drover pick-session — prints what the shell verb printed', () => {
    it('--list matches libexec/drover-pick-session over the same projects dir', async () => {
        const fx = fixture();
        try {
            // jq is an asdf shim on this machine, and a shim resolves its
            // version from the cwd's .tool-versions or $HOME's — the fixture
            // HOME is a throwaway, so the shim would answer "no version set"
            // and every row would vanish. The real binary, by path, first
            // (tests/pick.bats does exactly this, for exactly this reason).
            const stub = join(fx.root, 'stub');
            mkdirSync(stub, { recursive: true });
            const asdf = spawnSync('asdf', ['which', 'jq'], { encoding: 'utf8' });
            const real = asdf.status === 0 && asdf.stdout.trim()
                ? asdf.stdout.trim()
                : (spawnSync('command', ['-v', 'jq'], { encoding: 'utf8', shell: true }).stdout ?? '').trim();
            if (real) symlinkSync(real, join(stub, 'jq'));
            const env = {
                PATH: `${stub}:${process.env.PATH ?? ''}`,
                HOME: fx.env.HOME as string,
                STATE_DIR: fx.state,
                HAPPY_HOME_DIR: join(fx.root, 'happy'),
                DROVER_PROJECTS_DIR: fx.projects,
                DROVER_ACCOUNTS: fx.accounts,
                DROVER_PICK_BUS: '0',
                DROVER_URL: 'http://127.0.0.1:45999',
            };
            refuseRealHappyHome(env, 'the shell verb spawn');
            const shell = spawnSync(shellVerb, ['--list', '--cwd', fx.cwd], { env, encoding: 'utf8' });
            expect(shell.status, shell.stderr).toBe(0);
            const node = await capture(['--list', '--cwd', fx.cwd], { ...fx, env: { ...fx.env, ...env } });
            expect(node.code).toBe(0);
            expect(node.out).toBe(shell.stdout);
        } finally {
            rmSync(fx.root, { recursive: true, force: true });
        }
    });
});
