/**
 * The vitest twin of cattle-drover/tests/reclaim.bats (DROVE-315), test for
 * test. The fixture is that file's fixture: the shape the DROVE-40 merge really
 * leaves, in miniature and with every case in it — a winner hard-linked into
 * the store, a shorter copy that is a byte prefix of it, an identical copy on
 * its own inode, one inode with TWO parked links, a copy parked under a
 * timestamped directory, a copy that genuinely diverged, and a file the store
 * has no copy of at all. Every number is arithmetic on 8-byte lines, so
 * "would free 96 B" is a figure that can be checked by hand rather than a
 * golden string, and the same sequence runs: dry, apply, dry again, apply
 * again, then the fence cases.
 *
 * Nothing here touches the real HOME or the real store. HOME is the fixture's
 * own, DROVER_SHARED_STORE points inside it, and the bus URL is a port nothing
 * listens on — the verb never talks to the bus, and this makes sure of it.
 */

import {
    appendFileSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { droverVerbs, runDroverVerb } from './index';
import { freedBytes, human, linesOnlyHere, run, storeKey, toGo, type Verdict } from './reclaim-sessions';

interface Captured {
    code: number;
    out: string;
    err: string;
    /** stdout and stderr together, as bats `run` and `2>&1` read them. */
    all: string;
}

async function capture(args: string[]): Promise<Captured> {
    const out: string[] = [];
    const err: string[] = [];
    const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    try {
        const code = await run(args);
        return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join('') };
    } finally {
        o.mockRestore();
        e.mockRestore();
    }
}

/** bats `lines <path> <from> <to>`: one 8-byte line per number. */
function lines(path: string, from: number, to: number): void {
    mkdirSync(dirname(path), { recursive: true });
    for (let i = from; i <= to; i++) appendFileSync(path, `row ${String(i).padStart(3, '0')}\n`);
}

/** bats `link`: a hard link, parent made. */
function link(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    linkSync(from, to);
}

function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (st.isFile()) out.push(p);
    }
    return out;
}

function lineCount(path: string): number {
    return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').length;
}

describe('drover sessions reclaim — the reclaim.bats fixture, run the same way', () => {
    let root: string;
    let home: string;
    let store: string;
    let parked: string;
    const savedEnv: Record<string, string | undefined> = {};
    const out: Record<string, Captured> = {};
    const inv: Record<string, string[]> = {};
    const disk: Record<string, number> = {};

    /** bats `inventory`: every file under superseded/ and the store's projects/. */
    const inventory = (): string[] => [...walk(parked), ...walk(join(store, 'projects'))].sort();

    /**
     * bats `disk`: every distinct inode under the store, counted ONCE — the
     * same accounting the verb claims to do, computed independently here so
     * "freed 96 B" is measured rather than echoed back.
     */
    const diskBytes = (): number => {
        const sizes = new Map<string, number>();
        for (const p of walk(store)) {
            const st = statSync(p, { bigint: true });
            sizes.set(String(st.ino), Number(st.size));
        }
        let t = 0;
        for (const b of sizes.values()) t += b;
        return t;
    };

    beforeAll(async () => {
        // Canonical, because the verb canonicalises the store before it fences
        // a named path against it — macOS puts tmpdir under /var, which is a
        // symlink to /private/var, and the two spellings would not compare.
        root = realpathSync(mkdtempSync(join(tmpdir(), 'drover-reclaim-')));
        home = join(root, 'home');
        store = join(home, '.claude-shared');
        parked = join(store, 'superseded');
        for (const k of ['HOME', 'DROVER_SHARED_STORE', 'DROVER_URL']) savedEnv[k] = process.env[k];
        process.env.HOME = home;
        process.env.DROVER_SHARED_STORE = store;
        process.env.DROVER_URL = 'http://127.0.0.1:1';

        // --- the store: what every account now reads through its symlink ----
        lines(join(store, 'projects/-proj/s1.jsonl'), 1, 5);
        lines(join(store, 'projects/-proj/dup.jsonl'), 1, 2);
        lines(join(store, 'projects/-proj/s4.jsonl'), 1, 2);
        lines(join(store, 'projects/-proj/s2.jsonl'), 1, 2);
        appendFileSync(join(store, 'projects/-proj/s2.jsonl'), 'row 009\n');
        lines(join(store, 'projects/-proj/memory/MEMORY.md'), 1, 1);

        // --- superseded/: what the merge parked -----------------------------
        // A winner: the parked copy IS the store's inode. Deleting it frees nothing.
        link(join(store, 'projects/-proj/s1.jsonl'), join(parked, 'alt/projects/-proj/s1.jsonl'));
        link(join(store, 'projects/-proj/memory/MEMORY.md'), join(parked, 'bob/projects/-proj/memory/MEMORY.md'));
        // A shorter copy of the winner — a byte prefix. 24 real bytes the store already holds.
        lines(join(parked, 'main/projects/-proj/s1.jsonl'), 1, 3);
        // An identical copy on its own inode. 40 real bytes, same deal.
        lines(join(parked, 'bob/projects/-proj/s1.jsonl'), 1, 5);
        // ONE inode, TWO parked links, and the store has the same content on a
        // different inode. Both links go and the 16 bytes are freed ONCE.
        lines(join(parked, 'alt/projects/-proj/dup.jsonl'), 1, 2);
        link(join(parked, 'alt/projects/-proj/dup.jsonl'), join(parked, 'bob/projects/-proj/dup.jsonl'));
        // Parked under a timestamped directory. Same store key.
        lines(join(parked, 'main/projects.20260830T191100/-proj/s4.jsonl'), 1, 2);
        // Genuinely diverged: two of its lines are in no store file.
        lines(join(parked, 'main/projects/-proj/s2.jsonl'), 1, 2);
        appendFileSync(join(parked, 'main/projects/-proj/s2.jsonl'), 'xxx 003\nxxx 004\n');
        // The store has no copy of this at all.
        lines(join(parked, 'store/projects/-proj/s3.jsonl'), 7, 7);

        // Every account reads the store through a symlink, exactly as the
        // merge leaves them. AC: a reclaim must not disturb that.
        for (const a of [join(home, '.claude'), join(home, '.claude-accounts/alt'), join(home, '.claude-accounts/bob')]) {
            mkdirSync(a, { recursive: true });
            symlinkSync(join(store, 'projects'), join(a, 'projects'));
        }

        inv.before = inventory();
        disk.before = diskBytes();
        out.dry = await capture([]);
        inv.afterDry = inventory();

        out.apply = await capture(['--apply']);
        disk.after = diskBytes();
        inv.afterApply = inventory();

        out.rerun = await capture([]);
        out.rerunApply = await capture(['--apply']);
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        rmSync(root, { recursive: true, force: true });
    });

    // --- the dry run ---------------------------------------------------------

    it('the dry run separates the free hard links from the real bytes', () => {
        expect(out.dry.code).toBe(0);
        expect(out.dry.all).toContain('DRY RUN — nothing will be deleted.');
        expect(out.dry.all).toContain('parked under superseded/: 9 files, 184 B');
        expect(out.dry.all).toContain('2 extra hard links to the store — deleting them frees nothing (48 B)');
        expect(out.dry.all).toContain('5 separate copies whose content the store already holds');
        expect(out.dry.all).toContain('2 hold lines no store file has');
    });

    it('the dry run reports the space that would REALLY be freed', () => {
        // 24 (prefix copy) + 40 (identical copy) + 16 (the two-link inode,
        // once) + 16 (the timestamped copy). Not 184, and not 136 either.
        expect(out.dry.all).toContain('would delete 7 · would free 96 B · would keep 2');
        expect(out.dry.all).toContain('DRY RUN — nothing was deleted.');
    });

    it('the dry run names every file whose content is not also in the store', () => {
        expect(out.dry.all).toContain('NOT IN THE STORE');
        expect(out.dry.all).toContain(`2 lines only here  ${parked}/main/projects/-proj/s2.jsonl`);
        expect(out.dry.all).toContain(`no store copy at all  ${parked}/store/projects/-proj/s3.jsonl`);
    });

    it('the dry run wrote nothing', () => {
        expect(inv.afterDry).toEqual(inv.before);
    });

    it('the dry run is the shell\'s report, line for line', () => {
        expect(out.dry.out.split('\n')).toEqual([
            'DRY RUN — nothing will be deleted. Re-run with --apply to reclaim.',
            `store: ${store}`,
            '',
            'parked under superseded/: 9 files, 184 B',
            '  2 extra hard links to the store — deleting them frees nothing (48 B)',
            '  5 separate copies whose content the store already holds',
            '  2 hold lines no store file has',
            '',
            'NOT IN THE STORE — the only copy of what is in them. --apply never',
            'deletes these; name the path to delete one anyway:',
            `  2 lines only here  ${parked}/main/projects/-proj/s2.jsonl`,
            `  no store copy at all  ${parked}/store/projects/-proj/s3.jsonl`,
            '',
            'would delete 7 · would free 96 B · would keep 2',
            'DRY RUN — nothing was deleted.',
            '',
        ]);
    });

    // --- the apply -----------------------------------------------------------

    it('the apply deleted exactly what the dry run said it would', () => {
        expect(out.apply.code).toBe(0);
        expect(out.apply.all).toContain('deleted 7 · freed 96 B · kept 2');
        // 9 parked plus the store's own 5, then the 7 redundant ones gone.
        expect(inv.before).toHaveLength(14);
        expect(inv.afterApply).toHaveLength(7);
    });

    it('the 96 bytes are really gone from the disk', () => {
        expect(disk.before - disk.after).toBe(96);
    });

    it('every transcript is still readable from every account', () => {
        for (const a of [join(home, '.claude'), join(home, '.claude-accounts/alt'), join(home, '.claude-accounts/bob')]) {
            expect(lstatSync(join(a, 'projects')).isSymbolicLink()).toBe(true);
            expect(lineCount(join(a, 'projects/-proj/s1.jsonl'))).toBe(5);
            expect(lineCount(join(a, 'projects/-proj/s2.jsonl'))).toBe(3);
            expect(lineCount(join(a, 'projects/-proj/dup.jsonl'))).toBe(2);
            expect(lineCount(join(a, 'projects/-proj/s4.jsonl'))).toBe(2);
            expect(lineCount(join(a, 'projects/-proj/memory/MEMORY.md'))).toBe(1);
        }
    });

    it('the files holding lines nothing else has survived, byte for byte', () => {
        const s2 = join(parked, 'main/projects/-proj/s2.jsonl');
        expect(existsSync(s2)).toBe(true);
        expect(lineCount(s2)).toBe(4);
        expect(readFileSync(s2, 'utf8')).toContain('xxx 004\n');
        const s3 = join(parked, 'store/projects/-proj/s3.jsonl');
        expect(existsSync(s3)).toBe(true);
        expect(readFileSync(s3, 'utf8')).toBe('row 007\n');
    });

    it('the directories that emptied are pruned and the ones still holding something are not', () => {
        expect(out.apply.all).toContain('pruned');
        expect(existsSync(join(parked, 'alt'))).toBe(false);
        expect(existsSync(join(parked, 'bob'))).toBe(false);
        expect(existsSync(join(parked, 'main/projects.20260830T191100'))).toBe(false);
        expect(statSync(join(parked, 'main/projects/-proj')).isDirectory()).toBe(true);
        expect(statSync(join(parked, 'store/projects/-proj')).isDirectory()).toBe(true);
    });

    // --- again ---------------------------------------------------------------

    it('a second run is a no-op, and says so rather than reporting zeroes', () => {
        expect(out.rerun.code).toBe(0);
        expect(out.rerunApply.code).toBe(0);
        expect(out.rerun.all).toContain('nothing to reclaim — every parked file left holds lines the store does not.');
        expect(out.rerunApply.all).toContain('nothing to reclaim');
        expect(inventory()).toEqual(inv.afterApply);
    });

    // --- the fence around the unique copies ----------------------------------

    it('a path outside superseded/ is refused, not deleted', async () => {
        const r = await capture(['--apply', join(store, 'projects/-proj/s1.jsonl')]);
        expect(r.code).toBe(2);
        expect(r.all).toContain('is not under');
        expect(existsSync(join(store, 'projects/-proj/s1.jsonl'))).toBe(true);
    });

    it('a path that does not exist is refused', async () => {
        const r = await capture(['--apply', join(parked, 'main/projects/-proj/nope.jsonl')]);
        expect(r.code).toBe(2);
        expect(r.all).toContain('no such file');
    });

    it('an unknown flag is refused rather than ignored', async () => {
        const r = await capture(['--force']);
        expect(r.code).toBe(2);
        expect(r.all).toContain("unknown argument '--force'");
    });

    it('naming a unique file is the only way it goes', async () => {
        const s2 = join(parked, 'main/projects/-proj/s2.jsonl');
        // Still there after a plain apply that has already run twice.
        expect(existsSync(s2)).toBe(true);
        const dry = await capture([s2]);
        expect(dry.code).toBe(0);
        expect(dry.all).toContain('NAMED on the command line');
        expect(dry.all).toContain('would delete 1 · would free 32 B');
        // ... and the dry run still did not touch it.
        expect(existsSync(s2)).toBe(true);

        const apply = await capture(['--apply', s2]);
        expect(apply.code).toBe(0);
        expect(apply.all).toContain('deleted 1 · freed 32 B');
        expect(existsSync(s2)).toBe(false);
        // The one nobody named is untouched.
        expect(existsSync(join(parked, 'store/projects/-proj/s3.jsonl'))).toBe(true);
    });

    it('a store holding only the parked tree keeps every file in it', async () => {
        // The store scan is empty here, which is the case that used to read
        // the PARKED scan as the store and then report nothing to reclaim
        // about files that were the only copies of themselves.
        const lonely = join(root, 'lonely');
        mkdirSync(join(lonely, 'superseded/main/projects/-proj'), { recursive: true });
        writeFileSync(join(lonely, 'superseded/main/projects/-proj/s9.jsonl'), 'only here\n');
        process.env.DROVER_SHARED_STORE = lonely;
        try {
            const r = await capture(['--apply']);
            expect(r.code).toBe(0);
            expect(r.all).toContain('no store copy at all');
            expect(r.all).toContain('1 hold lines no store file has');
            expect(existsSync(join(lonely, 'superseded/main/projects/-proj/s9.jsonl'))).toBe(true);
        } finally {
            process.env.DROVER_SHARED_STORE = store;
        }
    });

    it('a store with nothing parked says so and exits clean', async () => {
        const empty = join(root, 'empty-store');
        mkdirSync(empty, { recursive: true });
        process.env.DROVER_SHARED_STORE = empty;
        try {
            const r = await capture([]);
            expect(r.code).toBe(0);
            expect(r.all).toContain('nothing is parked under superseded/');
        } finally {
            process.env.DROVER_SHARED_STORE = store;
        }
    });

    it('a superseded/ with no files in it says so and exits clean', async () => {
        const bare = join(root, 'bare-store');
        mkdirSync(join(bare, 'superseded/main'), { recursive: true });
        process.env.DROVER_SHARED_STORE = bare;
        try {
            const r = await capture([]);
            expect(r.code).toBe(0);
            expect(r.all).toContain('superseded/ holds no files — there is nothing to reclaim.');
        } finally {
            process.env.DROVER_SHARED_STORE = store;
        }
    });
});

// --- the command that dispatches it -----------------------------------------

describe('drover reclaim-sessions — the verb table, and help before anything loads', () => {
    it('is one lazy row in the table', () => {
        const row = droverVerbs.find((v) => v.name === 'reclaim-sessions');
        expect(row).toBeDefined();
        expect(row?.summary).toMatch(/superseded/);
    });

    it('reaches the verb through runDroverVerb and answers --help without touching the store', async () => {
        const saved = { store: process.env.DROVER_SHARED_STORE, home: process.env.HOME };
        // A store that does not exist, and a HOME that does not either: help
        // must answer before either is looked at, the way the shell answered
        // --help before it spawned anything.
        process.env.DROVER_SHARED_STORE = '/nonexistent/drover-reclaim-help/store';
        process.env.HOME = '/nonexistent/drover-reclaim-help/home';
        const out: string[] = [];
        const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        try {
            const code = await runDroverVerb('reclaim-sessions', ['--help']);
            expect(code).toBe(0);
            const text = out.join('');
            expect(text).toContain('drover sessions reclaim');
            expect(text).toContain('WHAT IT NEVER DELETES');
            expect(text).not.toContain('store:');
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            o.mockRestore();
            fetchSpy.mockRestore();
            if (saved.store === undefined) delete process.env.DROVER_SHARED_STORE;
            else process.env.DROVER_SHARED_STORE = saved.store;
            if (saved.home === undefined) delete process.env.HOME;
            else process.env.HOME = saved.home;
        }
    });

    it('-h is the same help, and a path before --help is still fenced first', async () => {
        const out: string[] = [];
        const err: string[] = [];
        const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
        const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
        try {
            expect(await run(['-h'])).toBe(0);
            expect(out.join('')).toContain('WHAT IT DELETES');
            expect(await run(['/nonexistent/drover-reclaim/nope.jsonl', '--help'])).toBe(2);
            expect(err.join('')).toContain('drover sessions reclaim: no such file: /nonexistent/drover-reclaim/nope.jsonl');
        } finally {
            o.mockRestore();
            e.mockRestore();
        }
    });
});

// --- the awk passes, as units -----------------------------------------------

describe('drover sessions reclaim — the store key (the awk that strips the park suffix)', () => {
    it('is <subdir>/<rest> under the account', () => {
        expect(storeKey('main/projects/-proj/s1.jsonl')).toBe('projects/-proj/s1.jsonl');
    });

    it('drops a timestamp suffix the merge added to park one account twice', () => {
        expect(storeKey('main/projects.20260830T191100/-proj/s4.jsonl')).toBe('projects/-proj/s4.jsonl');
    });

    it('drops a counter suffix the same way', () => {
        expect(storeKey('main/projects.2/-proj/s4.jsonl')).toBe('projects/-proj/s4.jsonl');
    });

    it('is empty for a path too shallow to have one', () => {
        expect(storeKey('main')).toBe('');
        expect(storeKey('main/projects')).toBe('');
    });
});

describe('drover sessions reclaim — human bytes (the awk that says them)', () => {
    it('says bytes whole and larger units to two places', () => {
        expect(human(0)).toBe('0 B');
        expect(human(96)).toBe('96 B');
        expect(human(1023)).toBe('1023 B');
        expect(human(1024)).toBe('1.00 KB');
        expect(human(1536)).toBe('1.50 KB');
        expect(human(9.79 * 1024 * 1024 * 1024)).toBe('9.79 GB');
    });
});

describe('drover sessions reclaim — freed bytes are per inode, and only when every link goes', () => {
    const v = (op: Verdict['op'], size: number, ino: string, links: number, path: string): Verdict => ({
        op, size, ino, links, only: 0, path,
    });

    it('counts an inode once, and not at all while a link to it stays', () => {
        const verdicts = [
            v('LINKED', 40, 'store-1', 2, '/p/alt/s1'),
            v('COPY', 16, 'dup', 2, '/p/alt/dup'),
            v('COPY', 16, 'dup', 2, '/p/bob/dup'),
            v('COPY', 24, 'pre', 1, '/p/main/s1'),
            v('DIVERGED', 32, 'div', 1, '/p/main/s2'),
        ];
        const going = toGo(verdicts, []);
        expect(going).toEqual(['/p/alt/s1', '/p/alt/dup', '/p/bob/dup', '/p/main/s1']);
        expect(freedBytes(verdicts, going)).toBe(16 + 24);
    });

    it('a named path goes too, and one the scan never saw is appended', () => {
        const verdicts = [v('DIVERGED', 32, 'div', 1, '/p/main/s2'), v('ORPHAN', 8, 'orp', 1, '/p/store/s3')];
        expect(toGo(verdicts, ['/p/main/s2', '/p/new'])).toEqual(['/p/main/s2', '/p/new']);
        expect(freedBytes(verdicts, ['/p/main/s2', '/p/new'])).toBe(32);
    });
});

describe('drover sessions reclaim — lines only here (sort -u | comm -13)', () => {
    it('counts distinct lines the parked copy holds that the store copy does not, at any offset', () => {
        const dir = mkdtempSync(join(tmpdir(), 'drover-reclaim-lines-'));
        try {
            writeFileSync(join(dir, 'store'), 'a\nb\nc\n');
            writeFileSync(join(dir, 'same'), 'c\nb\na\n');
            writeFileSync(join(dir, 'more'), 'a\nx\nx\ny');
            writeFileSync(join(dir, 'empty'), '');
            expect(linesOnlyHere(join(dir, 'same'), join(dir, 'store'))).toBe(0);
            expect(linesOnlyHere(join(dir, 'more'), join(dir, 'store'))).toBe(2);
            expect(linesOnlyHere(join(dir, 'empty'), join(dir, 'store'))).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
