/**
 * The smoke test for `drover codex` in node (DROVE-315 wave 3a).
 *
 * cattle-drover/tests/codex.bats is the spec and it stays green until the shell
 * file leaves. This asserts the launcher half of it — the help that answers
 * before anything runs, the two refusals and their distinct exit codes, and the
 * pane hand-off — against an injected io, so no codex is run, no tmux server is
 * touched, and nothing reaches a Happy session.
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

const drover = '/Users/clayrisser/Projects/bitspur/cattle-drover';
const shellCodex = join(drover, 'libexec', 'drover-codex');

function fakeIo(over: Partial<CodexIo> = {}): CodexIo & { lines: string[]; errs: string[]; launched: string[][] } {
    const lines: string[] = [];
    const errs: string[] = [];
    const launched: string[][] = [];
    return {
        env: { PATH: '/nowhere', DROVER_DIR: '/d', FORK_DIR: '/f' } as Record<string, string | undefined>,
        cwd: '/work',
        home: '/home/x',
        out: (l: string) => { lines.push(l); },
        err: (l: string) => { errs.push(l); },
        hasBinary: () => true,
        exists: () => true,
        enter: async () => 0,
        launch: async (argv: string[]) => { launched.push(argv); return 0; },
        lines,
        errs,
        launched,
        ...over,
    } as CodexIo & { lines: string[]; errs: string[]; launched: string[][] };
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
            launch: async () => { throw new Error('help must not start a session'); },
        });
        expect(await run(['--help'], io)).toBe(0);
        expect(await run(['-h'], io)).toBe(0);
        expect(io.lines[0].split('\n')[0])
            .toBe('drover codex — an OpenAI Codex session, managed like a Claude Code one.');
    });

    it('a missing binary says which one, how to install it, and exits 127', async () => {
        const io = fakeIo({ hasBinary: () => false });
        expect(await run([], io)).toBe(127);
        expect(io.errs[0]).toBe("drover codex: 'codex' is not on PATH.");
        expect(io.errs.join('\n')).toContain('npm install -g @openai/codex');
        expect(io.errs.join('\n')).toContain('DROVER_CODEX_BIN=/path/to/codex');
        expect(io.launched).toEqual([]);
    });

    it('DROVER_CODEX_BIN is named in the refusal, so a wrong one fails under its own name', async () => {
        const io = fakeIo({ hasBinary: () => false });
        io.env.DROVER_CODEX_BIN = '/opt/weird/codex';
        expect(await run([], io)).toBe(127);
        expect(io.errs[0]).toBe("drover codex: '/opt/weird/codex' is not on PATH.");
    });

    it('a missing fork is a different refusal with a different code', async () => {
        const io = fakeIo({ exists: () => false });
        io.env.DROVER_ALLOW_NO_TMUX = '1';
        expect(await run([], io)).toBe(1);
        expect(io.errs[0]).toBe('drover codex: fork not found at /f');
    });

    it('with no pane it hands itself to the ONE window opener, flags intact', async () => {
        const io = fakeIo();
        io.env.DROVER_DRY_RUN = '1';
        expect(await run(['--config', 'a b'], io)).toBe(0);
        expect(io.lines[0])
            .toBe("/d/libexec/drover-tmux-enter --cwd /work -- /d/libexec/drover-codex '--config' 'a b'");
        // Never the runner: the pane comes first.
        expect(io.launched).toEqual([]);
    });

    it('inside a pane it reaches the runner IN THIS PROCESS, not a second node', async () => {
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/default,9,0';
        expect(await run(['--resume', 'thread-1'], io)).toBe(0);
        expect(io.launched).toEqual([['--resume', 'thread-1']]);
    });

    it('a -L drover-login pane is not a pane: the session gets its own window', async () => {
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/drover-login,9,0';
        io.env.DROVER_DRY_RUN = '1';
        expect(await run([], io)).toBe(0);
        expect(io.lines[0]).toContain('drover-tmux-enter');
        expect(io.launched).toEqual([]);
    });

    it('DROVER_ALLOW_NO_TMUX=1 is still headless on purpose', async () => {
        const io = fakeIo();
        io.env.DROVER_ALLOW_NO_TMUX = '1';
        expect(await run(['--model', 'gpt-5.6'], io)).toBe(0);
        expect(io.launched).toEqual([['--model', 'gpt-5.6']]);
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
});
