/**
 * The vitest smoke suite for the ported `drover pi` (DROVE-315).
 *
 * cattle-drover/tests/pi.bats is the spec and it stays green until the shell
 * file leaves; this pins the assertions that make the port a port — the exact
 * refusals and their exit codes, the pane gate handing back the ORIGINAL argv,
 * the two dry-run lines byte for byte, and the fact that the normal path ends
 * in ONE implementation rather than a second `node bin/drover.mjs pi`.
 *
 * On top of that, one differential test runs the SHELL file's --help and
 * compares it with the node verb's stdout byte for byte.
 *
 * Nothing here touches ~/.happy, ~/.pi, a real tmux server or the live bus:
 * every branch runs against an injected PiIo whose home is a mkdtemp, whose
 * launch/enter ports record rather than run, and whose `which` answers from a
 * table.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseRunnerArgs, run, type Env, type PiIo } from './pi';

const SHELL = '/Users/clayrisser/Projects/bitspur/cattle-drover/libexec/drover-pi';

interface Recorder {
    io: PiIo;
    out: string[];
    err: string[];
    launched: { argv: string[]; env: Env }[];
    bridged: { argv: string[]; env: Env }[];
    entered: { argv: string[]; cwd: string }[];
}

/** A PiIo that records instead of running. `home` is a throwaway directory. */
function recorder(env: Env = {}, over: Partial<PiIo> = {}): Recorder {
    const home = mkdtempSync(join(tmpdir(), 'drover-pi-'));
    const out: string[] = [];
    const err: string[] = [];
    const launched: { argv: string[]; env: Env }[] = [];
    const bridged: { argv: string[]; env: Env }[] = [];
    const entered: { argv: string[]; cwd: string }[] = [];
    const io: PiIo = {
        env: { PATH: '', ...env },
        home,
        cwd: '/tmp/proj',
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        which: (n) => (n === 'pi' || n === 'node' ? `/usr/bin/${n}` : null),
        isExecutable: () => false,
        isReadable: () => true,
        isDirectory: () => true,
        mkdirp: () => {},
        pickSession: async () => ({ code: 0, id: 'picked-session-id' }),
        resolveModel: async (want) => ({ code: 0, ref: `lmstudio/${want}` }),
        enter: async (argv, cwd) => {
            entered.push({ argv: [...argv], cwd });
            return 0;
        },
        launch: async (argv, childEnv) => {
            launched.push({ argv, env: childEnv });
            return 0;
        },
        launchBridge: async (argv, childEnv) => {
            bridged.push({ argv, env: childEnv });
            return 0;
        },
        ...over,
    };
    return { io, out, err, launched, bridged, entered };
}

/** A FORK_DIR whose packages/happy-cli exists, so the runner path is reachable. */
function forkDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'drover-fork-'));
    mkdirSync(join(dir, 'packages', 'happy-cli'), { recursive: true });
    return dir;
}

describe('drover pi', () => {
    it('answers --help byte for byte with the shell file, and touches nothing', async () => {
        const chunks: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
            chunks.push(String(c));
            return true;
        });
        // The io THROWS on every port: --help is answered above the path
        // resolution on purpose, so reaching one of these is the bug.
        const boom = (): never => {
            throw new Error('--help must not touch anything');
        };
        const code = await run(['--help'], {
            io: { ...recorder().io, which: boom, isDirectory: boom, launch: boom, enter: boom },
        });
        spy.mockRestore();
        expect(code).toBe(0);
        const shell = spawnSync('sh', [SHELL, '--help'], { encoding: 'utf8' });
        expect(shell.status).toBe(0);
        expect(chunks.join('')).toBe(shell.stdout);
    });

    it('keeps every refusal, sentence and exit code', async () => {
        for (const argv of [['--no-extensions'], ['-ne']]) {
            const r = recorder();
            expect(await run(argv, { io: r.io })).toBe(2);
            expect(r.err.join('\n')).toContain('LOCAL MODELS');
        }

        const mode = recorder();
        expect(await run(['--mode', 'json'], { io: mode.io })).toBe(2);
        expect(mode.err.join('\n')).toContain("--mode is drover's");

        const think = recorder();
        expect(await run(['--thinking', 'colossal'], { io: think.io })).toBe(2);
        expect(think.err.join('\n')).toContain('colossal');
        expect(think.err.join('\n')).toContain('off minimal low medium high xhigh');

        const seed = recorder({}, { isReadable: () => false });
        expect(await run(['--seed', '/nope'], { io: seed.io })).toBe(2);
        expect(seed.err.join('\n')).toBe("drover pi: cannot read the seed file '/nope'");

        const model = recorder();
        expect(await run(['--model'], { io: model.io })).toBe(2);
        expect(model.err.join('\n')).toBe('drover pi: --model needs a model');
    });

    it('names the missing binary, tries the launchd fallback, and exits 127', async () => {
        // A DROVER_PI_BIN set by hand and got wrong must fail under THAT name —
        // the fallback is for the default name only.
        const r = recorder({ DROVER_PI_BIN: 'definitely-not-pi' }, { which: () => null, isExecutable: () => true });
        expect(await run([], { io: r.io })).toBe(127);
        const said = r.err.join('\n');
        expect(said).toContain('definitely-not-pi');
        expect(said).toContain('pi-coding-agent');
        expect(said).toContain('DROVER_PI_BIN=/path/to/pi');

        // The default name DOES take the fallback, and gets past the check.
        const ok = recorder(
            { DROVER_ALLOW_NO_TMUX: '1', DROVER_DRY_RUN: '1', FORK_DIR: forkDir() },
            { which: (n) => (n === 'node' ? '/usr/bin/node' : null), isExecutable: (p) => p === '/opt/homebrew/bin/pi' },
        );
        expect(await run([], { io: ok.io })).toBe(0);
        expect(ok.out.join('\n')).toContain('drover.mjs pi');
    });

    it('hands the ORIGINAL argv back to the window opener, not what is left', async () => {
        // pi's own flags are eaten by the parse loop before the pane check, so
        // re-entering with `$@` would open a window running a plain `drover pi`.
        const dry = recorder({ DROVER_DRY_RUN: '1', TMUX: '' });
        expect(await run(['--thinking', 'high'], { io: dry.io, libexec: '/L' })).toBe(0);
        expect(dry.out.join('\n')).toBe("/L/drover-tmux-enter --cwd /tmp/proj -- /L/drover-pi '--thinking' 'high'");

        const live = recorder({ TMUX: '' });
        expect(await run(['--thinking', 'high'], { io: live.io, libexec: '/L' })).toBe(0);
        expect(live.entered).toEqual([{ argv: ['--thinking', 'high'], cwd: '/tmp/proj' }]);

        // DROVER_ALLOW_NO_TMUX=1 opens nothing at all.
        const allow = recorder({ DROVER_ALLOW_NO_TMUX: '1', DROVER_DRY_RUN: '1', TMUX: '', FORK_DIR: forkDir() });
        expect(await run([], { io: allow.io })).toBe(0);
        expect(allow.out.join('\n')).not.toContain('drover-tmux-enter');
        expect(allow.entered).toEqual([]);
    });

    it('prints the happy-cli runner line, in order, and never the bridge', async () => {
        const fork = forkDir();
        const r = recorder({ DROVER_ALLOW_NO_TMUX: '1', DROVER_DRY_RUN: '1', FORK_DIR: fork });
        expect(await run(['--thinking', 'medium', '--resume', 'abc-123', '--started-by', 'daemon'], { io: r.io })).toBe(0);
        expect(r.out.join('\n')).toBe(
            `node ${join(fork, 'packages', 'happy-cli', 'bin', 'drover.mjs')} pi --resume abc-123 --thinking medium --started-by daemon`,
        );
        expect(r.out.join('\n')).not.toContain('pi-bridge.mjs');
    });

    it('DROVER_PI_BRIDGE=1 keeps its own line and its own argument order', async () => {
        const r = recorder({
            DROVER_ALLOW_NO_TMUX: '1',
            DROVER_DRY_RUN: '1',
            DROVER_PI_BRIDGE: '1',
            DROVER_DIR: '/D',
        });
        expect(await run(['--thinking', 'medium', '--resume', 'abc-123'], { io: r.io })).toBe(0);
        // `--session`, because these go straight to pi, whose flag it is.
        expect(r.out.join('\n')).toBe('node /D/adapters/pi-bridge.mjs --pi-bin pi -- --session abc-123 --thinking medium');
    });

    it('says so when the fork is missing, and names the fallback', async () => {
        const r = recorder({ DROVER_ALLOW_NO_TMUX: '1', FORK_DIR: '/nowhere' }, { isDirectory: () => false });
        expect(await run([], { io: r.io })).toBe(1);
        const said = r.err.join('\n');
        expect(said).toContain('fork not found at /nowhere');
        expect(said).toContain('DROVER_PI_BRIDGE=1');
    });

    it('ends in ONE implementation: the runner port, with the rewritten argv', async () => {
        const fork = forkDir();
        const r = recorder({ DROVER_ALLOW_NO_TMUX: '1', FORK_DIR: fork, DROVER_PI_BIN: 'pi' });
        expect(await run(['--model', 'gpt-oss-120b', '--no-gate', '--', '-p', 'hi'], { io: r.io })).toBe(0);
        expect(r.launched).toHaveLength(1);
        // The model is a LOOKUP, resolved to a full provider/id before handoff.
        expect(r.launched[0].argv).toEqual(['--model', 'lmstudio/gpt-oss-120b', '--no-gate', '--', '-p', 'hi']);
        // HAPPY_PI_PATH, not DROVER_PI_BIN: both halves run the same pi.
        expect(r.launched[0].env.HAPPY_PI_PATH).toBe('pi');
        expect(r.launched[0].env.DROVER_ORIGIN).toBe('terminal');
        // A bare --resume picks first, and the pick becomes --resume <id>.
        const bare = recorder({ DROVER_ALLOW_NO_TMUX: '1', FORK_DIR: fork });
        expect(await run(['--resume'], { io: bare.io })).toBe(0);
        expect(bare.launched[0].argv).toEqual(['--resume', 'picked-session-id']);
        // And the runner reads that argv back the way src/index.ts does.
        expect(parseRunnerArgs(bare.launched[0].argv).resumeSessionId).toBe('picked-session-id');
    });
});
