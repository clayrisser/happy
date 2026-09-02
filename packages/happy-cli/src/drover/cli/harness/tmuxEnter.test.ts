/**
 * The smoke test for the shared pane opener (DROVE-315 wave 3a).
 *
 * cattle-drover/tests/tmux-entry.bats is the spec and it stays green until the
 * shell file leaves. This is the node twin of the parts that can be asserted
 * without a tmux server: the state machine, the quoting, the session choice,
 * the environment forwarding, the refusals — every tmux call goes through an
 * injected io, so nothing here reaches a real server, least of all the default
 * socket Clay is working in.
 *
 * The one differential case runs the SHELL file's `--help` and compares it
 * byte for byte with the node help, which is the assertion that the port did
 * not quietly reword anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    droverQuoteArgs,
    droverTmuxHavePane,
    droverTmuxSocket,
    droverTmuxState,
    shQuote,
    TmuxSocketError,
} from './tmuxEntry';
import {
    chooseSession,
    commandLine,
    forwardedEnv,
    parseEnterArgs,
    isParseFailure,
    reenterLine,
    runEnter,
    sessionNames,
    splitShellWords,
    usage,
    type EnterIo,
} from './tmuxEnter';

const shellEnter = '/Users/clayrisser/Projects/bitspur/cattle-drover/libexec/drover-tmux-enter';

/** An io that records everything and reaches nothing. */
function fakeIo(over: Partial<EnterIo> = {}): EnterIo & { lines: string[]; errs: string[]; calls: string[][] } {
    const lines: string[] = [];
    const errs: string[] = [];
    const calls: string[][] = [];
    const io = {
        env: {} as Record<string, string | undefined>,
        cwd: '/work',
        isTty: () => false,
        out: (l: string) => { lines.push(l); },
        err: (l: string) => { errs.push(l); },
        tmux: (bin: string, args: string[]) => {
            calls.push([bin, ...args]);
            return { status: 1, stdout: '', stderr: '' };
        },
        passthrough: (bin: string, args: string[]) => {
            calls.push(['PASS', bin, ...args]);
            return 0;
        },
        which: (n: string) => (n === 'tmux' ? '/fake/tmux' : null),
        lines,
        errs,
        calls,
        ...over,
    };
    return io as EnterIo & { lines: string[]; errs: string[]; calls: string[][] };
}

describe('the tmux state machine (lib/drover-tmux-entry.sh)', () => {
    it('no $TMUX is outside', () => {
        expect(droverTmuxState({})).toBe('outside');
        expect(droverTmuxHavePane({})).toBe(false);
    });

    it('$TMUX naming the target socket is inside', () => {
        const env = { TMUX: '/tmp/tmux-501/mine,999,0', DROVER_TMUX_SOCKET: 'mine' };
        expect(droverTmuxState(env)).toBe('inside');
        expect(droverTmuxHavePane(env)).toBe(true);
    });

    it('$TMUX on a DIFFERENT socket is nested, not already-inside', () => {
        const env = { TMUX: '/tmp/tmux-501/somebody-elses,999,0', DROVER_TMUX_SOCKET: 'mine' };
        expect(droverTmuxState(env)).toBe('nested');
        // Still a real pane, so still a home for a session.
        expect(droverTmuxHavePane(env)).toBe(true);
    });

    it('$TMUX inside a drover-login pane is the login state, and is NOT a pane', () => {
        const env = { TMUX: '/tmp/tmux-501/drover-login,999,0' };
        expect(droverTmuxState(env)).toBe('login');
        // The whole reason the socket is the question: a real session must not
        // be left in the throwaway server a login flow is about to close.
        expect(droverTmuxHavePane(env)).toBe(false);
    });

    it('DROVER_TMUX_SOCKET may not name a login socket', () => {
        expect(() => droverTmuxSocket({ DROVER_TMUX_SOCKET: 'drover-login' })).toThrow(TmuxSocketError);
        expect(() => droverTmuxSocket({ DROVER_TMUX_SOCKET: 'drover-login' }))
            .toThrow('may not name drover\'s own login server');
        expect(droverTmuxSocket({})).toBe('default');
    });
});

describe('quoting, which is what makes a re-entry survive', () => {
    it('matches drover_quote_args: leading space, single-quoted throughout', () => {
        expect(droverQuoteArgs(['two words', "it's"])).toBe(" 'two words' 'it'\\''s'");
        expect(droverQuoteArgs([])).toBe('');
    });

    it('shQuote is total: nothing in a value can become syntax', () => {
        expect(shQuote('a b')).toBe("'a b'");
        expect(shQuote("it's")).toBe("'it'\\''s'");
        expect(shQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    });

    it('the dry-run re-entry line is the shell\'s, byte for byte', () => {
        expect(reenterLine('/d/libexec', 'drover-codex', ['--config', 'a b'], '/work'))
            .toBe("/d/libexec/drover-tmux-enter --cwd /work -- /d/libexec/drover-codex '--config' 'a b'");
    });

    it('--command is split back into words, honouring the quoting that built it', () => {
        expect(splitShellWords("sh -c 'while :; do sleep 30; done'"))
            .toEqual(['sh', '-c', 'while :; do sleep 30; done']);
        expect(splitShellWords("drover --seed '/My Projects/seed.md'"))
            .toEqual(['drover', '--seed', '/My Projects/seed.md']);
        // A string carrying shell syntax is passed through as literal text,
        // never run: this splits words, it does not evaluate.
        expect(splitShellWords('echo "$(id)"')).toEqual(['echo', '$(id)']);
    });

    it('commandLine re-quotes for the in-place run', () => {
        expect(commandLine(['sh', '-c', "echo 'hi'"])).toBe("'sh' '-c' 'echo '\\''hi'\\'''");
    });
});

describe('the option loop', () => {
    it('--command and trailing arguments are refused together', () => {
        const r = parseEnterArgs(['--command', 'true', '--', 'false']);
        expect(isParseFailure(r)).toBe(true);
        if (isParseFailure(r)) {
            expect(r.code).toBe(2);
            expect(r.error[0]).toBe('drover tmux-enter: --command and trailing arguments say the same thing');
        }
    });

    it('an unknown option exits 2 and names itself', () => {
        const r = parseEnterArgs(['--nope', '--', 'true']);
        expect(isParseFailure(r)).toBe(true);
        if (isParseFailure(r)) {
            expect(r.code).toBe(2);
            expect(r.error[0]).toBe("drover tmux-enter: unknown option '--nope' (try --help)");
        }
    });

    it('no command at all exits 2', () => {
        const r = parseEnterArgs(['--no-attach']);
        expect(isParseFailure(r)).toBe(true);
        if (isParseFailure(r)) expect(r.code).toBe(2);
    });

    it('both spellings of every option land in the same place', () => {
        const r = parseEnterArgs(['--cwd=/a', '--name=win', '--session=main', '--print=#{pane_pid}',
            '-eA=1', '-e', 'B=2', '--no-forward-env', '-q', '--', 'true']);
        expect(isParseFailure(r)).toBe(false);
        if (!isParseFailure(r)) {
            expect(r).toMatchObject({
                cwd: '/a', name: 'win', session: 'main', print: '#{pane_pid}',
                quiet: true, forwardEnv: false, envOpts: ['A=1', 'B=2'], command: ['true'],
            });
        }
    });
});

describe('which session a window lands in', () => {
    const listing = [
        '100 900 0 alpha',
        '300 100 0 beta gamma',
        '0 999 0 never attached',
    ].join('\n');

    it('the most recently attached wins, not the first listed', () => {
        expect(chooseSession(listing)).toEqual({ name: 'beta gamma', count: 3 });
    });

    it('a name with spaces survives, because it is read as the rest of the line', () => {
        expect(sessionNames(listing)).toEqual(['alpha', 'beta gamma', 'never attached']);
    });
});

describe('what the window inherits', () => {
    it('carries DROVER_*, HAPPY_* and CLAUDE_CONFIG_DIR and nothing else', () => {
        const got = forwardedEnv({
            DROVER_SERVER_MODE: 'relay',
            HAPPY_HOME_DIR: '/tmp/throwaway',
            CLAUDE_CONFIG_DIR: '/tmp/some-account',
            PATH: '/usr/bin',
            AWS_SECRET_ACCESS_KEY: 'nope',
        });
        expect(got.sort()).toEqual([
            'CLAUDE_CONFIG_DIR=/tmp/some-account',
            'DROVER_SERVER_MODE=relay',
            'HAPPY_HOME_DIR=/tmp/throwaway',
        ]);
    });

    it('the entry machinery\'s own state does NOT reach the window', () => {
        // Telling the command in the window to skip the pane requirement it
        // was just given is the bug this denylist exists for.
        expect(forwardedEnv({
            DROVER_ALLOW_NO_TMUX: '1',
            DROVER_CHECKED: '1',
            DROVER_DRY_RUN: '1',
        })).toEqual([]);
    });
});

describe('runEnter', () => {
    it('runs in place when already inside the user\'s server, and opens nothing', async () => {
        const io = fakeIo();
        io.env = { TMUX: '/tmp/tmux-501/mine,9,0', DROVER_TMUX_SOCKET: 'mine' };
        const code = await runEnter(['--', 'true', 'x'], io);
        expect(code).toBe(0);
        expect(io.calls).toEqual([['PASS', 'true', 'x']]);
        expect(io.errs).toEqual([]);
    });

    it('nested runs in place and says which socket it is actually on', async () => {
        const io = fakeIo();
        io.env = { TMUX: '/tmp/tmux-501/somebody-elses,9,0', DROVER_TMUX_SOCKET: 'mine' };
        const code = await runEnter(['--', 'true'], io);
        expect(code).toBe(0);
        expect(io.errs.join('\n')).toContain("which is not 'mine' — running here.");
        // It did NOT reach for the user's server.
        expect(io.calls.filter((c) => c[0] !== 'PASS')).toEqual([]);
    });

    it('--attach without a terminal is refused up front, before anything is opened', async () => {
        const io = fakeIo();
        const code = await runEnter(['--attach', '--', 'true'], io);
        expect(code).toBe(3);
        expect(io.errs[0]).toBe('drover: --attach needs a terminal and this invocation has none.');
        expect(io.calls).toEqual([]);
    });

    it('no tmux at all says how to install one and exits 127', async () => {
        const io = fakeIo({ which: () => null });
        const code = await runEnter(['--', 'true'], io);
        expect(code).toBe(127);
        expect(io.errs.join('\n')).toContain('a drover session lives in a tmux pane');
        expect(io.errs.join('\n')).toContain('DROVER_ALLOW_NO_TMUX=1');
    });

    it('no server: starts one with tmux\'s own default name and no index of ours', async () => {
        const io = fakeIo({
            tmux: (bin, args) => {
                if (args.includes('list-sessions')) return { status: 1, stdout: '', stderr: '' };
                return { status: 0, stdout: '0\n', stderr: '' };
            },
        });
        (io as unknown as { calls: string[][] }).calls = [];
        const seen: string[][] = [];
        io.tmux = (bin, args) => {
            seen.push(args);
            if (args.includes('list-sessions')) return { status: 1, stdout: '', stderr: '' };
            return { status: 0, stdout: '0\n', stderr: '' };
        };
        const code = await runEnter(['--', 'sh', '-c', 'true'], io);
        expect(code).toBe(0);
        const create = seen.find((a) => a.includes('new-session'));
        expect(create).toBeDefined();
        // No -s: the session gets tmux's own default name, so `tmux ls` never
        // shows a name the user did not choose.
        expect(create).not.toContain('-s');
        expect(create?.slice(-3)).toEqual(['sh', '-c', 'true']);
    });

    it('server running: one window, no index, and -d when not attaching', async () => {
        const seen: string[][] = [];
        const io = fakeIo({
            tmux: (bin, args) => {
                seen.push(args);
                if (args.includes('list-sessions')) return { status: 0, stdout: '5 5 0 main\n', stderr: '' };
                return { status: 0, stdout: '', stderr: '' };
            },
        });
        const code = await runEnter(['--no-attach', '--', 'true'], io);
        expect(code).toBe(0);
        const win = seen.find((a) => a.includes('new-window'));
        expect(win).toBeDefined();
        // `=main:` — the session with NO window index, so tmux applies the
        // user's own base-index and nothing collides.
        expect(win).toContain('=main:');
        expect(win).toContain('-d');
        // None of the flags that move an existing window around.
        for (const banned of ['-a', '-b', '-k', '-n']) expect(win).not.toContain(banned);
    });

    it('the ambiguous case speaks; one session says nothing about picking', async () => {
        const two = fakeIo({
            tmux: (bin, args) => (args.includes('list-sessions')
                ? { status: 0, stdout: '5 5 0 alpha\n9 9 0 beta\n', stderr: '' }
                : { status: 0, stdout: '', stderr: '' }),
        });
        await runEnter(['--no-attach', '--', 'true'], two);
        expect(two.errs.join('\n')).toContain('2 tmux sessions');
        expect(two.errs.join('\n')).toContain("opening in 'beta' (most recently attached)");

        const one = fakeIo({
            tmux: (bin, args) => (args.includes('list-sessions')
                ? { status: 0, stdout: '5 5 0 only\n', stderr: '' }
                : { status: 0, stdout: '', stderr: '' }),
        });
        await runEnter(['--no-attach', '--', 'true'], one);
        expect(one.errs.join('\n')).not.toContain('tmux sessions on socket');
    });

    it('--session that does not exist is refused against the list already in hand', async () => {
        const io = fakeIo({
            tmux: (bin, args) => (args.includes('list-sessions')
                ? { status: 0, stdout: '5 5 0 main\n', stderr: '' }
                : { status: 0, stdout: '', stderr: '' }),
        });
        const code = await runEnter(['--session', 'nope', '--', 'true'], io);
        expect(code).toBe(1);
        expect(io.errs[0]).toBe("drover: no tmux session named 'nope' on socket 'default'.");
    });
});

describe('nothing here moves a window the user already had', () => {
    it('the source spells no command that renumbers, renames, kills or moves', async () => {
        const src = await import('node:fs').then((fs) =>
            fs.readFileSync(new URL('./tmuxEnter.ts', import.meta.url), 'utf8'));
        const code = src.split('\n')
            .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
            .join('\n');
        for (const banned of ['kill-server', 'kill-session', 'move-window', 'swap-window',
            'renumber-windows', 'respawn-window', 'rename-window']) {
            expect(code).not.toContain(banned);
        }
    });
});

describe('against the shell it replaces', () => {
    it('--help is byte for byte the shell file\'s', () => {
        if (!existsSync(shellEnter)) return;
        // env -i: the shell answers --help above its own path resolution, so
        // this proves the node help is the same text and not a reworded twin.
        const shell = spawnSync('sh', [shellEnter, '--help'], { encoding: 'utf8' });
        expect(shell.status).toBe(0);
        expect(`${usage.trimEnd()}\n`).toBe(shell.stdout);
    });
});
