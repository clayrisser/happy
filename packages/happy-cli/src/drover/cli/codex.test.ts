/**
 * The smoke test for `drover codex` in node (DROVE-315 wave 3a, reshaped at
 * DROVE-377).
 *
 * cattle-drover/tests/codex.bats is the spec and it stays green until the shell
 * file leaves. This asserts the launcher half of it — the help that answers
 * before anything runs, the refusals and their distinct exit codes, the pane
 * hand-off, and THE CLAIM THIS FILE NOW EXISTS FOR: inside a pane the real
 * codex binary takes the pane and a sibling bridge is started with its pid,
 * and only --headless reaches the app-server runner. Against an injected io,
 * so no codex is run, no tmux server is touched, and nothing reaches a Happy
 * session.
 *
 * The differential case runs the SHELL file and compares stdout byte for byte,
 * on --help and on the dry-run line, which is what proves the port did not
 * quietly reword or reorder anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, usage, type CodexIo } from './codex';

// DROVER_DIR, so the differential runs against the checkout this lane pairs
// with (the DROVE-377 launcher lives on a lane until it merges), and falls back
// to the main checkout the way every other test here does.
const drover = process.env.DROVER_DIR || '/Users/clayrisser/Projects/bitspur/cattle-drover';
const shellCodex = join(drover, 'libexec', 'drover-codex');

interface Recorded { lines: string[]; errs: string[]; launched: string[][]; bridges: string[][]; tui: string[][] }

function fakeIo(over: Partial<CodexIo> = {}): CodexIo & Recorded {
    const lines: string[] = [];
    const errs: string[] = [];
    const launched: string[][] = [];
    const bridges: string[][] = [];
    const tui: string[][] = [];
    return {
        env: { PATH: '/nowhere', DROVER_DIR: '/d', FORK_DIR: '/f', STATE_DIR: '/s' } as Record<string, string | undefined>,
        cwd: '/work',
        home: '/home/x',
        out: (l: string) => { lines.push(l); },
        err: (l: string) => { errs.push(l); },
        hasBinary: () => true,
        exists: () => true,
        enter: async () => 0,
        startBridge: (script: string, argv: string[]) => { bridges.push([script, ...argv]); },
        // The pid a real spawn would report, so the bridge argv can be asserted.
        execTui: async (bin: string, argv: string[], _env: unknown, started?: (pid: number) => void) => {
            tui.push([bin, ...argv]);
            started?.(4242);
            return 0;
        },
        launch: async (argv: string[]) => { launched.push(argv); return 0; },
        lines,
        errs,
        launched,
        bridges,
        tui,
        ...over,
    } as CodexIo & Recorded;
}

describe('drover codex', () => {
    it('--help answers first, and touches nothing at all', async () => {
        // Every seam throws: a help that reached for a binary, a directory, a
        // pane or a runner fails this test rather than passing quietly. Four
        // uncommented header lines in libexec/drover-account once made a
        // launcher run a real login on load, and `sh -n` cannot catch that.
        const io = fakeIo({
            hasBinary: () => { throw new Error('help must not probe PATH'); },
            exists: () => { throw new Error('help must not stat the fork'); },
            enter: async () => { throw new Error('help must not open a pane'); },
            startBridge: () => { throw new Error('help must not start a bridge'); },
            execTui: async () => { throw new Error('help must not run codex'); },
            launch: async () => { throw new Error('help must not start a session'); },
        });
        expect(await run(['--help'], io)).toBe(0);
        expect(await run(['-h'], io)).toBe(0);
        expect(io.lines[0].split('\n')[0])
            .toBe('drover codex — an OpenAI Codex session, managed like a Claude Code one.');
        // The flag is DISCOVERABLE: the headless path stays reachable only if
        // the help says how.
        expect(io.lines[0]).toContain('--headless');
        expect(io.lines[0]).toContain('DROVER_CODEX_HEADLESS=1');
    });

    it('a missing binary says which one, how to install it, and exits 127', async () => {
        const io = fakeIo({ hasBinary: () => false });
        expect(await run([], io)).toBe(127);
        expect(io.errs[0]).toBe("drover codex: 'codex' is not on PATH.");
        expect(io.errs.join('\n')).toContain('npm install -g @openai/codex');
        expect(io.errs.join('\n')).toContain('DROVER_CODEX_BIN=/path/to/codex');
        expect(io.launched).toEqual([]);
        expect(io.tui).toEqual([]);
    });

    it('DROVER_CODEX_BIN is named in the refusal, so a wrong one fails under its own name', async () => {
        const io = fakeIo({ hasBinary: () => false });
        io.env.DROVER_CODEX_BIN = '/opt/weird/codex';
        expect(await run([], io)).toBe(127);
        expect(io.errs[0]).toBe("drover codex: '/opt/weird/codex' is not on PATH.");
    });

    it('with no pane it hands itself to the ONE window opener, flags intact', async () => {
        const io = fakeIo();
        io.env.DROVER_DRY_RUN = '1';
        expect(await run(['--config', 'a b'], io)).toBe(0);
        expect(io.lines[0])
            .toBe("/d/libexec/drover-tmux-enter --cwd /work -- /d/libexec/drover-codex '--config' 'a b'");
        // Never the runner and never the TUI: the pane comes first.
        expect(io.launched).toEqual([]);
        expect(io.tui).toEqual([]);
    });

    it('with no pane, --headless rides along to the window rather than being lost', async () => {
        // The shell quotes "$@" before its own loop eats the flag, for exactly
        // this: the window must run the command that was typed.
        const io = fakeIo();
        io.env.DROVER_DRY_RUN = '1';
        expect(await run(['--headless', '--model', 'gpt-5.6'], io)).toBe(0);
        expect(io.lines[0])
            .toBe("/d/libexec/drover-tmux-enter --cwd /work -- /d/libexec/drover-codex '--headless' '--model' 'gpt-5.6'");
    });

    it('inside a pane the REAL codex takes the pane and the bridge starts beside it with its pid', async () => {
        // THE CLAIM THIS FILE EXISTS FOR, inverted at DROVE-377. It used to
        // assert that the pane reached the app-server runner in this process,
        // and that runner is HEADLESS: the pane showed one banner line and the
        // phone was the only way in. Now the pane runs codex itself.
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/default,9,0';
        io.env.TMUX_PANE = '%7';
        expect(await run(['--resume', 'thread-1'], io)).toBe(0);

        // The pane is codex and nothing else, with its own flags untouched.
        expect(io.tui).toEqual([['codex', '--resume', 'thread-1']]);
        // Never the headless runner.
        expect(io.launched).toEqual([]);

        // The sibling bridge, told the pane, the bus, the binary — and the
        // TUI's pid, which is what lets it reap a codex that outlives its pane.
        expect(io.bridges).toHaveLength(1);
        expect(io.bridges[0][0]).toBe('/d/adapters/codex-bridge.mjs');
        expect(io.bridges[0]).toContain('%7');
        expect(io.bridges[0]).toContain('--codex-bin');
        const at = io.bridges[0].indexOf('--tui-pid');
        expect(at).toBeGreaterThan(0);
        expect(io.bridges[0][at + 1]).toBe('4242');
    });

    it('DROVER_CODEX_BIN is the binary the pane runs, and the one the bridge is told', async () => {
        // The differential against a stub: naming a different binary must move
        // both, or the bridge would queue into a codex the pane is not running.
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/default,9,0';
        io.env.DROVER_CODEX_BIN = '/opt/weird/codex';
        expect(await run(['--model', 'gpt-5.6'], io)).toBe(0);
        expect(io.tui).toEqual([['/opt/weird/codex', '--model', 'gpt-5.6']]);
        const at = io.bridges[0].indexOf('--codex-bin');
        expect(io.bridges[0][at + 1]).toBe('/opt/weird/codex');
    });

    it('the TUI path does not need the fork tree at all', async () => {
        // It did, and that was a real coupling: a pane running the user's own
        // codex has no reason to care whether a node CLI is checked out.
        const io = fakeIo({ exists: () => { throw new Error('the TUI path must not stat the fork'); } });
        io.env.TMUX = '/tmp/tmux-501/default,9,0';
        expect(await run([], io)).toBe(0);
        expect(io.tui).toEqual([['codex']]);
    });

    it('--headless reaches the runner IN THIS PROCESS, never the TUI, and is eaten', async () => {
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/default,9,0';
        expect(await run(['--headless', '--resume', 'thread-1'], io)).toBe(0);
        // Eaten: a --headless that reached codex would make it exit 2 on an
        // unknown flag, which is a very confusing way to discover a launcher bug.
        expect(io.launched).toEqual([['--resume', 'thread-1']]);
        expect(io.tui).toEqual([]);
        expect(io.bridges).toEqual([]);
    });

    it('DROVER_CODEX_HEADLESS=1 is the same door as --headless', async () => {
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/default,9,0';
        io.env.DROVER_CODEX_HEADLESS = '1';
        expect(await run(['--model', 'gpt-5.6'], io)).toBe(0);
        expect(io.launched).toEqual([['--model', 'gpt-5.6']]);
        expect(io.tui).toEqual([]);
    });

    it('--headless still says so when the fork is missing, with its own code', async () => {
        const io = fakeIo({ exists: () => false });
        io.env.DROVER_ALLOW_NO_TMUX = '1';
        expect(await run(['--headless'], io)).toBe(1);
        expect(io.errs[0]).toBe('drover codex: fork not found at /f');
        expect(io.launched).toEqual([]);
    });

    it('a -L drover-login pane is not a pane: the session gets its own window', async () => {
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/drover-login,9,0';
        io.env.DROVER_DRY_RUN = '1';
        expect(await run([], io)).toBe(0);
        expect(io.lines[0]).toContain('drover-tmux-enter');
        expect(io.launched).toEqual([]);
        expect(io.tui).toEqual([]);
    });

    it('DROVER_ALLOW_NO_TMUX=1 opens no window; the TUI still runs here, and the bridge knows there is no pane', async () => {
        const io = fakeIo();
        io.env.DROVER_ALLOW_NO_TMUX = '1';
        expect(await run(['--model', 'gpt-5.6'], io)).toBe(0);
        expect(io.tui).toEqual([['codex', '--model', 'gpt-5.6']]);
        expect(io.launched).toEqual([]);
        // An EMPTY pane, on purpose: the bridge then refuses to type rather
        // than guessing at a pane on some server.
        const at = io.bridges[0].indexOf('--pane');
        expect(io.bridges[0][at + 1]).toBe('');
    });

    it('the dry-run line is the codex binary and its flags, never a runner', async () => {
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/default,9,0';
        io.env.DROVER_DRY_RUN = '1';
        expect(await run(['--model', 'gpt-5.6-sol', '--effort', 'high'], io)).toBe(0);
        expect(io.lines[0]).toBe('codex --model gpt-5.6-sol --effort high');
        // The three shapes that would mean the pane is a spectator again.
        expect(io.lines[0]).not.toContain('drover.mjs');
        expect(io.lines[0]).not.toContain('app-server');
        expect(io.lines[0]).not.toContain('node ');
    });
});

describe('against the shell it replaces', () => {
    it('--help is byte for byte the shell file\'s', () => {
        if (!existsSync(shellCodex)) return;
        const shell = spawnSync('sh', [shellCodex, '--help'], { encoding: 'utf8' });
        expect(shell.status).toBe(0);
        expect(`${usage.trimEnd()}\n`).toBe(shell.stdout);
    });

    it('the pane hand-off line is byte for byte the shell\'s', () => {
        if (!existsSync(shellCodex)) return;
        // A codex that exists but is never run, and a fork tree with the one
        // path the shell checks for — the same fixture codex.bats builds.
        // realpath: macOS resolves /tmp to /private/tmp behind your back, and the
        // shell's $PWD is the resolved one. Two spellings of the same directory
        // would fail this comparison for a reason that is not the port's.
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'drover-codex-')));
        const shims = join(tmp, 'bin');
        mkdirSync(shims, { recursive: true });
        writeFileSync(join(shims, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        mkdirSync(join(tmp, 'fork', 'packages', 'happy-cli', 'bin'), { recursive: true });
        writeFileSync(join(tmp, 'fork', 'packages', 'happy-cli', 'bin', 'drover.mjs'), '');

        const env = {
            ...process.env,
            PATH: `${shims}:${process.env.PATH}`,
            FORK_DIR: join(tmp, 'fork'),
            DROVER_DRY_RUN: '1',
            TMUX: '',
        };
        delete (env as Record<string, string | undefined>).TMUX;
        const shell = spawnSync('sh', [shellCodex, '--config', 'a b'], { encoding: 'utf8', env, cwd: tmp });
        expect(shell.status).toBe(0);

        const io = fakeIo();
        io.env = {
            PATH: env.PATH,
            DROVER_DIR: drover,
            FORK_DIR: join(tmp, 'fork'),
            DROVER_DRY_RUN: '1',
        };
        io.cwd = tmp;
        return run(['--config', 'a b'], io).then((code) => {
            expect(code).toBe(0);
            expect(`${io.lines[0]}\n`).toBe(shell.stdout);
        });
    });

    it('the in-pane dry-run line is byte for byte the shell\'s, TUI and --headless both', async () => {
        if (!existsSync(shellCodex)) return;
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'drover-codex-')));
        const shims = join(tmp, 'bin');
        mkdirSync(shims, { recursive: true });
        writeFileSync(join(shims, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        mkdirSync(join(tmp, 'fork', 'packages', 'happy-cli', 'bin'), { recursive: true });
        writeFileSync(join(tmp, 'fork', 'packages', 'happy-cli', 'bin', 'drover.mjs'), '');

        for (const argv of [['--model', 'gpt-5.6-sol', '--effort', 'high'], ['--headless', '--model', 'gpt-5.6-sol']]) {
            const env = {
                ...process.env,
                PATH: `${shims}:${process.env.PATH}`,
                FORK_DIR: join(tmp, 'fork'),
                DROVER_ALLOW_NO_TMUX: '1',
                DROVER_DRY_RUN: '1',
            };
            delete (env as Record<string, string | undefined>).TMUX;
            const shell = spawnSync('sh', [shellCodex, ...argv], { encoding: 'utf8', env, cwd: tmp });
            expect(shell.status).toBe(0);

            const io = fakeIo();
            io.env = {
                PATH: env.PATH,
                DROVER_DIR: drover,
                FORK_DIR: join(tmp, 'fork'),
                DROVER_ALLOW_NO_TMUX: '1',
                DROVER_DRY_RUN: '1',
            };
            io.cwd = tmp;
            expect(await run(argv, io)).toBe(0);
            expect(`${io.lines[0]}\n`).toBe(shell.stdout);
        }
    });
});
