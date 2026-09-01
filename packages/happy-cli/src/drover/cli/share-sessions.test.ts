/**
 * The vitest twin of cattle-drover/tests/share.bats (DROVE-315). The same
 * fixture — three accounts colliding on one transcript, a solo file, a
 * subagent transcript, memory, an upload that must not move, and a store that
 * already holds alt's copy by inode from an earlier run that died — and the
 * same live writer, a child process appending every 20ms across the whole
 * --apply, each append its own open(2) the way claude writes. Each `it` in the
 * first describe is one @test there, in the same order, asserting the same
 * paths, inodes, counts and lines. share.bats stays green against the shell
 * until its arm is flipped; this is what lets it flip.
 *
 * Nothing here touches the real HOME. The fixture is its own HOME with its own
 * accounts and its own store under tmpdir (a hard link needs one filesystem),
 * the bus URL is a port nothing listens on, and the process count is injected
 * as zero so the host's own sessions do not leak into the output.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
    appendFileSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { decide, run, shareSessions, type ScanRow } from './share-sessions';

/** `lines <path> <n>`: n identical-length lines, so size order is line-count order. */
function lines(path: string, n: number): void {
    mkdirSync(dirname(path), { recursive: true });
    for (let i = 1; i <= n; i++) appendFileSync(path, `row ${String(i).padStart(3, '0')}\n`);
}

function ino(p: string): bigint {
    return statSync(p, { bigint: true }).ino;
}

function count(p: string): number {
    return readFileSync(p, 'utf8').split('\n').length - 1;
}

function isLink(p: string): boolean {
    try {
        return lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

function capture(): { say: (line: string) => void; text: () => string; lines: () => string[] } {
    const out: string[] = [];
    return {
        say: (line) => void out.push(line),
        text: () => out.join('\n') + (out.length ? '\n' : ''),
        lines: () => [...out],
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `wait_bounded`: reap the writer, or kill it and move on. */
function waitBounded(child: ChildProcess, ms: number): Promise<void> {
    return new Promise((resolve) => {
        const dog = setTimeout(() => child.kill('SIGKILL'), ms);
        child.once('exit', () => {
            clearTimeout(dog);
            resolve();
        });
    });
}

/**
 * The writer, as share.bats runs it: append, count the appends that landed,
 * stop on a flag. A node child rather than a shell loop, so it runs the same
 * on mac and linux; appendFileSync is one open(2) per append, like claude.
 * argv: <stop flag> <transcript> <ok counter file>.
 */
const WRITER = `
const fs = require('node:fs');
const [stop, file, okPath] = process.argv.slice(1);
let ok = 0;
let i = 0;
const tick = () => {
    if (fs.existsSync(stop)) process.exit(0);
    i += 1;
    try {
        fs.appendFileSync(file, 'line ' + i + '\\n');
        ok += 1;
        fs.writeFileSync(okPath, String(ok));
    } catch {}
    setTimeout(tick, 20);
};
tick();
`;

describe('drover share-sessions — share.bats, test for test', () => {
    let HOME: string;
    let STORE: string;
    let MAIN: string;
    let ALT: string;
    let BOB: string;
    let OUT: string;
    let dry: ReturnType<typeof capture>;
    let dryRc: number;
    let apply: ReturnType<typeof capture>;
    let applyRc: number;
    let linesAfterApply: number;
    let writer: ChildProcess;

    const common = () => ({
        home: HOME,
        store: STORE,
        droverUrl: 'http://127.0.0.1:1',
        countProcesses: () => 0,
    });

    beforeAll(async () => {
        const root = mkdtempSync(join(tmpdir(), 'drover-share-'));
        HOME = join(root, 'home');
        STORE = `${HOME}/.claude-shared`;
        MAIN = `${HOME}/.claude`;
        ALT = `${HOME}/.claude-accounts/alt`;
        BOB = `${HOME}/.claude-accounts/bob`;
        OUT = join(root, 'out');
        mkdirSync(OUT, { recursive: true });

        // A collision three ways: alt is the largest and wins, main and bob lose.
        lines(`${MAIN}/projects/-proj/s1.jsonl`, 3);
        lines(`${BOB}/projects/-proj/s1.jsonl`, 4);
        lines(`${ALT}/projects/-proj/s1.jsonl`, 5);
        // A solo file, a subagent transcript, memory, and an upload that must
        // stay exactly where it is.
        lines(`${MAIN}/projects/-proj/s2.jsonl`, 2);
        lines(`${ALT}/projects/-proj/s1/subagents/agent-x.jsonl`, 2);
        lines(`${MAIN}/projects/-proj/memory/MEMORY.md`, 1);
        lines(`${MAIN}/uploads/img.png`, 1);
        // The transcript the live writer appends to.
        lines(`${MAIN}/projects/-live/s3.jsonl`, 1);
        // An earlier run that died after linking alt's s1: same inode in the
        // store already. The plan has to see one file, not a collision.
        mkdirSync(`${STORE}/projects/-proj`, { recursive: true });
        linkSync(`${ALT}/projects/-proj/s1.jsonl`, `${STORE}/projects/-proj/s1.jsonl`);

        dry = capture();
        dryRc = await shareSessions({ ...common(), apply: false, say: dry.say });

        const stop = join(OUT, 'writer.stop');
        const ok = join(OUT, 'writer.ok');
        writer = spawn(process.execPath, ['-e', WRITER, stop, `${MAIN}/projects/-live/s3.jsonl`, ok], { stdio: 'ignore' });
        await sleep(200);

        apply = capture();
        applyRc = await shareSessions({ ...common(), apply: true, say: apply.say });
        linesAfterApply = count(`${STORE}/projects/-live/s3.jsonl`);

        // Keep writing for a while AFTER the swap, then stop cleanly so the
        // count and the file agree.
        await sleep(500);
        writeFileSync(stop, '');
        await waitBounded(writer, 10_000);
    }, 30_000);

    afterAll(() => {
        if (writer && writer.exitCode === null) writer.kill('SIGKILL');
    });

    // --- the plan ------------------------------------------------------------

    it('the dry run wrote nothing and named both losers', () => {
        expect(dryRc).toBe(0);
        const text = dry.text();
        expect(text).toContain('DRY RUN — nothing was written.');
        expect(text).toContain(`${MAIN}/projects/-proj/s1.jsonl`);
        expect(text).toContain(`${BOB}/projects/-proj/s1.jsonl`);
        expect(text).toContain(`-> ${STORE}/superseded/main/projects/-proj/s1.jsonl`);
        // alt's s1 is already in the store by inode: not a collision, not a link.
        expect(dry.lines().some((l) => /^ {2}.* /.test(l) && l.endsWith(`${ALT}/projects/-proj/s1.jsonl`))).toBe(false);
        expect(text).toContain('would link 4 · supersede 2 · swap 3 · already shared 0');
    });

    it('the apply executed the plan the dry run printed', () => {
        expect(applyRc).toBe(0);
        const want = dry
            .lines()
            .map((l) => /^would link (\d+) · supersede (\d+) · swap (\d+) · already shared (\d+)$/.exec(l))
            .find(Boolean);
        const got = apply
            .lines()
            .map((l) => /^linked (\d+) · superseded (\d+) · swapped (\d+) · caught up \d+ · already shared (\d+)$/.exec(l))
            .find(Boolean);
        expect(want).toBeTruthy();
        expect(got).toBeTruthy();
        expect(got!.slice(1)).toEqual(want!.slice(1));
    });

    // --- what the store holds --------------------------------------------------

    it("every account's projects/ is a symlink to the store", () => {
        for (const cfg of [MAIN, ALT, BOB]) {
            expect(isLink(`${cfg}/projects`), cfg).toBe(true);
            expect(readlinkSync(`${cfg}/projects`), cfg).toBe(`${STORE}/projects`);
        }
    });

    it('uploads/ is left alone: a real directory, nothing in the store', () => {
        expect(statSync(`${MAIN}/uploads`).isDirectory()).toBe(true);
        expect(isLink(`${MAIN}/uploads`)).toBe(false);
        expect(existsSync(`${STORE}/uploads`)).toBe(false);
        expect(existsSync(`${STORE}/superseded/main/uploads`)).toBe(false);
    });

    it('the largest copy won and every loser is under superseded/, intact', () => {
        expect(count(`${STORE}/projects/-proj/s1.jsonl`)).toBe(5);
        expect(ino(`${STORE}/projects/-proj/s1.jsonl`)).toBe(ino(`${STORE}/superseded/alt/projects/-proj/s1.jsonl`));
        expect(count(`${STORE}/superseded/main/projects/-proj/s1.jsonl`)).toBe(3);
        expect(count(`${STORE}/superseded/bob/projects/-proj/s1.jsonl`)).toBe(4);
        expect(ino(`${STORE}/superseded/main/projects/-proj/s1.jsonl`)).not.toBe(ino(`${STORE}/projects/-proj/s1.jsonl`));
    });

    it('a solo file, a subagent transcript and memory are hard links, not copies', () => {
        expect(ino(`${STORE}/projects/-proj/s2.jsonl`)).toBe(ino(`${STORE}/superseded/main/projects/-proj/s2.jsonl`));
        expect(ino(`${STORE}/projects/-proj/s1/subagents/agent-x.jsonl`)).toBe(
            ino(`${STORE}/superseded/alt/projects/-proj/s1/subagents/agent-x.jsonl`),
        );
        expect(ino(`${STORE}/projects/-proj/memory/MEMORY.md`)).toBe(ino(`${STORE}/superseded/main/projects/-proj/memory/MEMORY.md`));
    });

    // --- the live writer -------------------------------------------------------

    it('every append the writer made is in the store, before and after the swap', () => {
        const ok = Number(readFileSync(join(OUT, 'writer.ok'), 'utf8').trim());
        expect(ok).toBeGreaterThan(0);
        // One seed line plus every append that returned success. An append that
        // landed inside the swap window failed and is not counted, which is the
        // whole contract: it fails, it does not vanish.
        expect(count(`${STORE}/projects/-live/s3.jsonl`)).toBe(ok + 1);
        // And some of those landed AFTER the apply returned, through the symlink.
        expect(count(`${STORE}/projects/-live/s3.jsonl`)).toBeGreaterThan(linesAfterApply);
        expect(count(`${MAIN}/projects/-live/s3.jsonl`)).toBe(ok + 1);
    });

    it("the store's file IS the parked winner", () => {
        expect(ino(`${STORE}/projects/-live/s3.jsonl`)).toBe(ino(`${STORE}/superseded/main/projects/-live/s3.jsonl`));
    });

    it('a write through an account path lands in the store', () => {
        const before = count(`${STORE}/projects/-proj/s1.jsonl`);
        appendFileSync(`${ALT}/projects/-proj/s1.jsonl`, 'from alt\n');
        expect(count(`${STORE}/projects/-proj/s1.jsonl`)).toBe(before + 1);
        expect(count(`${BOB}/projects/-proj/s1.jsonl`)).toBe(before + 1);
    });

    // --- again -----------------------------------------------------------------

    it('a second apply is a no-op', async () => {
        const cap = capture();
        expect(await shareSessions({ ...common(), apply: true, say: cap.say })).toBe(0);
        expect(cap.text()).toContain('linked 0 · superseded 0 · swapped 0 · caught up 0 · already shared 3');
        expect(count(`${STORE}/superseded/main/projects/-proj/s1.jsonl`)).toBe(3);
        for (const cfg of [MAIN, ALT, BOB]) expect(isLink(`${cfg}/projects`), cfg).toBe(true);
    });

    it('an account without projects/ gets the link too', async () => {
        mkdirSync(`${HOME}/.claude-accounts/new`, { recursive: true });
        const cap = capture();
        expect(await shareSessions({ ...common(), apply: true, say: cap.say })).toBe(0);
        expect(cap.text()).toContain('swapped 1');
        expect(isLink(`${HOME}/.claude-accounts/new/projects`)).toBe(true);
        expect(readlinkSync(`${HOME}/.claude-accounts/new/projects`)).toBe(`${STORE}/projects`);
    });
});

describe('drover share-sessions — decide (the sort | awk, row for row)', () => {
    it('the store wins a tie and is never linked over itself; a store loser is evicted before the winner links; a shared inode needs nothing', () => {
        const rows: ScanRow[] = [
            { key: 'projects/p/a.jsonl', bytes: 10, account: 'main', path: '/h/.claude/projects/p/a.jsonl', ino: 1n },
            { key: 'projects/p/a.jsonl', bytes: 10, account: '(store)', path: '/s/projects/p/a.jsonl', ino: 2n },
            { key: 'projects/p/b.jsonl', bytes: 5, account: '(store)', path: '/s/projects/p/b.jsonl', ino: 3n },
            { key: 'projects/p/b.jsonl', bytes: 9, account: 'alt', path: '/h/.claude-accounts/alt/projects/p/b.jsonl', ino: 4n },
            { key: 'projects/p/c.jsonl', bytes: 1, account: 'main', path: '/h/.claude/projects/p/c.jsonl', ino: 5n },
            { key: 'projects/p/c.jsonl', bytes: 1, account: 'alt', path: '/h/.claude-accounts/alt/projects/p/c.jsonl', ino: 5n },
        ];
        expect(decide(rows, '/s')).toEqual([
            { op: 'KEEP', from: '/h/.claude/projects/p/a.jsonl', to: '/s/superseded/main/projects/p/a.jsonl', bytes: 10 },
            { op: 'EVICT', from: '/s/projects/p/b.jsonl', to: '/s/superseded/store/projects/p/b.jsonl', bytes: 5 },
            { op: 'LINK', from: '/h/.claude-accounts/alt/projects/p/b.jsonl', to: '/s/projects/p/b.jsonl' },
            { op: 'LINK', from: '/h/.claude-accounts/alt/projects/p/c.jsonl', to: '/s/projects/p/c.jsonl' },
        ]);
    });

    it('an equal-sized account tie goes to the first name, and the other copy is a loser', () => {
        const rows: ScanRow[] = [
            { key: 'projects/p/t.jsonl', bytes: 8, account: 'main', path: '/h/.claude/projects/p/t.jsonl', ino: 7n },
            { key: 'projects/p/t.jsonl', bytes: 8, account: 'alt', path: '/h/.claude-accounts/alt/projects/p/t.jsonl', ino: 8n },
        ];
        expect(decide(rows, '/s')).toEqual([
            { op: 'KEEP', from: '/h/.claude/projects/p/t.jsonl', to: '/s/superseded/main/projects/p/t.jsonl', bytes: 8 },
            { op: 'LINK', from: '/h/.claude-accounts/alt/projects/p/t.jsonl', to: '/s/projects/p/t.jsonl' },
        ]);
    });
});

describe("drover share-sessions — the live-session warning, in the shell's lines", () => {
    it('names the processes and the sessions the bus calls live, and nothing else', async () => {
        const server = createServer((_req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(
                JSON.stringify({
                    sessions: [
                        { id: 'deadbeef-0000-1111-2222-333333333333', state: 'live', account: 'alt', cwd: '/w' },
                        { id: 'cafebabe-0000-1111-2222-333333333333', state: 'gone', account: 'main', cwd: '/x' },
                        { id: 'feedface-0000-1111-2222-333333333333', state: 'live-idle', account: null, cwd: null },
                    ],
                }),
            );
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;
        const home = join(mkdtempSync(join(tmpdir(), 'drover-share-')), 'home');
        const store = `${home}/.claude-shared`;
        const cap = capture();
        let rc: number;
        try {
            rc = await shareSessions({
                home,
                store,
                apply: false,
                droverUrl: `http://127.0.0.1:${port}`,
                countProcesses: (pattern) => (pattern === 'claude/versions/' ? 2 : 1),
                say: cap.say,
            });
        } finally {
            server.close();
        }
        expect(rc).toBe(0);
        expect(cap.lines()).toEqual([
            'DRY RUN — nothing will be written. Re-run with --apply to execute this plan.',
            `store: ${store}`,
            '',
            'WARNING: sessions are running and are writing to files this shares.',
            'That is supported — see the header — but an append that lands inside a',
            'swap fails once.',
            '  processes: 2 claude 1 happy-cli',
            '  live on the bus:',
            '  deadbeef  alt  live  /w',
            '  feedface  -  live-idle  ',
            '',
            'would link 0 · supersede 0 · swap 1 · already shared 0',
            'DRY RUN — nothing was written.',
        ]);
        // A dry run against an empty home wrote nothing.
        expect(existsSync(store)).toBe(false);
        expect(existsSync(`${home}/.claude`)).toBe(false);
    });

    it('a bus nothing listens on contributes no line, and so does a zero process count', async () => {
        const home = join(mkdtempSync(join(tmpdir(), 'drover-share-')), 'home');
        const store = `${home}/.claude-shared`;
        const cap = capture();
        expect(
            await shareSessions({ home, store, apply: false, droverUrl: 'http://127.0.0.1:1', countProcesses: () => 0, say: cap.say }),
        ).toBe(0);
        expect(cap.lines()).toEqual([
            'DRY RUN — nothing will be written. Re-run with --apply to execute this plan.',
            `store: ${store}`,
            '',
            'would link 0 · supersede 0 · swap 1 · already shared 0',
            'DRY RUN — nothing was written.',
        ]);
    });
});

describe('drover share-sessions — the argument line', () => {
    it('--help, -h and help print the usage, exit 0, and touch neither the bus nor a file', async () => {
        for (const flag of ['--help', '-h', 'help']) {
            const out: string[] = [];
            const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            const code = await run([flag]);
            stdout.mockRestore();
            const text = out.join('');
            expect(code, flag).toBe(0);
            expect(text, flag).toContain(
                'drover share-sessions — one session store for every account, so a flip\nstops copying transcripts (DROVE-40).',
            );
            expect(text, flag).toContain('drover share-sessions --apply    execute it');
            expect(fetchSpy, flag).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        }
    });

    it('an unknown word, or a stray one after --apply, is the usage line on stderr and exit 2', async () => {
        for (const args of [['--bogus'], ['--apply', 'extra'], ['apply']]) {
            const err: string[] = [];
            const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            const code = await run(args);
            stderr.mockRestore();
            expect(code, args.join(' ')).toBe(2);
            expect(err.join(''), args.join(' ')).toBe('usage: drover share-sessions [--apply]\n');
            expect(fetchSpy, args.join(' ')).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        }
    });
});
