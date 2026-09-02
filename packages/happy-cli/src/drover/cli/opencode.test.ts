/**
 * The smoke test for `drover opencode` in node (DROVE-315 wave 3a).
 *
 * cattle-drover/tests/opencode.bats is the spec and it stays green until the
 * shell file leaves. This asserts the launcher half — the help, the --seed
 * contract, the --port refusal that keeps the phone able to reach the pane, the
 * two missing-binary codes, and the pane hand-off — against an injected io. No
 * opencode is started, no bridge is spawned, no tmux server is touched.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, usage, type OpencodeIo } from './opencode';

const drover = '/Users/clayrisser/Projects/bitspur/cattle-drover';
const shellOpencode = join(drover, 'libexec', 'drover-opencode');

interface Recorded { lines: string[]; errs: string[]; bridges: string[][]; tui: string[][] }

function fakeIo(over: Partial<OpencodeIo> = {}): OpencodeIo & Recorded {
    const lines: string[] = [];
    const errs: string[] = [];
    const bridges: string[][] = [];
    const tui: string[][] = [];
    return {
        env: { PATH: '/nowhere', DROVER_DIR: '/d', STATE_DIR: '/s' } as Record<string, string | undefined>,
        cwd: '/work',
        home: '/home/x',
        out: (l: string) => { lines.push(l); },
        err: (l: string) => { errs.push(l); },
        hasBinary: () => true,
        readable: () => true,
        freePort: async () => 40404,
        startBridge: (script: string, argv: string[]) => { bridges.push([script, ...argv]); },
        execTui: (bin: string, argv: string[]) => { tui.push([bin, ...argv]); return 0; },
        enter: async () => 0,
        lines,
        errs,
        bridges,
        tui,
        ...over,
    } as OpencodeIo & Recorded;
}

describe('drover opencode', () => {
    it('--help answers and starts nothing', async () => {
        const io = fakeIo({
            hasBinary: () => { throw new Error('help must not probe PATH'); },
            freePort: async () => { throw new Error('help must not open a socket'); },
        });
        expect(await run(['--help'], io)).toBe(0);
        expect(io.lines[0].split('\n')[0])
            .toBe('drover opencode — an OpenCode session drover can see and the phone can drive.');
        expect(io.tui).toEqual([]);
    });

    it('--seed needs a file, and a file it can read', async () => {
        const missing = fakeIo();
        expect(await run(['--seed'], missing)).toBe(2);
        expect(missing.errs[0]).toBe('drover opencode: --seed needs a file');

        const unreadable = fakeIo({ readable: () => false });
        expect(await run(['--seed', '/nope.md'], unreadable)).toBe(2);
        expect(unreadable.errs[0]).toBe("drover opencode: cannot read the seed file '/nope.md'");
    });

    it('--port is drover\'s to choose, in both spellings', async () => {
        for (const spelling of [['--port', '3000'], ['--port=3000']]) {
            const io = fakeIo();
            io.env.DROVER_ALLOW_NO_TMUX = '1';
            expect(await run(spelling, io)).toBe(2);
            expect(io.errs[0]).toContain("--port is drover's to choose");
            expect(io.errs[1]).toContain('DROVER_OPENCODE_PORT=<n>');
        }
    });

    it('a missing opencode and a missing port are different failures', async () => {
        const noBin = fakeIo({ hasBinary: () => false });
        expect(await run([], noBin)).toBe(127);
        expect(noBin.errs[0]).toBe("drover opencode: 'opencode' is not on PATH.");

        const noPort = fakeIo({ freePort: async () => null });
        noPort.env.DROVER_ALLOW_NO_TMUX = '1';
        expect(await run([], noPort)).toBe(1);
        expect(noPort.errs[0]).toBe('drover opencode: could not find a free port to run the OpenCode API on.');
    });

    it('DROVER_OPENCODE_PORT that is not a number is refused', async () => {
        const io = fakeIo();
        io.env.DROVER_ALLOW_NO_TMUX = '1';
        io.env.DROVER_OPENCODE_PORT = 'eight';
        expect(await run([], io)).toBe(2);
        expect(io.errs[0]).toBe("drover opencode: 'eight' is not a port number.");
    });

    it('with no pane it re-enters with the flags it was actually given', async () => {
        const io = fakeIo();
        io.env.DROVER_DRY_RUN = '1';
        expect(await run(['--seed', '/tmp/s.md', '--agent', 'build'], io)).toBe(0);
        // The ORIGINAL argv, not what is left after the option loop ate --seed.
        expect(io.lines[0]).toBe(
            "/d/libexec/drover-tmux-enter --cwd /work -- /d/libexec/drover-opencode '--seed' '/tmp/s.md' '--agent' 'build'",
        );
    });

    it('in a pane the bridge starts as a SIBLING and the TUI takes the pane', async () => {
        const io = fakeIo();
        io.env.TMUX = '/tmp/tmux-501/default,9,0';
        io.env.TMUX_PANE = '%7';
        io.env.DROVER_OPENCODE_PORT = '4321';
        expect(await run(['--seed', '/tmp/s.md', '--agent', 'build'], io)).toBe(0);

        expect(io.bridges).toHaveLength(1);
        expect(io.bridges[0][0]).toBe('/d/adapters/opencode-bridge.mjs');
        expect(io.bridges[0]).toContain('http://127.0.0.1:4321');
        expect(io.bridges[0]).toContain('%7');
        expect(io.bridges[0].slice(-2)).toEqual(['--seed', '/tmp/s.md']);

        // The pane is the TUI and nothing else, and drover's port went with it.
        expect(io.tui).toEqual([['opencode', '--port', '4321', '--agent', 'build']]);
    });
});

describe('against the shell it replaces', () => {
    it('--help is byte for byte the shell file\'s', () => {
        if (!existsSync(shellOpencode)) return;
        const shell = spawnSync('sh', [shellOpencode, '--help'], { encoding: 'utf8' });
        expect(shell.status).toBe(0);
        expect(`${usage.trimEnd()}\n`).toBe(shell.stdout);
    });

    it('the dry-run command line is byte for byte the shell\'s', async () => {
        if (!existsSync(shellOpencode)) return;
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'drover-opencode-')));
        const shims = join(tmp, 'bin');
        mkdirSync(shims, { recursive: true });
        writeFileSync(join(shims, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const env = {
            ...process.env,
            PATH: `${shims}:${process.env.PATH}`,
            DROVER_ALLOW_NO_TMUX: '1',
            DROVER_DRY_RUN: '1',
            DROVER_OPENCODE_PORT: '4321',
        };
        delete (env as Record<string, string | undefined>).TMUX;
        const shell = spawnSync('sh', [shellOpencode, '--agent', 'build'], { encoding: 'utf8', env, cwd: tmp });
        expect(shell.status).toBe(0);

        const io = fakeIo();
        io.env = {
            PATH: env.PATH,
            DROVER_DIR: drover,
            DROVER_ALLOW_NO_TMUX: '1',
            DROVER_DRY_RUN: '1',
            DROVER_OPENCODE_PORT: '4321',
        };
        io.cwd = tmp;
        expect(await run(['--agent', 'build'], io)).toBe(0);
        expect(`${io.lines[0]}\n`).toBe(shell.stdout);
    });
});
