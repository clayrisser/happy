/**
 * The vitest smoke suite for the ported `drover-pick-pi-session` (DROVE-315).
 *
 * The assertion surface is cattle-drover/tests/pi.bats' two session-picker
 * tests — this project's sessions newest first, and another project's not
 * offered even when the munged directory name collides — plus the contract
 * every drover picker keeps: the picked id on stdout and NOTHING else, the
 * list on stderr, 1 when there is nothing to pick, 2 on an unknown option, 127
 * when jq is missing.
 *
 * One differential test runs the SHELL file's --help and compares it with the
 * node verb's stdout byte for byte.
 *
 * No ~/.pi is read: the session files are an in-memory table behind the io.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { run, type Env, type SessionIo } from './pick-pi-session';

const SHELL = '/Users/clayrisser/Projects/bitspur/cattle-drover/libexec/drover-pick-pi-session';

const OLD = '01a05e34-97a7-79bc-8eeb-9364f0f08673';
const NEW = '01a05e35-97a7-79bc-8eeb-9364f0f08674';
const OTHER = '01a05e36-97a7-79bc-8eeb-9364f0f08675';

function jsonl(id: string, ts: string, cwd: string, text: string): string {
    return [
        JSON.stringify({ type: 'session', version: 3, id, timestamp: ts, cwd }),
        JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text }] } }),
        '',
    ].join('\n');
}

/** The munge collapses `/` and `-`, so both projects land in one directory. */
const FILES: Record<string, string> = {
    '/pi/sessions/--tmp-proj--/a.jsonl': jsonl(OLD, '2026-09-01T18:21:40.135Z', '/tmp/proj', 'the older   one'),
    '/pi/sessions/--tmp-proj--/b.jsonl': jsonl(NEW, '2026-09-02T18:21:40.135Z', '/tmp/proj', 'the newer one'),
    '/pi/sessions/--tmp-proj--/c.jsonl': jsonl(OTHER, '2026-09-03T18:21:40.135Z', '/tmp/proj-elsewhere', 'not yours'),
};

function recorder(env: Env = {}, over: Partial<SessionIo> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io: SessionIo = {
        env: { PATH: '', PI_AGENT_DIR: '/pi', ...env },
        home: mkdtempSync(join(tmpdir(), 'drover-pis-')),
        cwd: '/tmp/proj',
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        which: (n) => (n === 'jq' ? '/usr/bin/jq' : null),
        isDirectory: (p) => p === '/pi/sessions',
        listSessionFiles: () => Object.keys(FILES),
        readFile: (p) => FILES[p] ?? null,
        isTty: () => false,
        gumChoose: () => null,
        readLine: () => null,
        ...over,
    };
    return { io, out, err };
}

describe('drover-pick-pi-session', () => {
    it('answers --help byte for byte with the shell file, and touches nothing', async () => {
        const chunks: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
            chunks.push(String(c));
            return true;
        });
        const boom = (): never => {
            throw new Error('--help must not touch anything');
        };
        const code = await run(['--help'], { io: { ...recorder().io, which: boom, listSessionFiles: boom } });
        spy.mockRestore();
        expect(code).toBe(0);
        const shell = spawnSync('sh', [SHELL, '--help'], { encoding: 'utf8' });
        expect(shell.status).toBe(0);
        expect(chunks.join('')).toBe(shell.stdout);
    });

    it('lists this project sessions newest first, with the prompt collapsed', async () => {
        const list = recorder();
        expect(await run(['--cwd', '/tmp/proj', '--list'], { io: list.io })).toBe(0);
        expect(list.out).toEqual([
            `${NEW}  2026-09-02T18:21:40.135Z  the newer one`,
            `${OLD}  2026-09-01T18:21:40.135Z  the older one`,
        ]);

        const latest = recorder();
        expect(await run(['--cwd', '/tmp/proj', '--latest'], { io: latest.io })).toBe(0);
        expect(latest.out).toEqual([NEW]);
        expect(latest.err).toEqual([]);
    });

    it('verifies the cwd out of the file header, not the directory name', async () => {
        const mine = recorder();
        expect(await run(['--cwd', '/tmp/proj', '--list'], { io: mine.io })).toBe(0);
        expect(mine.out.join('\n')).not.toContain('not yours');

        const all = recorder();
        expect(await run(['--all', '--list'], { io: all.io })).toBe(0);
        expect(all.out.join('\n')).toContain('not yours');
        // --all is also newest first, so the other project's row leads.
        expect(all.out[0]).toContain(OTHER);
    });

    it('says where it looked when there is nothing to pick', async () => {
        const none = recorder();
        expect(await run(['--cwd', '/tmp/elsewhere', '--list'], { io: none.io })).toBe(1);
        expect(none.err).toEqual([
            'drover: no pi sessions for /tmp/elsewhere.',
            '  every project:  drover-pick-pi-session --all',
        ]);

        const nodir = recorder({}, { isDirectory: () => false });
        expect(await run([], { io: nodir.io })).toBe(1);
        expect(nodir.err).toEqual(['drover: no pi sessions on this machine yet (/pi/sessions)']);
    });

    it('is 127 without jq and 2 on an unknown option', async () => {
        const nojq = recorder({}, { which: () => null });
        expect(await run(['--list'], { io: nojq.io })).toBe(127);
        expect(nojq.err).toEqual(['drover-pick-pi-session: jq is required.']);

        const bad = recorder();
        expect(await run(['--nope'], { io: bad.io })).toBe(2);
        expect(bad.err).toEqual(["drover-pick-pi-session: unknown option '--nope'"]);

        const nocwd = recorder();
        expect(await run(['--cwd'], { io: nocwd.io })).toBe(2);
        expect(nocwd.err).toEqual(['drover-pick-pi-session: --cwd needs a directory']);
    });

    it('numbers the rows on stderr and prints only the pick', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const r = recorder({}, { readLine: () => '2' });
        expect(await run(['--cwd', '/tmp/proj'], { io: r.io })).toBe(0);
        stderr.mockRestore();
        expect(r.err).toEqual(['  1) 2026-09-02T18:21  the newer one', '  2) 2026-09-01T18:21  the older one']);
        expect(r.out).toEqual([OLD]);
    });

    it('exits 1 when nothing was picked', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const r = recorder({}, { readLine: () => 'q' });
        expect(await run(['--cwd', '/tmp/proj'], { io: r.io })).toBe(1);
        stderr.mockRestore();
        expect(r.out).toEqual([]);
        expect(r.err.at(-1)).toBe('drover: no pi session picked');
    });
});
