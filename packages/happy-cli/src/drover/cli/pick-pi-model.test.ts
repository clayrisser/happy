/**
 * The vitest smoke suite for the ported `drover-pick-pi-model` (DROVE-315).
 *
 * The assertion surface is cattle-drover/tests/pi.bats' two picker tests plus
 * the contract every drover picker keeps: the picked id on stdout and NOTHING
 * else, the list on stderr, 1 when nothing was picked, 2 on an unknown option
 * or an ambiguous --resolve, 127 when the binary is missing.
 *
 * One differential test runs the SHELL file's --help and compares it with the
 * node verb's stdout byte for byte.
 *
 * No pi is run and no ~/.pi is read: `listModels` answers from a fixture table
 * and `home` is a mkdtemp.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { run, type Env, type ModelIo } from './pick-pi-model';

const SHELL = '/Users/clayrisser/Projects/bitspur/cattle-drover/libexec/drover-pick-pi-model';

/** The real table's shape, header row and all. */
const TABLE = `provider     model                    context  max-out  thinking  images
lmstudio     openai/gpt-oss-120b      131.1K   8.2K     no        no
lmstudio     qwen/qwen3-coder-next    131.1K   8.2K     no        no
google       gemini-3-pro-preview     1.0M     65.5K    yes       yes
`;

function recorder(env: Env = {}, over: Partial<ModelIo> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io: ModelIo = {
        env: { PATH: '', ...env },
        home: mkdtempSync(join(tmpdir(), 'drover-pim-')),
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        which: (n) => (n === 'pi' || n === 'jq' ? `/usr/bin/${n}` : null),
        isExecutable: () => false,
        readFile: () => null,
        listModels: () => TABLE,
        isTty: () => false,
        gumChoose: () => null,
        readLine: () => null,
        ...over,
    };
    return { io, out, err };
}

describe('drover-pick-pi-model', () => {
    it('answers --help byte for byte with the shell file, and touches nothing', async () => {
        const chunks: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
            chunks.push(String(c));
            return true;
        });
        const boom = (): never => {
            throw new Error('--help must not touch anything');
        };
        const code = await run(['--help'], { io: { ...recorder().io, which: boom, listModels: boom } });
        spy.mockRestore();
        expect(code).toBe(0);
        const shell = spawnSync('sh', [SHELL, '--help'], { encoding: 'utf8' });
        expect(shell.status).toBe(0);
        expect(chunks.join('')).toBe(shell.stdout);
    });

    it('resolves only what pi actually reports', async () => {
        // Exact first, so a full provider/id never loses to a substring.
        const exact = recorder();
        expect(await run(['--resolve', 'lmstudio/openai/gpt-oss-120b'], { io: exact.io })).toBe(0);
        expect(exact.out).toEqual(['lmstudio/openai/gpt-oss-120b']);
        expect(exact.err).toEqual([]);

        // A unique substring resolves to the full provider/id.
        const sub = recorder();
        expect(await run(['--resolve', 'qwen3-coder'], { io: sub.io })).toBe(0);
        expect(sub.out).toEqual(['lmstudio/qwen/qwen3-coder-next']);
    });

    it('refuses free text and ambiguity, and names the alternatives', async () => {
        const miss = recorder();
        expect(await run(['--resolve', 'claude-opus-5'], { io: miss.io })).toBe(2);
        expect(miss.out).toEqual([]);
        expect(miss.err.join('\n')).toContain('does not report a model matching');
        expect(miss.err.join('\n')).toContain('    lmstudio/openai/gpt-oss-120b');

        const many = recorder();
        expect(await run(['--resolve', 'lmstudio'], { io: many.io })).toBe(2);
        expect(many.err.join('\n')).toContain('matches 2 models');

        const empty = recorder();
        expect(await run(['--resolve'], { io: empty.io })).toBe(2);
        expect(empty.err).toEqual(['drover-pick-pi-model: --resolve needs a model']);
    });

    it('tells local providers apart from the rest', async () => {
        const local = recorder();
        expect(await run(['--local'], { io: local.io })).toBe(0);
        expect(local.out).toEqual(['lmstudio/openai/gpt-oss-120b', 'lmstudio/qwen/qwen3-coder-next']);

        const list = recorder();
        expect(await run(['--list'], { io: list.io })).toBe(0);
        expect(list.out).toContain('google/gemini-3-pro-preview');

        // DROVER_PI_LOCAL decides which providers count.
        const custom = recorder({ DROVER_PI_LOCAL: 'google' });
        expect(await run(['--local'], { io: custom.io })).toBe(0);
        expect(custom.out).toEqual(['google/gemini-3-pro-preview']);
    });

    it('is 127 when the binary is missing and 1 when pi lists nothing', async () => {
        const gone = recorder({ DROVER_PI_BIN: 'definitely-not-pi' }, { which: () => null });
        expect(await run(['--list'], { io: gone.io })).toBe(127);
        expect(gone.err).toEqual(["drover-pick-pi-model: 'definitely-not-pi' is not on PATH."]);

        const silent = recorder({}, { listModels: () => '' });
        expect(await run(['--list'], { io: silent.io })).toBe(1);
        expect(silent.err).toEqual(['drover-pick-pi-model: pi listed no models. Is it configured?']);
    });

    it('refuses an unknown option with 2', async () => {
        const r = recorder();
        expect(await run(['--nope'], { io: r.io })).toBe(2);
        expect(r.err).toEqual(["drover-pick-pi-model: unknown option '--nope'"]);
    });

    it('numbers the rows on stderr, local first, and prints only the pick', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const r = recorder({}, { readLine: () => '3' });
        expect(await run([], { io: r.io })).toBe(0);
        stderr.mockRestore();
        expect(r.err).toEqual([
            '  1) lmstudio/openai/gpt-oss-120b (local)',
            '  2) lmstudio/qwen/qwen3-coder-next (local)',
            '  3) google/gemini-3-pro-preview',
        ]);
        expect(r.out).toEqual(['google/gemini-3-pro-preview']);
    });

    it('exits 1 when nothing was picked', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const r = recorder({}, { readLine: () => '' });
        expect(await run([], { io: r.io })).toBe(1);
        stderr.mockRestore();
        expect(r.out).toEqual([]);
        expect(r.err.at(-1)).toBe('drover: no pi model picked');
    });

    it('--default reads pi own settings, and needs jq for its 127', async () => {
        const ok = recorder({ PI_AGENT_DIR: '/pi' }, {
            readFile: () => '{"defaultProvider":"lmstudio","defaultModel":"openai/gpt-oss-120b"}',
        });
        expect(await run(['--default'], { io: ok.io })).toBe(0);
        expect(ok.out).toEqual(['lmstudio/openai/gpt-oss-120b']);

        const nojq = recorder({ PI_AGENT_DIR: '/pi' }, {
            readFile: () => '{}',
            which: (n) => (n === 'pi' ? '/usr/bin/pi' : null),
        });
        expect(await run(['--default'], { io: nojq.io })).toBe(127);
        expect(nojq.err).toEqual(['drover-pick-pi-model: jq is required for --default']);
    });
});
