/**
 * The vitest smoke suite for the ported `drover pick-cursor-chat` (DROVE-315).
 *
 * The assertions that matter are the contract — the picked id on stdout and
 * NOTHING else, the list on stderr, 1 when there is nothing to pick or nothing
 * was picked, 2 on an unknown argument — plus the two rules the shell file was
 * written for: CURSOR_CONFIG_DIR || XDG_CONFIG_HOME/cursor || ~/.cursor (the
 * config-dir-not-data-dir fix), and `hasConversation:false` rows dropped.
 *
 * One differential test runs the SHELL file's --help and compares it with the
 * node verb's stdout byte for byte.
 *
 * No ~/.cursor is read: the meta.json tree is an in-memory table behind the io,
 * and `home` is a mkdtemp.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { cursorChatsDir, run, type ChatIo, type Env } from './pick-cursor-chat';

const SHELL = '/Users/clayrisser/Projects/bitspur/cattle-drover/libexec/drover-pick-cursor-chat';

const NOW = 1_800_000_000;
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
const D = 'dddddddd-4444-4444-8444-444444444444';

/** `<chats>/<32 hex>/<uuid>/meta.json`, one row each. */
const METAS: Record<string, string> = {
    [`/cfg/chats/hex1/${A}/meta.json`]: JSON.stringify({ updatedAtMs: (NOW - 30) * 1000, cwd: '/tmp/proj', hasConversation: true }),
    [`/cfg/chats/hex1/${B}/meta.json`]: JSON.stringify({ updatedAtMs: (NOW - 7200) * 1000, cwd: '/tmp/proj', hasConversation: true }),
    // Minted and abandoned: resuming it is indistinguishable from starting
    // fresh, except that it looks like history.
    [`/cfg/chats/hex2/${C}/meta.json`]: JSON.stringify({ updatedAtMs: NOW * 1000, cwd: '/tmp/proj', hasConversation: false }),
    // Another directory entirely — only --all sees it.
    [`/cfg/chats/hex2/${D}/meta.json`]: JSON.stringify({ createdAtMs: (NOW - 10) * 1000, cwd: '/tmp/other', hasConversation: true }),
};

function recorder(env: Env = {}, over: Partial<ChatIo> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const raw: string[] = [];
    const io: ChatIo = {
        env: { PATH: '', CURSOR_CONFIG_DIR: '/cfg', ...env },
        home: mkdtempSync(join(tmpdir(), 'drover-pcc-')),
        cwd: '/tmp/proj',
        now: () => NOW,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        errRaw: (t) => raw.push(t),
        which: (n) => (n === 'jq' ? '/usr/bin/jq' : null),
        isDirectory: (p) => p === '/cfg/chats',
        listMetas: () => Object.keys(METAS),
        readFile: (p) => METAS[p] ?? null,
        isTty: () => false,
        gumChoose: () => null,
        readLine: () => null,
        ...over,
    };
    return { io, out, err, raw };
}

describe('drover pick-cursor-chat', () => {
    it('answers --help byte for byte with the shell file, and touches nothing', async () => {
        const chunks: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
            chunks.push(String(c));
            return true;
        });
        const boom = (): never => {
            throw new Error('--help must not touch anything');
        };
        const code = await run(['--help'], { io: { ...recorder().io, which: boom, listMetas: boom } });
        spy.mockRestore();
        expect(code).toBe(0);
        const shell = spawnSync('sh', [SHELL, '--help'], { encoding: 'utf8' });
        expect(shell.status).toBe(0);
        expect(chunks.join('')).toBe(shell.stdout);
    });

    it('resolves the CONFIG dir, never the data dir', async () => {
        expect(cursorChatsDir({ CURSOR_CONFIG_DIR: '/cfg' }, '/h')).toBe('/cfg/chats');
        expect(cursorChatsDir({ XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/cursor/chats');
        expect(cursorChatsDir({}, '/h')).toBe('/h/.cursor/chats');
        // CURSOR_DATA_DIR follows `projects/` only, and must not be consulted.
        expect(cursorChatsDir({ CURSOR_DATA_DIR: '/data' }, '/h')).toBe('/h/.cursor/chats');
    });

    it('drops hasConversation:false rows, keeps this cwd, newest first', async () => {
        const list = recorder();
        expect(await run(['--list'], { io: list.io })).toBe(0);
        expect(list.out).toEqual([`${A.slice(0, 8)}  just now`, `${B.slice(0, 8)}  2h ago  `]);
        expect(list.out.join('\n')).not.toContain(C.slice(0, 8));
        expect(list.out.join('\n')).not.toContain(D.slice(0, 8));

        const latest = recorder();
        expect(await run(['--latest'], { io: latest.io })).toBe(0);
        expect(latest.out).toEqual([A]);
        expect(latest.err).toEqual([]);
    });

    it('--all shows every directory, with the dir abbreviated', async () => {
        const all = recorder();
        expect(await run(['--all', '--list'], { io: all.io })).toBe(0);
        expect(all.out).toEqual([
            `${D.slice(0, 8)}  just now  /tmp/other`,
            `${A.slice(0, 8)}  just now  /tmp/proj`,
            `${B.slice(0, 8)}  2h ago    /tmp/proj`,
        ]);
    });

    it('says there is nothing to pick, and how to widen it', async () => {
        const none = recorder();
        expect(await run(['--cwd', '/tmp/nowhere', '--list'], { io: none.io })).toBe(1);
        expect(none.err).toEqual([
            'drover: no Cursor chat with messages in /tmp/nowhere',
            '        try --all to see every directory',
        ]);

        const nodir = recorder({}, { isDirectory: () => false });
        expect(await run([], { io: nodir.io })).toBe(1);
        expect(nodir.err).toEqual(['drover pick-cursor-chat: no Cursor chats at /cfg/chats']);
    });

    it('refuses an unknown argument, and a --cwd with nothing after it', async () => {
        const bad = recorder();
        expect(await run(['--nope'], { io: bad.io })).toBe(2);
        expect(bad.err).toEqual(['drover pick-cursor-chat: unknown argument: --nope']);

        const nocwd = recorder();
        expect(await run(['--cwd'], { io: nocwd.io })).toBe(2);
        expect(nocwd.err).toEqual(['drover pick-cursor-chat: --cwd needs a directory']);

        // jq missing is exit 1 here, not 127 — the shell's own choice, kept.
        const nojq = recorder({}, { which: () => null });
        expect(await run([], { io: nojq.io })).toBe(1);
        expect(nojq.err).toEqual(['drover pick-cursor-chat: jq not found.']);
    });

    it('numbers the rows on stderr and prints only the pick', async () => {
        const r = recorder({}, { readLine: () => '2' });
        expect(await run([], { io: r.io })).toBe(0);
        expect(r.err[0]).toBe('resume which Cursor chat?  /tmp/proj');
        expect(r.err[1]).toBe(`   1) ${A.slice(0, 8)}  just now`);
        expect(r.raw).toEqual(['number [1-2], or q: ']);
        expect(r.out).toEqual([B]);
    });

    it('exits 1 on q, an out-of-range number, and end of input', async () => {
        for (const ans of ['q', '9', null]) {
            const r = recorder({}, { readLine: () => ans });
            expect(await run([], { io: r.io })).toBe(1);
            expect(r.out).toEqual([]);
            expect(r.err.at(-1)).toBe('drover: no Cursor chat picked');
        }
    });
});
