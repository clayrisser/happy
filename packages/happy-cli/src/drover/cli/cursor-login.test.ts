/**
 * `drover account login --harness cursor`, measured against the shell it was
 * ported from (DROVE-315 wave 4).
 *
 * THE DIFFERENTIAL COMPARES DECISIONS, NOT A LOGIN. Nothing here runs
 * `cursor-agent login`, opens a browser, reaches a live service or touches the
 * machine-wide Keychain slot Clay's own cursor-agent reads. What is compared is
 * what each implementation DECIDED over the same fixture: the help text, the
 * refusals and their exit codes, the guard that fires when cursor-agent is not
 * on PATH, the link it read off a recorded pane, the card argv, the notice
 * payload, the window name it would open, and the registry row and token store
 * it would write.
 *
 * The shell side is the REAL libexec/drover-cursor-login, run with a scrubbed
 * environment on a fixture PATH that deliberately has no cursor-agent on it —
 * which is what makes those paths reachable without a login existing. The node
 * side runs in this process with an io whose every real-machine call THROWS, so
 * a branch that reached for a pane, a pty, a bus or a browser fails the test
 * rather than measuring it.
 *
 * The `.url` and `.tail` goldens beside each pane fixture were produced by the
 * shell's OWN pipelines — `tr … | sed -n … | head -1` and
 * `grep . | tail -3 | tr '\n' ' '` — and the `.json` ones by the `jq -n` lifted
 * verbatim out of the wrapper's notify_failed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { cursorAuthRead, cursorAuthStore, cursorAuthWrite, cursorAuthHarvest, cursorAuthIdentity } from './account-store';
import {
    type AskRun,
    type CursorLoginIo,
    cursorAskArgv,
    cursorNotifyPayload,
    fmtEpochDay,
    isCursorParseFailure,
    parseCursorLoginArgs,
    paneTail,
    readLoginLink,
    run,
    usage,
} from './cursor-login';
import { droverEnv } from './env';
import { DroverWindow, type TmuxResult, type WindowIo, loginWindowName } from './harness/droverWindow';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import (DROVE-336).
 *
 * A bench that did not set it once registered seventy-eight real sessions on
 * Clay's phone, because the fork's entry takes an unknown word to Claude and
 * Claude registers. Nothing in this file goes near the entry, and this is what
 * makes that a fact rather than an intention.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorlogin-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

vi.mock('../../configuration', () => {
    throw new Error('cursor-login.test: configuration was imported; this verb must not reach the session machinery');
});
vi.mock('../../api/api', () => {
    throw new Error('cursor-login.test: api/api was imported; this verb must not reach the session machinery');
});

type Env = Record<string, string | undefined>;

function refuseRealHappyHome(env: Env, where: string): void {
    const raw = env.HAPPY_HOME_DIR;
    const at = raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
    if (at === resolve(realHappyHome)) {
        throw new Error(`${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome}. Refusing.`);
    }
}

const fixtures = fileURLToPath(new URL('./__fixtures__/login', import.meta.url));
const read = (name: string): string => readFileSync(join(fixtures, name), 'utf8');

const droverDir = droverEnv({ ...process.env, DROVER_DIR: process.env.DROVER_DIR }).droverDir;
const shellVerb = join(droverDir, 'libexec', 'drover-cursor-login');
const haveShell = existsSync(shellVerb);

let root = '';
let fixture: Record<string, string> = {};

/**
 * The fixture, and the PATH is the load-bearing part of it.
 *
 * It holds jq, curl, uname and date — everything the wrapper needs to reach its
 * guards — and DELIBERATELY NO cursor-agent. That absence is what makes the
 * guard path reachable in both implementations without a login existing
 * anywhere, and it is why nothing in this file can start one by accident: there
 * is no cursor-agent on the PATH either side reads.
 *
 * DROVER_URL points at a port nothing listens on, so the wrapper's notice goes
 * nowhere and the node side's is recorded instead of posted.
 */
function makeFixture(): Record<string, string> {
    root = mkdtempSync(join(tmpdir(), 'drover-cursor-login-'));
    const home = join(root, 'home');
    const state = join(root, 'state');
    const bin = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(bin, { recursive: true });

    // The REAL jq, resolved while the cwd is still the repo. jq is an asdf shim
    // on this machine and a shim resolves its version from the cwd's or $HOME's
    // .tool-versions — and $HOME here is an empty fixture, so the shim would
    // answer "No version is set for command jq". The same fix tests/login.bats
    // carries.
    const asdf = spawnSync('asdf', ['which', 'jq'], { encoding: 'utf8' });
    const jq = (asdf.status === 0 ? asdf.stdout.trim() : '')
        || spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
    for (const tool of [jq, '/usr/bin/curl', '/usr/bin/uname', '/bin/date']) {
        if (tool === '' || !existsSync(tool)) continue;
        try {
            symlinkSync(tool, join(bin, tool.slice(tool.lastIndexOf('/') + 1)));
        } catch {
            // Already linked.
        }
    }

    // A tmux that REFUSES. It exists so `command -v tmux` and `which('tmux')`
    // answer yes and the guard passes, and it fails loudly the instant anything
    // actually runs it — which nothing here does: every tmux call on the node
    // side goes through the injected WindowIo double, and the shell side never
    // reaches its own tmux guard because the cursor-agent one fires first.
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho "cursor-login.test: the REAL tmux was run" >&2\nexit 97\n', { mode: 0o755 });

    const registry = join(root, 'accounts.json');
    writeFileSync(registry, `${JSON.stringify([
        { name: 'main', configDir: 'default' },
        { name: 'clay@example.com', configDir: '~/.claude-accounts/a6' },
    ], null, 2)}\n`);

    return {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        STATE_DIR: state,
        DROVER_DIR: droverDir,
        DROVER_ACCOUNTS: registry,
        DROVER_URL: 'http://127.0.0.1:1',
        DROVER_SHARED_STORE: join(root, 'no-shared-store'),
        HAPPY_HOME_DIR: happyHome,
        HAPPY_SERVER_URL: 'http://127.0.0.1:1',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
}

interface Ran {
    stdout: string;
    stderr: string;
    code: number;
}

/** The real shell verb, on the fixture, with nothing of the real world left. */
function shell(args: string[], extra: Env = {}): Ran {
    const env = { ...fixture, ...extra } as Record<string, string>;
    refuseRealHappyHome(env, 'cursor-login.test: spawn');
    const res = spawnSync(shellVerb, args, { env, encoding: 'utf8' });
    if (res.error || res.status === 126 || res.status === 127) {
        throw new Error(`cursor-login.test: could not run ${shellVerb} (status ${res.status}, ${String(res.error)}) stderr=${res.stderr}`);
    }
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 0 };
}

/**
 * An io in which EVERY call that would reach the real machine throws.
 *
 * The overrides a test hands in are the only things it can do. That is the
 * whole safety property of this file: a branch that wanted a pane, a pty, a
 * browser, a bus or a temp directory and was not given one fails the test
 * naming what it wanted.
 */
function strictIo(extra: Env, over: Partial<CursorLoginIo> = {}): {
    io: CursorLoginIo;
    out: string[];
    err: string[];
    notices: Record<string, unknown>[];
} {
    const env = { ...fixture, ...extra } as NodeJS.ProcessEnv;
    refuseRealHappyHome(env, 'cursor-login.test: in-process run');
    const out: string[] = [];
    const err: string[] = [];
    const notices: Record<string, unknown>[] = [];
    const refuse = (what: string) => (): never => {
        throw new Error(`cursor-login.test: ${what} was reached; this test must not touch the real machine`);
    };
    const windowIo: WindowIo = {
        env,
        tmux: refuse('tmux'),
        which: (name) => whichIn(env.PATH ?? '', name),
        err: (line) => err.push(line),
    };
    const io: CursorLoginIo = {
        env,
        cwd: '/tmp/work',
        pid: 4242,
        isTty: () => false,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        window: new DroverWindow(windowIo),
        which: (name) => whichIn(env.PATH ?? '', name),
        now: () => 1_800_000_000,
        sleep: async () => {},
        alive: refuse('kill -0'),
        signal: refuse('kill'),
        mkdtemp: refuse('mkdtemp'),
        rmrf: refuse('rm -rf'),
        notify: async (payload) => {
            notices.push(payload);
        },
        ask: refuse('drover ask'),
        selfCommand: (argv) => ['/node', '/entry', 'cursor-login', ...argv],
        onSignal: () => {},
        ...over,
    };
    return { io, out, err, notices };
}

function whichIn(path: string, name: string): string | null {
    for (const dir of path.split(':')) {
        if (!dir) continue;
        if (existsSync(join(dir, name))) return join(dir, name);
    }
    return null;
}

/** The node verb's stdout and stderr as one text each, the way a pipe sees it. */
async function node(args: string[], extra: Env = {}, over: Partial<CursorLoginIo> = {}): Promise<Ran & { notices: Record<string, unknown>[] }> {
    const { io, out, err, notices } = strictIo(extra, over);
    const code = await run(args, io);
    const join_ = (lines: string[]): string => (lines.length === 0 ? '' : `${lines.join('\n')}\n`);
    return { stdout: join_(out), stderr: join_(err), code, notices };
}

beforeAll(() => {
    refuseRealHappyHome(process.env, 'cursor-login.test');
    fixture = makeFixture();
});

afterAll(() => {
    const left = existsSync(happyHome) ? readdirSync(happyHome) : [];
    expect(left).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
    if (root !== '') rmSync(root, { recursive: true, force: true });
});

// --- the differential ---------------------------------------------------------

describe.runIf(haveShell)('cursor-login: byte for byte against the shell', () => {
    it('--help is the shell heredoc, and answers before anything is read', async () => {
        const sh = shell(['--help']);
        const nd = await node(['--help']);
        expect(nd.stdout).toBe(sh.stdout);
        expect(nd.code).toBe(sh.code);
        expect(sh.code).toBe(0);
        // Not two empty answers: the three sentences that are the whole point.
        expect(nd.stdout).toContain('YOUR OWN CURSOR LOGIN IS NOT TOUCHED');
        expect(nd.stdout).toContain('THERE IS NO CODE TO SEND BACK');
        expect(nd.stdout).toContain('No API key is minted, read or stored anywhere in this flow.');
    });

    for (const [what, args] of [
        ['an unknown option', ['--nope']],
        ['a name given twice', ['a', 'b']],
        ['a timeout that is not seconds', ['--timeout', 'abc']],
        ['--config-dir, which a cursor account does not have', ['--config-dir', '/x']],
        ['--timeout with nothing after it', ['--timeout']],
    ] as const) {
        it(`${what} is refused with the shell's sentence and its exit code`, async () => {
            const sh = shell([...args]);
            const nd = await node([...args]);
            expect(nd.stderr).toBe(sh.stderr);
            expect(nd.code).toBe(sh.code);
            expect(sh.code).toBe(2);
            expect(sh.stderr).not.toBe('');
        });
    }

    it('no cursor-agent on PATH exits 5 with the sentence, and puts a card up', async () => {
        // The guard the phone login was dying on, and the reason it looked like
        // a hang rather than a failure. Reachable here precisely because the
        // fixture PATH has no cursor-agent on it.
        const sh = shell(['--no-window']);
        const nd = await node(['--no-window']);
        expect(nd.stderr).toBe(sh.stderr);
        expect(nd.code).toBe(sh.code);
        expect(sh.code).toBe(5);
        expect(sh.stderr).toContain('cursor-agent is not on PATH, so there is no login to open');
        // And the node side raised the notice the shell posted to the bus.
        expect(nd.notices).toHaveLength(1);
        expect(nd.notices[0].title).toBe('Cursor login for a new cursor account failed');
        expect(String(nd.notices[0].reason)).toContain('curl https://cursor.com/install -fsS | sh');
    });

    it('a named login names the account on the card, not "a new cursor account"', async () => {
        const sh = shell(['jam', '--no-window']);
        const nd = await node(['jam', '--no-window']);
        expect(nd.stderr).toBe(sh.stderr);
        expect(nd.code).toBe(sh.code);
        expect(nd.notices[0].title).toBe('Cursor login for jam failed');
    });

    it('the name is accepted on either side of --harness cursor', async () => {
        const before = parseCursorLoginArgs(['jam', '--harness', 'cursor']);
        const after = parseCursorLoginArgs(['--harness', 'cursor', 'jam']);
        expect(isCursorParseFailure(before)).toBe(false);
        expect(isCursorParseFailure(after)).toBe(false);
        expect((before as { name: string }).name).toBe('jam');
        expect((after as { name: string }).name).toBe('jam');
        // And the shell agrees, on the path that reaches the guard.
        expect(shell(['jam', '--harness', 'cursor', '--no-window']).stderr)
            .toBe(shell(['--harness', 'cursor', 'jam', '--no-window']).stderr);
    });
});

// --- the decisions ------------------------------------------------------------

describe('cursor-login: the link off the pane, as the shell read it', () => {
    it('the recorded pane yields the same link the shell pipeline did', () => {
        expect(readLoginLink(read('cursor-pane-link.txt'))).toBe(read('cursor-pane-link.url').trimEnd());
        expect(readLoginLink(read('cursor-pane-link.txt'))).toContain('loginDeepControl');
    });

    it('a pane with no link yet reads as no link, not as a wrong one', () => {
        expect(readLoginLink(read('cursor-pane-dead.txt'))).toBe('');
        expect(read('cursor-pane-dead.url').trimEnd()).toBe('');
    });

    it('the link is matched on ITSELF, never on the sentence around it', () => {
        // "Open a browser and navigate to this link:" is wording; a
        // loginDeepControl link on the screen is the invariant.
        expect(readLoginLink('anything at all https://cursor.com/loginDeepControl?x=1\n'))
            .toBe('https://cursor.com/loginDeepControl?x=1');
        expect(readLoginLink('Open a browser and navigate to this link:\n')).toBe('');
    });

    it('a claude authorize link is NOT a cursor one', () => {
        expect(readLoginLink(read('pane-url.txt'))).toBe('');
    });
});

describe('cursor-login: what the card says when the pane died', () => {
    for (const pane of ['cursor-pane-link', 'cursor-pane-dead', 'pane-url']) {
        it(`${pane} tails exactly as grep . | tail -3 | tr did`, () => {
            expect(paneTail(read(`${pane}.txt`))).toBe(read(`${pane}.tail`));
        });
    }

    it('the trailing space tr leaves is KEPT, because the sentences are compared', () => {
        expect(paneTail('one\ntwo\n')).toBe('one two ');
    });

    it('an empty pane tails to nothing, so the caller uses its own sentence', () => {
        expect(paneTail('')).toBe('');
        expect(paneTail('\n\n')).toBe('');
    });
});

describe('cursor-login: the card the phone gets', () => {
    const card = { label: 'jam', url: 'https://cursor.com/loginDeepControl?x=1', timeoutS: 900, session: '', watch: '' };

    it('is a `drover ask` with the link as the preview and one Cancel option', () => {
        expect(cursorAskArgv(card)).toEqual([
            'Log in to Cursor for jam',
            '--reason', 'Open this in a browser and approve it. Nothing to send back — the login finishes on its own.',
            '--preview', 'https://cursor.com/loginDeepControl?x=1',
            '--option', 'cancel:Cancel the login',
            '--gate', 'account-login',
            '--harness', 'drover',
            '--timeout', '900',
        ]);
    });

    it('carries --session only when there is one', () => {
        expect(cursorAskArgv({ ...card, session: 'sess-42' }).slice(-2)).toEqual(['--session', 'sess-42']);
        expect(cursorAskArgv(card)).not.toContain('--session');
    });

    it('the watch fragment rides on the END of the reason, never as a paragraph', () => {
        const argv = cursorAskArgv({ ...card, watch: 'Watch it in tmux: work:login-cursor-jam' });
        expect(argv[2]).toBe('Open this in a browser and approve it. Nothing to send back — '
            + 'the login finishes on its own. Watch it in tmux: work:login-cursor-jam');
        expect(argv[2].split('\n')).toHaveLength(1);
    });

    it('there is no code field and no Allow/Deny: cancel is the only option', () => {
        const argv = cursorAskArgv(card);
        expect(argv.filter((a) => a === '--option')).toHaveLength(1);
        expect(argv[argv.indexOf('--gate') + 1]).toBe('account-login');
    });
});

describe('cursor-login: the notice card, byte for byte against the shell\'s jq', () => {
    it('a guard that fired before anything started', () => {
        const got = cursorNotifyPayload(
            '', 'cursor-agent is not on this process\'s PATH, so there is no login to open.', '/tmp/work', '',
        );
        expect(JSON.stringify(got)).toBe(read('notify-cursor-failed.json').trimEnd());
    });

    it('a named login with a session attached', () => {
        const got = cursorNotifyPayload('jam', 'nobody approved the login within 900s', '/tmp/work', 'sess-42');
        expect(JSON.stringify(got)).toBe(read('notify-cursor-named.json').trimEnd());
    });

    it('a nameless add is "a new cursor account", never "a new account"', () => {
        expect(cursorNotifyPayload('', 'why', '/tmp/work', '').title)
            .toBe('Cursor login for a new cursor account failed');
    });
});

describe('cursor-login: the window it would open', () => {
    it('is login-cursor-<account>, and a nameless add is the placeholder', () => {
        expect(loginWindowName('cursor', 'jam')).toBe('login-cursor-jam');
        expect(loginWindowName('cursor', 'new')).toBe('login-cursor-new');
        expect(loginWindowName('cursor', 'clayrisser@gmail.com')).toBe('login-cursor-clayrisser-gmail-com');
    });

    it('a terminal means run HERE; no terminal means open one', async () => {
        // --no-window and --window override the guess, which is what the bats
        // suite needs and what makes this testable at all.
        const auto = parseCursorLoginArgs([]);
        expect((auto as { wantWindow: boolean | null }).wantWindow).toBeNull();
        expect((parseCursorLoginArgs(['--window']) as { wantWindow: boolean | null }).wantWindow).toBe(true);
        expect((parseCursorLoginArgs(['--no-window']) as { wantWindow: boolean | null }).wantWindow).toBe(false);
    });

    it('with no terminal it re-execs ITSELF into the window and says which', async () => {
        const opened: { args: string[]; input?: string }[] = [];
        const windowIo: WindowIo = {
            env: { ...fixture } as NodeJS.ProcessEnv,
            tmux: (_bin, args) => {
                opened.push({ args });
                const key = args[2];
                if (key === 'list-sessions') return { status: 0, stdout: '9 9 1 work\n', stderr: '' } as TmuxResult;
                if (key === 'list-windows') return { status: 0, stdout: 'bash\n', stderr: '' } as TmuxResult;
                if (key === 'new-window') return { status: 0, stdout: '%5\n', stderr: '' } as TmuxResult;
                if (key === 'set-option') return { status: 0, stdout: '', stderr: '' } as TmuxResult;
                throw new Error(`unmodelled tmux: ${args.join(' ')}`);
            },
            which: (name) => (name === 'tmux' ? '/fixture/tmux' : null),
            err: () => {},
        };
        // cursor-agent has to LOOK present for the guard to pass, so the window
        // block is the branch under test. It is never executed: the argv only
        // ever reaches the scripted tmux above.
        const nd = await node(['jam', '--window'], {}, {
            window: new DroverWindow(windowIo),
            which: (name) => (name === 'cursor-agent' ? '/fixture/cursor-agent' : whichIn(fixture.PATH, name)),
        });
        expect(nd.code).toBe(0);
        expect(nd.stdout).toBe('drover account login: running in work:login-cursor-jam\n');

        const created = opened.find((c) => c.args[2] === 'new-window')!;
        expect(created.args[created.args.indexOf('-n') + 1]).toBe('login-cursor-jam');
        // The environment travels explicitly, DROVER_LOGIN_WINDOW first, so the
        // run in the window knows the launcher already opened it.
        expect(created.args).toContain('DROVER_LOGIN_WINDOW=login-cursor-jam');
        expect(created.args).toContain(`DROVER_ACCOUNTS=${fixture.DROVER_ACCOUNTS}`);
        expect(created.args).toContain('DROVER_URL=http://127.0.0.1:1');
        // And it re-execs THIS cli, carrying the flags somebody typed.
        const rest = created.args.slice(created.args.lastIndexOf('--') + 1);
        expect(rest.slice(-4)).toEqual(['/entry', 'cursor-login', 'jam', '--window']);
    });
});

// --- the token store, which is the WRITE half of lib/drover-cursor-auth.sh ----

describe('cursor-login: the token store', () => {
    it('round-trips, and is readable by nobody else', () => {
        const store = join(root, 'store', 'cursor-auth.json');
        expect(cursorAuthWrite(store, 'jam', 'tok.en.value', 'auth0|x', 'jam@example.com', 1_800_000_000)).toBe(true);
        expect(cursorAuthRead(store, 'jam')).toEqual({
            token: 'tok.en.value', authId: 'auth0|x', email: 'jam@example.com', storedAt: 1_800_000_000,
        });
        const sh = spawnSync('sh', ['-c', `ls -l ${JSON.stringify(store)}`], { encoding: 'utf8' });
        expect(sh.stdout.slice(0, 10)).toBe('-rw-------');
    });

    it('a second login for the same account REPLACES the token, keeping one entry', () => {
        const store = join(root, 'store2', 'cursor-auth.json');
        cursorAuthWrite(store, 'jam', 'old', 'auth0|x', 'jam@example.com', 1);
        cursorAuthWrite(store, 'jam', 'new', 'auth0|x', 'jam@example.com', 2);
        const doc = JSON.parse(readFileSync(store, 'utf8')) as Record<string, unknown>;
        expect(Object.keys(doc)).toEqual(['jam']);
        expect(cursorAuthRead(store, 'jam')?.token).toBe('new');
    });

    it('another account is left byte-identical beside it', () => {
        const store = join(root, 'store3', 'cursor-auth.json');
        cursorAuthWrite(store, 'a', 'ta', 'auth0|a', 'a@x', 1);
        cursorAuthWrite(store, 'b', 'tb', 'auth0|b', 'b@x', 2);
        expect(cursorAuthRead(store, 'a')).toEqual({ token: 'ta', authId: 'auth0|a', email: 'a@x', storedAt: 1 });
    });

    it('cursorAuthStore follows DROVER_CURSOR_AUTH, else $STATE_DIR', () => {
        expect(cursorAuthStore('/s', {})).toBe('/s/cursor-auth.json');
        expect(cursorAuthStore('/s', { DROVER_CURSOR_AUTH: '/elsewhere.json' })).toBe('/elsewhere.json');
    });
});

describe('cursor-login: harvesting a login, and never the shared slot', () => {
    it('the token comes out of the PRIVATE home the login wrote it in', () => {
        const loginHome = join(root, 'private-home');
        mkdirSync(join(loginHome, '.cursor'), { recursive: true });
        writeFileSync(join(loginHome, '.cursor', 'auth.json'), '{"accessToken":"a.b.c"}\n');
        expect(cursorAuthHarvest(loginHome)).toBe('a.b.c');
    });

    it('a login that wrote NO credential harvests nothing, not somebody else\'s', () => {
        // The shared Keychain slot is machine-wide and holds whatever ran last.
        // Reading it would attach a STRANGER's credential to the new row, and
        // the registry would then be lying about whose subscription it bills.
        const loginHome = join(root, 'empty-home');
        mkdirSync(loginHome, { recursive: true });
        expect(cursorAuthHarvest(loginHome)).toBeUndefined();
        expect(cursorAuthIdentity(loginHome)).toBeUndefined();
    });

    it('the address comes from cursor-agent\'s own cache, with no network call', () => {
        const loginHome = join(root, 'named-home');
        mkdirSync(join(loginHome, '.cursor'), { recursive: true });
        writeFileSync(join(loginHome, '.cursor', 'cli-config.json'),
            '{"authInfo":{"email":"jam@example.com","displayName":"Jam"}}\n');
        expect(cursorAuthIdentity(loginHome)).toBe('jam@example.com');
    });

    it('displayName is the fallback, and `false` falls through the way jq // does', () => {
        const loginHome = join(root, 'display-home');
        mkdirSync(join(loginHome, '.cursor'), { recursive: true });
        writeFileSync(join(loginHome, '.cursor', 'cli-config.json'),
            '{"authInfo":{"email":false,"displayName":"Jam"}}\n');
        expect(cursorAuthIdentity(loginHome)).toBe('Jam');
    });
});

describe('cursor-login: the date on the success line', () => {
    it('is a LOCAL day, the way `date -r <exp> +%Y-%m-%d` prints one', () => {
        const at = 1_800_000_000;
        const sh = spawnSync('sh', ['-c', `date -r ${at} '+%Y-%m-%d' 2>/dev/null || date -d @${at} '+%Y-%m-%d'`],
            { encoding: 'utf8' });
        expect(fmtEpochDay(at)).toBe(sh.stdout.trim());
    });
});

// --- what a card that is not answered means ----------------------------------

describe('cursor-login: a stray answer re-arms the card rather than deciding', () => {
    /**
     * The app draws a code field on the `account-login` gate, and there is no
     * code in a cursor login. Saying "wrong" to a man who typed something into
     * a field the app showed him would be blaming him for the app — so a
     * non-cancel answer raises the SAME link again.
     */
    it('a non-cancel answer asks again with the same link; cancel ends it', async () => {
        const answers = ['typed-a-code', 'cancel'];
        const raised: string[][] = [];
        const asks: AskRun[] = [];
        const makeAsk = (argv: string[]): AskRun => {
            raised.push(argv);
            const text = answers.shift() ?? 'cancel';
            const runOne: AskRun = {
                done: Promise.resolve({ code: 0, text }),
                running: () => false,
                stop: () => {},
            };
            asks.push(runOne);
            return runOne;
        };

        const paneText = read('cursor-pane-link.txt');
        const windowIo: WindowIo = {
            env: { ...fixture } as NodeJS.ProcessEnv,
            tmux: (_bin, args) => {
                const key = args[2];
                if (key === 'list-sessions') return { status: 0, stdout: '9 9 1 work\n', stderr: '' };
                if (key === 'list-windows') return { status: 0, stdout: 'bash\n', stderr: '' };
                if (key === 'new-window') return { status: 0, stdout: '%5\n', stderr: '' };
                if (key === 'set-option') return { status: 0, stdout: '', stderr: '' };
                if (key === 'capture-pane') return { status: 0, stdout: paneText, stderr: '' };
                // The pane stays LIVE, so the card is what ends the run.
                if (key === 'display-message') return { status: 0, stdout: '0\n', stderr: '' };
                throw new Error(`unmodelled tmux: ${args.join(' ')}`);
            },
            which: (name) => (name === 'tmux' ? '/fixture/tmux' : null),
            err: () => {},
        };
        const nd = await node(['jam', '--no-window'], { DROVER_LOGIN_WINDOW: '' }, {
            window: new DroverWindow(windowIo),
            which: (name) => (name === 'cursor-agent' ? '/fixture/cursor-agent' : whichIn(fixture.PATH, name)),
            mkdtemp: () => mkdtempSync(join(root, 'work-')),
            rmrf: () => {},
            ask: (argv) => makeAsk(argv),
            alive: () => false,
            signal: () => {},
        });

        // Cancelled from the phone, with the shell's sentence and exit 1.
        expect(nd.code).toBe(1);
        expect(nd.stderr).toBe('drover account login: cancelled from the phone\n');
        // TWO cards, and both carry the SAME link: the stray answer re-armed it.
        expect(raised).toHaveLength(2);
        expect(raised[0][4]).toBe(read('cursor-pane-link.url').trimEnd());
        expect(raised[1][4]).toBe(raised[0][4]);
        expect(raised[0][2]).toContain('Watch it in tmux: work:login-cursor-jam');
        // And the failure went to the phone as well as to stderr.
        expect(nd.notices).toHaveLength(1);
        expect(nd.notices[0].reason).toBe('cancelled from the phone');
        // Nothing was written: no registry row, no token.
        const registry = JSON.parse(readFileSync(fixture.DROVER_ACCOUNTS, 'utf8')) as { name: string }[];
        expect(registry.map((r) => r.name)).toEqual(['main', 'clay@example.com']);
        expect(existsSync(join(fixture.STATE_DIR, 'cursor-auth.json'))).toBe(false);
    });
});

describe('cursor-login: usage is the shell heredoc', () => {
    it('names the window to watch and refuses to promise an API key', () => {
        expect(usage).toContain('login-cursor-<account>');
        expect(usage).not.toContain('CURSOR_API_KEY');
    });
});
