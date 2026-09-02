/**
 * The watchable window, measured against the shell it was ported from
 * (DROVE-315 wave 4).
 *
 * TWO IMPLEMENTATIONS, ONE FIXTURE. The pure half — the slug, the window name
 * that is also the lock, the session pick, the pane bootstrap, the DROVE-365
 * refusals — is run in cattle-drover's OWN shell, by sourcing lib/drover-*.sh
 * and calling the function, and compared byte for byte with this module's
 * answer. Nothing is retyped into an expectation: the shell is asked.
 *
 * NOTHING HERE STARTS A TMUX SERVER. Every tmux call goes through the injected
 * WindowIo, and the double answers from a scripted table; a call it does not
 * model THROWS, so a branch that reached for Clay's own server fails the test
 * rather than opening a window on it. The shell side only ever runs `sh -c`
 * over functions that fork nothing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverEnv } from '../env';
import {
    DroverWindow,
    droverWindowBoot,
    droverWindowPick,
    droverWindowSlug,
    loginWindowBootVars,
    loginWindowKill,
    loginWindowName,
    type TmuxResult,
    type WindowIo,
    windowSessionsFormat,
} from './droverWindow';

/**
 * A throwaway HAPPY_HOME_DIR, pinned above every import (DROVE-336).
 *
 * A bench that did not set it once registered seventy-eight real sessions on
 * Clay's phone, because the entry takes an unknown word to Claude and Claude
 * registers. Nothing in this file goes near the entry, and this is what makes
 * that a fact rather than an intention.
 */
const { happyHome, realHappyHome } = await vi.hoisted(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const realHappyHome = path.join(os.homedir(), '.happy');
    const happyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'droverwindow-happy-'));
    process.env.HAPPY_HOME_DIR = happyHome;
    process.env.HAPPY_SERVER_URL = 'http://127.0.0.1:1';
    return { happyHome, realHappyHome };
});

vi.mock('../../../configuration', () => {
    throw new Error('droverWindow.test: configuration was imported; this helper must not reach the session machinery');
});
vi.mock('../../../api/api', () => {
    throw new Error('droverWindow.test: api/api was imported; this helper must not reach the session machinery');
});

function refuseRealHappyHome(where: string): void {
    const raw = process.env.HAPPY_HOME_DIR;
    const at = raw ? resolve(raw.replace(/^~/, homedir())) : resolve(realHappyHome);
    if (at === resolve(realHappyHome)) {
        throw new Error(`${where}: HAPPY_HOME_DIR resolves to the real ${realHappyHome}. Refusing.`);
    }
}

const droverDir = droverEnv({ ...process.env, DROVER_DIR: process.env.DROVER_DIR }).droverDir;
const haveShell = existsSync(join(droverDir, 'lib', 'drover-window.sh'));

/**
 * Run a shell snippet with cattle-drover's own libraries sourced.
 *
 * `env -i`-shaped: HOME is a throwaway and DROVER_URL points at a closed port,
 * so nothing sourced here can find, read or post to anything of Clay's. Only
 * pure functions are ever called — nothing below forks a tmux.
 */
let shellHome = '';
function shell(snippet: string, extra: Record<string, string> = {}): { out: string; code: number } {
    refuseRealHappyHome('droverWindow.test: shell');
    const script = [
        `cd ${JSON.stringify(droverDir)}`,
        '. ./etc/drover.env',
        '. ./lib/drover-tmux-entry.sh',
        '. ./lib/drover-window.sh',
        '. ./lib/drover-login-session.sh',
        snippet,
    ].join('\n');
    const r = spawnSync('sh', ['-c', script], {
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH ?? '',
            HOME: shellHome,
            LANG: process.env.LANG ?? 'en_US.UTF-8',
            STATE_DIR: join(shellHome, 'state'),
            DROVER_DIR: droverDir,
            DROVER_URL: 'http://127.0.0.1:1',
            HAPPY_HOME_DIR: happyHome,
            ...extra,
        },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 0 };
}

// --- the tmux double ----------------------------------------------------------

interface Call {
    args: string[];
    input?: string;
}

/**
 * A tmux that answers from a script and THROWS on anything else.
 *
 * The throw is the point. A branch this file forgot to model would otherwise
 * reach `spawnSync('tmux', …)` and open a window on Clay's own server; here it
 * fails the test naming the call it wanted.
 */
function scriptedIo(answers: Record<string, TmuxResult | undefined>, env: Record<string, string | undefined> = {}): {
    io: WindowIo;
    calls: Call[];
    errs: string[];
} {
    const calls: Call[] = [];
    const errs: string[] = [];
    const io: WindowIo = {
        env: { PATH: '/fixture/bin', ...env },
        tmux: (bin, args, input) => {
            expect(bin).toBe(env.DROVER_TMUX_BIN ?? 'tmux');
            calls.push({ args, input });
            // The `-L <socket>` prefix every call carries is stripped for the
            // key, so the script reads as the tmux subcommand it models.
            const key = args.slice(2).join(' ');
            for (const [pattern, answer] of Object.entries(answers)) {
                if (key === pattern || key.startsWith(`${pattern} `)) {
                    if (answer === undefined) break;
                    return answer;
                }
            }
            throw new Error(`droverWindow.test: unmodelled tmux call: ${args.join(' ')}`);
        },
        which: (name) => (name === 'tmux' ? '/fixture/bin/tmux' : null),
        err: (line) => errs.push(line),
    };
    return { io, calls, errs };
}

const ok = (stdout = ''): TmuxResult => ({ status: 0, stdout, stderr: '' });
const no = (): TmuxResult => ({ status: 1, stdout: '', stderr: 'no server running' });

beforeAll(() => {
    refuseRealHappyHome('droverWindow.test');
    shellHome = mkdtempSync(join(tmpdir(), 'droverwindow-home-'));
});

afterAll(() => {
    const left = existsSync(happyHome) ? readdirSync(happyHome) : [];
    expect(left).toEqual([]);
    rmSync(happyHome, { recursive: true, force: true });
    if (shellHome !== '') rmSync(shellHome, { recursive: true, force: true });
});

// --- the pure half, against the shell ----------------------------------------

describe.runIf(haveShell)('droverWindow: the slug the shell computes', () => {
    for (const value of [
        'clayrisser@gmail.com',
        'account-3',
        'a b/c.d:e',
        'alt',
        'x_y-z',
        '',
        'UPPER.case+plus@example.co.uk',
    ]) {
        it(`'${value}' slugs exactly as tr -c did`, () => {
            const said = shell(`drover_window_slug ${JSON.stringify(value)}`);
            expect(droverWindowSlug(value)).toBe(said.out);
        });
    }
});

describe.runIf(haveShell)('droverWindow: the window name, which is also the lock', () => {
    for (const [harness, spelling] of [
        ['claude', 'alt'],
        ['claude', 'account-3'],
        ['claude', 'new'],
        ['cursor', 'clayrisser@gmail.com'],
        ['cursor', 'new'],
    ] as const) {
        it(`login_window_name ${harness} '${spelling}'`, () => {
            const said = shell(`login_window_name ${harness} ${JSON.stringify(spelling)}`);
            expect(loginWindowName(harness, spelling)).toBe(said.out);
        });
    }

    it('the harness is IN the name, so cursor and claude cannot collide', () => {
        expect(loginWindowName('claude', 'new')).toBe('login-claude-new');
        expect(loginWindowName('cursor', 'new')).toBe('login-cursor-new');
        expect(loginWindowName('claude', 'new')).not.toBe(loginWindowName('cursor', 'new'));
    });
});

describe.runIf(haveShell)('droverWindow: which session a window hangs on', () => {
    const listings = [
        '5 9 0 old one\n9 1 0 newest\n5 9 1 attached',
        '0 0 0 never attached\n7 7 1 current',
        '3 3 0 only one',
        '4 4 0 a name with spaces in it\n9 9 0 winner',
    ];
    for (const listing of listings) {
        it(`picks what sort -k1,1nr -k3,3nr -k2,2nr picked: ${JSON.stringify(listing.split('\n')[0])}…`, () => {
            // Through the environment, not through the command line: the
            // listing is multi-line and a quoted argument would arrive as one.
            const said = shell('drover_window_pick "$LISTING"', { LISTING: listing });
            expect(droverWindowPick(listing)).toBe(said.out.replace(/\n$/, ''));
        });
    }

    it('the format string is the shell\'s, byte for byte', () => {
        expect(windowSessionsFormat).toBe(shell('drover_window_sessions_fmt').out);
    });

    it('a never-attached session sorts LAST, because it is the worst place to look', () => {
        expect(droverWindowPick('0 0 0 never attached\n1 1 0 seen once')).toBe('seen once');
    });
});

describe.runIf(haveShell)('droverWindow: the pane bootstrap', () => {
    it('is the shell\'s $drover_window_boot, byte for byte', () => {
        // It is the same `sh -c` argument in both, so a paraphrase would be a
        // different program running in the pane.
        expect(droverWindowBoot).toBe(shell('printf \'%s\' "$drover_window_boot"').out);
    });

    it('sets remain-on-exit from INSIDE the pane, before it execs', () => {
        // From outside it would be new-window then set-option, with a command
        // running in between — and a command that exits inside that gap takes
        // its window and its outcome with it.
        expect(droverWindowBoot).toContain('remain-on-exit on');
        expect(droverWindowBoot.indexOf('remain-on-exit')).toBeLessThan(droverWindowBoot.indexOf('exec "$@"'));
    });

    it('applies PATH under its OWN name, because -e PATH never reaches a pane', () => {
        expect(droverWindowBoot).toContain('DROVER_WINDOW_PATH');
        expect(droverWindowBoot).toContain('unset DROVER_WINDOW_PATH');
    });
});

describe.runIf(haveShell)('droverWindow: the DROVE-365 refusal', () => {
    it('an empty command is refused with the shell\'s sentence and never reaches tmux', () => {
        const said = shell('drover_window_argv "" 2>&1; echo "rc=$?"');
        const { io, calls, errs } = scriptedIo({});
        const window = new DroverWindow(io);
        expect(window.argvOk([''])).toBe(false);
        expect(said.out).toContain(errs[0]);
        expect(said.out).toContain('rc=1');
        expect(calls).toEqual([]);
    });

    it('a command that begins with an option is refused, quoting the token', () => {
        const said = shell('drover_window_argv "-n" 2>&1; echo "rc=$?"');
        const { io, calls, errs } = scriptedIo({});
        const window = new DroverWindow(io);
        expect(window.argvOk(['-n', 'cursor'])).toBe(false);
        expect(said.out).toContain(errs[0]);
        expect(errs[0]).toContain("'-n' is not a program to run");
        expect(calls).toEqual([]);
    });

    it('a real program passes', () => {
        const { io } = scriptedIo({});
        expect(new DroverWindow(io).argvOk(['sh', '-c', 'true'])).toBe(true);
    });

    it('open refuses before it asks tmux for anything', () => {
        const { io, calls } = scriptedIo({});
        const window = new DroverWindow(io);
        expect(window.open('login-cursor-new', '/home/x', ['-n', 'cursor'])).toEqual({ status: 1, pane: '' });
        expect(calls).toEqual([]);
    });

    it('add refuses the same way', () => {
        const { io, calls } = scriptedIo({});
        expect(new DroverWindow(io).add('%3', [''])).toBeNull();
        expect(calls).toEqual([]);
    });
});

// --- the tmux half, on a scripted server -------------------------------------

describe('droverWindow: opening one', () => {
    const sessions = `9 9 1 work\n1 1 0 old`;

    it('opens it DETACHED, named, in the most recently attached session', () => {
        const { io, calls } = scriptedIo({
            'list-sessions': ok(`${sessions}\n`),
            'list-windows': ok('bash\neditor\n'),
            'new-window': ok('%7\n'),
            'set-option': ok(),
        });
        const window = new DroverWindow(io);
        window.envReset();
        window.envAdd('CLAUDE_CONFIG_DIR', '/h/.claude-accounts/account-3');
        const opened = window.open('login-claude-account-3', '/h', ['sh', '-c', 'exec "$0" auth login', '/bin/claude']);
        expect(opened).toEqual({ status: 0, pane: '%7' });

        const created = calls.find((c) => c.args[2] === 'new-window');
        expect(created).toBeDefined();
        const argv = created!.args;
        // -d always: this never steals the view of whoever is attached.
        expect(argv).toContain('-d');
        // The session with NO window index, so tmux picks the next free one
        // under the user's own base-index.
        expect(argv[argv.indexOf('-t') + 1]).toBe('work:');
        expect(argv[argv.indexOf('-n') + 1]).toBe('login-claude-account-3');
        // The environment the caller accumulated, then PATH under its own name.
        expect(argv).toContain('CLAUDE_CONFIG_DIR=/h/.claude-accounts/account-3');
        expect(argv).toContain('DROVER_WINDOW_PATH=/fixture/bin');
        // Everything after `--` is the pane's argv, bootstrap first.
        const rest = argv.slice(argv.lastIndexOf('--') + 1);
        expect(rest.slice(0, 5)).toEqual(['sh', '-c', droverWindowBoot, 'drover-window', '/fixture/bin/tmux']);
        expect(rest.slice(5)).toEqual(['sh', '-c', 'exec "$0" auth login', '/bin/claude']);
        // And it is STAMPED, so nothing can ever kill a window drover did not open.
        const stamped = calls.find((c) => c.args[2] === 'set-option');
        expect(stamped!.args).toEqual(['-L', 'default', 'set-option', '-w', '-t',
            'work:login-claude-account-3', '@drover-window', 'login-claude-account-3']);
    });

    it('with NO server it starts one 200x50, the way the entry does', () => {
        const { io, calls } = scriptedIo({
            'list-sessions': no(),
            'new-session': ok('0\n'),
            'list-windows': ok(''),
            'new-window': ok('%1\n'),
            'set-option': ok(),
        });
        const window = new DroverWindow(io);
        expect(window.open('login-cursor-new', '/h', ['cursor-agent', 'login']).pane).toBe('%1');
        const made = calls.find((c) => c.args[2] === 'new-session')!;
        // No `-s`: the user gets the session they would have had if they had
        // typed `tmux` themselves. 200 columns because a login URL is 300-odd
        // characters and a server with no client gives a pane 80.
        expect(made.args).toEqual(['-L', 'default', 'new-session', '-d', '-x', '200', '-y', '50',
            '-P', '-F', '#{session_name}']);
        expect(made.args).not.toContain('-s');
    });

    it('a window still RUNNING something is refused with 2, not stacked beside', () => {
        const { io, calls } = scriptedIo({
            'list-sessions': ok(`${sessions}\n`),
            'list-windows': ok('login-claude-alt\n'),
            'list-panes': ok('0\n'),
        });
        const window = new DroverWindow(io);
        expect(window.open('login-claude-alt', '/h', ['claude'])).toEqual({ status: 2, pane: '' });
        expect(calls.some((c) => c.args[2] === 'new-window')).toBe(false);
        expect(calls.some((c) => c.args[2] === 'respawn-pane')).toBe(false);
    });

    it('a CORPSE is respawned in place, so a flow started twice leaves ONE window', () => {
        let panes = 0;
        const { io, calls } = scriptedIo({
            'list-sessions': ok(`${sessions}\n`),
            'list-windows': ok('login-claude-alt\n'),
            'list-panes': undefined,
            'respawn-pane': ok(),
            'set-option': ok(),
        });
        // list-panes answers `#{pane_dead}` first (all dead) and then the pane
        // id the respawn produced, which is the same window's first pane.
        const raw = io.tmux;
        io.tmux = (bin, args, input) => {
            if (args[2] === 'list-panes') {
                panes += 1;
                return panes === 1 ? ok('1\n') : ok('%4\n');
            }
            return raw(bin, args, input);
        };
        const window = new DroverWindow(io);
        expect(window.open('login-claude-alt', '/h', ['claude'])).toEqual({ status: 0, pane: '%4' });
        expect(calls.some((c) => c.args[2] === 'new-window')).toBe(false);
        const again = calls.find((c) => c.args[2] === 'respawn-pane')!;
        expect(again.args.slice(3, 6)).toEqual(['-k', '-t', 'work:login-claude-alt']);
    });

    it('a second pane in the SAME window is a split, and inherits remain-on-exit', () => {
        const { io, calls } = scriptedIo({ 'split-window': ok('%9\n') });
        const window = new DroverWindow(io);
        window.envReset();
        window.envAdd('HOME', '/tmp/private-home');
        expect(window.add('%3', ['sh', '-c', 'exec "$0" login', '/bin/cursor-agent'])).toBe('%9');
        const split = calls[0].args;
        expect(split.slice(2, 8)).toEqual(['split-window', '-d', '-t', '%3', '-P', '-F']);
        expect(split).toContain('HOME=/tmp/private-home');
        // No list-sessions: a split names a PANE, so it never has to resolve
        // which session the window is in.
        expect(calls).toHaveLength(1);
    });
});

describe('droverWindow: liveness, ownership and reaping', () => {
    const base = { 'list-sessions': ok('9 9 1 work\n') };

    it('#{pane_dead} is the liveness question, not "does the pane exist"', () => {
        const live = new DroverWindow(scriptedIo({ ...base, 'display-message': ok('0\n') }).io);
        expect(live.paneLive('%2')).toBe(true);
        const dead = new DroverWindow(scriptedIo({ ...base, 'display-message': ok('1\n') }).io);
        expect(dead.paneLive('%2')).toBe(false);
        // A pane that has gone entirely answers nothing, which is also not alive.
        const gone = new DroverWindow(scriptedIo({ ...base, 'display-message': no() }).io);
        expect(gone.paneLive('%2')).toBe(false);
    });

    it('a window nothing stamped is the USER\'S and is never killed', () => {
        const { io, calls } = scriptedIo({
            ...base,
            'show-options': ok('\n'),
        });
        const window = new DroverWindow(io);
        expect(window.owned('login-claude-alt')).toBe(false);
        expect(window.kill('login-claude-alt')).toBe(false);
        expect(calls.some((c) => c.args[2] === 'kill-window')).toBe(false);
    });

    it('a window drover stamped is killed, and the kill is the process group', () => {
        const { io, calls } = scriptedIo({
            ...base,
            'show-options': ok('login-claude-alt\n'),
            'list-windows': ok('login-claude-alt\n'),
            'kill-window': ok(),
        });
        const window = new DroverWindow(io);
        expect(loginWindowKill(window, ['login-claude-alt', '', 'never-opened'])).toBe(true);
        const killed = calls.find((c) => c.args[2] === 'kill-window')!;
        expect(killed.args.slice(2)).toEqual(['kill-window', '-t', 'work:login-claude-alt']);
    });

    it('killing nothing answers false, so a caller can say "there was none"', () => {
        const { io } = scriptedIo({ ...base, 'list-windows': ok('bash\n') });
        expect(loginWindowKill(new DroverWindow(io), ['login-claude-alt'])).toBe(false);
    });

    it('idle is "no pane still running", which a dead one satisfies', () => {
        const dead = new DroverWindow(scriptedIo({ ...base, 'list-panes': ok('1\n1\n') }).io);
        expect(dead.idle('w')).toBe(true);
        const busy = new DroverWindow(scriptedIo({ ...base, 'list-panes': ok('1\n0\n') }).io);
        expect(busy.idle('w')).toBe(false);
    });

    it('the target and the watch fragment are what a human types and reads', () => {
        const window = new DroverWindow(scriptedIo(base).io);
        expect(window.target('login-cursor-jam')).toBe('work:login-cursor-jam');
        expect(window.watch('login-cursor-jam')).toBe('Watch it in tmux: work:login-cursor-jam');
    });

    it('the session is resolved ONCE, however many targets are asked for', () => {
        const { io, calls } = scriptedIo(base);
        const window = new DroverWindow(io);
        window.target('a');
        window.target('b');
        window.watch('c');
        expect(calls.filter((c) => c.args[2] === 'list-sessions')).toHaveLength(1);
    });
});

describe('droverWindow: which server', () => {
    it('every call carries -L explicitly, because a bare tmux follows $TMUX', () => {
        const { io, calls } = scriptedIo({ 'list-sessions': ok('9 9 1 work\n') }, { DROVER_TMUX_SOCKET: 'bats-1' });
        new DroverWindow(io).session();
        expect(calls[0].args.slice(0, 2)).toEqual(['-L', 'bats-1']);
    });

    it('DROVER_TMUX_BIN moves the binary, and the pane is told the ABSOLUTE one', () => {
        const { io, calls } = scriptedIo(
            { 'list-sessions': ok('9 9 1 work\n'), 'list-windows': ok(''), 'new-window': ok('%1\n'), 'set-option': ok() },
            { DROVER_TMUX_BIN: 'tmux' },
        );
        io.which = () => '/opt/homebrew/bin/tmux';
        new DroverWindow(io).open('w', '/h', ['true']);
        const created = calls.find((c) => c.args[2] === 'new-window')!;
        expect(created.args).toContain('/opt/homebrew/bin/tmux');
    });

    it('a login socket is refused outright rather than handed an empty -L', () => {
        const { io } = scriptedIo({}, { DROVER_TMUX_SOCKET: 'drover-login' });
        expect(() => new DroverWindow(io).session()).toThrow(/may not name drover's own login server/);
    });
});

describe('droverWindow: what travels into a login window', () => {
    it('is the shell\'s list, in the shell\'s order', () => {
        expect([...loginWindowBootVars]).toEqual([
            'HOME', 'DROVER_URL', 'DROVER_DIR', 'DROVER_BIN', 'DROVER_ACCOUNTS',
            'STATE_DIR', 'DROVER_SHARED_STORE', 'DROVER_TMUX_SOCKET', 'DROVER_TMUX_BIN',
        ]);
    });

    it('and PATH is NOT in it, because -e PATH never reaches the pane', () => {
        expect([...loginWindowBootVars]).not.toContain('PATH');
    });
});
