/**
 * `drover sessions reclaim` — the disk the session-store merge parked, and
 * what it would really cost to get it back (DROVE-66), in node (DROVE-315).
 *
 * A straight port of cattle-drover/libexec/drover-reclaim-sessions: the same
 * arguments, the same exit codes, the same lines. The shell's three awk
 * passes (decide, account, free) are the three functions below, and its
 * `cmp -n` / `sort -u | comm -13` comparison is `sharesPrefix` /
 * `linesOnlyHere`. Nothing here reaches the bus or spawns anything; the verb
 * reads the store and, under --apply, unlinks under <store>/superseded/.
 *
 * WHY. drover-share-sessions never deletes: every account's projects/ was
 * moved to <store>/superseded/<account>/ and replaced with a symlink to the
 * store. That leaves ~16 GB that `du` cannot split into the half that is extra
 * hard links to the store's own inodes (frees nothing) and the half that is
 * real bytes, most of them copies of what the store already holds and a few
 * that genuinely diverged. The number that matters is the second half, and the
 * thing that must never be deleted is the few that diverged.
 *
 * NO SIZE HEURISTIC. Every parked file that is not already the store's inode
 * is compared against the store's bytes: whole-file or prefix equality first,
 * a line-set comparison when it is neither. A PREFIX COUNTS AS STORED: a
 * transcript is append-only, so a parked copy that is the first N bytes of the
 * store's file has every line it holds in the store already.
 *
 * WHAT IT WILL NOT DO. A file whose content is NOT already in the store is
 * never deleted by --apply. It is printed with how many of its lines exist
 * only there, and the only way it goes is Clay naming its path on the command
 * line. It touches nothing outside <store>/superseded/.
 *
 * DROVER_SHARED_STORE names the store (default ~/.claude-shared), read from
 * the environment as the shell read it; etc/drover.env does not set it.
 *
 * Usage:
 *   drover sessions reclaim                  what would go, and what would stay
 *   drover sessions reclaim --apply          delete the redundant copies
 *   drover sessions reclaim --apply <path>…  ... and these named files too
 */

import {
    closeSync,
    lstatSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    realpathSync,
    rmdirSync,
    statSync,
    unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = `drover sessions reclaim — the disk the session-store merge parked, and what it
would really cost to get it back.

USAGE
  drover sessions reclaim                  report only; nothing is deleted
  drover sessions reclaim --apply          delete the redundant copies
  drover sessions reclaim --apply <path>…  ... and these named files too

WHAT IT DELETES
  Only files under <store>/superseded/, and only ones whose content the store
  already holds — an extra hard link to the store's own inode, or a separate
  copy proved identical (or a prefix of it) by reading both sides.

WHAT IT NEVER DELETES
  A parked file holding lines no store file has. Those are printed with the
  count of lines only they carry. Naming the path is the only way one goes,
  and that is deliberate: it is conversation history.

The report counts the bytes that would REALLY be freed. An inode is counted
once, and only when every link to it is going, so the parked hard links that
cost no space are reported as costing no space.

See also: libexec/drover-share-sessions — the merge that parked all this.
`;

const PREFIX = 'drover sessions reclaim';

/** One regular file as the scan saw it: `stat -f '%i%t%z%t%l%t%N'`. */
interface Seen {
    ino: string;
    size: number;
    links: number;
    path: string;
}

type Op = 'LINKED' | 'ORPHAN' | 'CHECK' | 'COPY' | 'DIVERGED';

/** One row of the shell's verdicts file. `only` is the DIVERGED line count. */
export interface Verdict {
    op: Op;
    size: number;
    ino: string;
    links: number;
    only: number;
    path: string;
    /** The store side of a CHECK; the shell kept it in a parallel file. */
    store?: string;
}

function say(lines: string[]): void {
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

function complain(lines: string[]): void {
    process.stderr.write(lines.join('\n') + '\n');
}

/**
 * `find <dir> -type f`, as find walks it: regular files only, symlinks
 * neither followed nor listed, directories it cannot read skipped. Sorted so
 * the report is the same run to run, which find never promised.
 */
function walkFiles(dir: string, out: Seen[]): void {
    let names: string[];
    try {
        names = readdirSync(dir).sort();
    } catch {
        return;
    }
    for (const name of names) {
        const p = join(dir, name);
        let st;
        try {
            st = lstatSync(p, { bigint: true });
        } catch {
            continue;
        }
        if (st.isDirectory()) walkFiles(p, out);
        else if (st.isFile()) out.push({ ino: String(st.ino), size: Number(st.size), links: Number(st.nlink), path: p });
    }
}

/** `find <dir> -type d | wc -l`: the directory itself plus every one under it. */
function countDirs(dir: string): number {
    let st;
    try {
        st = lstatSync(dir);
    } catch {
        return 0;
    }
    if (!st.isDirectory()) return 0;
    let n = 1;
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return n;
    }
    for (const name of names) n += countDirs(join(dir, name));
    return n;
}

/**
 * `find <dir> -depth -type d -empty -exec rmdir {} \;`: children first, so a
 * parent is reconsidered once its children are gone, and a directory still
 * holding a unique copy survives with it.
 */
function pruneEmpty(dir: string): void {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names) {
        const p = join(dir, name);
        let st;
        try {
            st = lstatSync(p);
        } catch {
            continue;
        }
        if (st.isDirectory()) pruneEmpty(p);
    }
    try {
        if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
        // Not empty after all, or already gone: either way it stays as it is.
    }
}

/**
 * The store key of a parked path, relative to superseded/:
 * `<account>/<subdir>/<rest>` → `<subdir>/<rest>`. The subdir is normally
 * `projects`; the merge appends a timestamp or a counter when it has to park
 * one account twice in a single run, and that suffix is not part of the key.
 * Empty when the path is too shallow to have one.
 */
export function storeKey(rel: string): string {
    const s1 = rel.indexOf('/');
    if (s1 < 0) return '';
    const tail = rel.slice(s1 + 1);
    const s2 = tail.indexOf('/');
    if (s2 < 0) return '';
    let sd = tail.slice(0, s2);
    if (/\.[0-9]{8}T[0-9]{6}$/.test(sd)) sd = sd.replace(/\.[0-9]+T[0-9]+$/, '');
    else if (/\.[0-9]+$/.test(sd)) sd = sd.replace(/\.[0-9]+$/, '');
    return `${sd}/${tail.slice(s2 + 1)}`;
}

/** Bytes, said the way a human checks them against `df` (the shell's awk). */
export function human(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let b = bytes;
    let i = 0;
    while (b >= 1024 && i < 4) {
        b /= 1024;
        i++;
    }
    return i === 0 ? `${Math.trunc(b)} B` : `${b.toFixed(2)} ${units[i]}`;
}

/**
 * `cmp -s -n <size> <parked> <store>`: the parked file's bytes are the first
 * <size> bytes of the store's file. Reads both sides in blocks; a store file
 * that ends first is a difference, exactly as cmp reports EOF.
 */
function sharesPrefix(parked: string, size: number, store: string): boolean {
    const block = 1 << 20;
    let fa = -1;
    let fb = -1;
    try {
        fa = openSync(parked, 'r');
        fb = openSync(store, 'r');
        const ba = Buffer.allocUnsafe(block);
        const bb = Buffer.allocUnsafe(block);
        let left = size;
        while (left > 0) {
            const want = Math.min(block, left);
            const na = readSync(fa, ba, 0, want, null);
            const nb = readSync(fb, bb, 0, want, null);
            if (na === 0 && nb === 0) return true;
            if (na !== nb) return false;
            if (!ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
            left -= na;
        }
        return true;
    } catch {
        return false;
    } finally {
        if (fa >= 0) closeSync(fa);
        if (fb >= 0) closeSync(fb);
    }
}

/** The lines of a file as `sort -u` would see them: bytes, one per newline. */
function lineSet(path: string): Set<string> {
    const text = readFileSync(path).toString('latin1');
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return new Set(lines);
}

/**
 * `comm -13 <(sort -u store) <(sort -u parked) | wc -l`: how many distinct
 * lines the parked copy holds that exist nowhere in the store's. Sets, not a
 * diff: what matters is whether a line exists anywhere in the store's copy,
 * not whether it sits at the same offset.
 */
export function linesOnlyHere(parked: string, store: string): number {
    const have = lineSet(store);
    let only = 0;
    for (const line of lineSet(parked)) if (!have.has(line)) only++;
    return only;
}

/**
 * The decide pass, pure: LINKED when the parked file IS a store inode, ORPHAN
 * when no store file sits at its key, CHECK when a different inode does.
 */
export function decide(storeFiles: Seen[], parkedFiles: Seen[], store: string, parked: string): Verdict[] {
    const storePath = new Map<string, string>();
    const inStore = new Set<string>();
    for (const f of storeFiles) {
        storePath.set(f.path.slice(store.length + 1), f.path);
        inStore.add(f.ino);
    }
    const out: Verdict[] = [];
    for (const f of parkedFiles) {
        const key = storeKey(f.path.slice(parked.length + 1));
        const row: Verdict = { op: 'ORPHAN', size: f.size, ino: f.ino, links: f.links, only: 0, path: f.path };
        if (inStore.has(f.ino)) row.op = 'LINKED';
        else if (key !== '' && storePath.has(key)) {
            row.op = 'CHECK';
            row.store = storePath.get(key);
        }
        out.push(row);
    }
    return out;
}

/** The compare pass: every CHECK becomes COPY or DIVERGED by reading both sides. */
function compare(verdicts: Verdict[]): void {
    const checks = verdicts.filter((v) => v.op === 'CHECK').length;
    const tty = process.stderr.isTTY === true;
    let seen = 0;
    for (const v of verdicts) {
        if (v.op !== 'CHECK') continue;
        seen++;
        if (tty && seen % 200 === 0) {
            process.stderr.write(`\r  compared ${seen} of ${checks} parked copies against the store`);
        }
        const store = v.store as string;
        if (sharesPrefix(v.path, v.size, store)) {
            v.op = 'COPY';
            continue;
        }
        const only = linesOnlyHere(v.path, store);
        if (only === 0) v.op = 'COPY';
        else {
            v.op = 'DIVERGED';
            v.only = only;
        }
    }
    if (tty && checks > 0) process.stderr.write('\r' + ' '.repeat(62) + '\r');
}

/**
 * Exactly the paths --apply would unlink, computed ONCE and then both reported
 * and executed from: LINKED and COPY, plus anything named on the command line.
 * A named file the scan never saw (created since) is appended, so naming one
 * still works.
 */
export function toGo(verdicts: Verdict[], names: string[]): string[] {
    const named = new Set(names);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of verdicts) {
        if (v.op === 'LINKED' || v.op === 'COPY' || named.has(v.path)) {
            out.push(v.path);
            seen.add(v.path);
        }
    }
    for (const n of names) if (!seen.has(n)) out.push(n);
    return out;
}

/**
 * The bytes that would REALLY be freed: per INODE, not per file, and an inode
 * only counts when every link to it is going.
 */
export function freedBytes(verdicts: Verdict[], going: string[]): number {
    const go = new Set(going);
    const n = new Map<string, number>();
    const size = new Map<string, number>();
    const links = new Map<string, number>();
    for (const v of verdicts) {
        if (!go.has(v.path)) continue;
        n.set(v.ino, (n.get(v.ino) ?? 0) + 1);
        size.set(v.ino, v.size);
        links.set(v.ino, v.links);
    }
    let total = 0;
    for (const [ino, count] of n) if (count >= (links.get(ino) ?? 0)) total += size.get(ino) ?? 0;
    return total;
}

/** Sum of sizes over distinct inodes, optionally only rows of one op. */
function inodeBytes(verdicts: Verdict[], op?: Op): number {
    const s = new Map<string, number>();
    for (const v of verdicts) if (!op || v.op === op) s.set(v.ino, v.size);
    let t = 0;
    for (const b of s.values()) t += b;
    return t;
}

interface Parsed {
    apply: boolean;
    names: string[];
}

/**
 * The argument loop, in the shell's order. Naming a path is the ONLY way a
 * unique copy is deleted, so it is resolved and fenced here, before anything
 * else runs: refusing a typo loudly beats deleting whatever it happened to
 * name. `--help` before any path answers without touching the disk.
 */
function parse(args: string[], parked: () => string): Parsed | { code: number } {
    const p: Parsed = { apply: false, names: [] };
    for (const a of args) {
        if (a === '--apply') {
            p.apply = true;
            continue;
        }
        if (a === '-h' || a === '--help') {
            process.stdout.write(USAGE);
            return { code: 0 };
        }
        if (a.startsWith('-')) {
            complain([`${PREFIX}: unknown argument '${a}' (try --apply or --help)`]);
            return { code: 2 };
        }
        let real: string;
        try {
            real = realpathSync(a);
        } catch {
            complain([`${PREFIX}: no such file: ${a}`]);
            return { code: 2 };
        }
        const fence = parked();
        if (!real.startsWith(fence + '/')) {
            complain([
                `${PREFIX}: ${a} is not under ${fence}`,
                '  Only parked copies can be named; the store\'s own files are never touched.',
            ]);
            return { code: 2 };
        }
        let st;
        try {
            st = statSync(real);
        } catch {
            st = null;
        }
        if (!st || !st.isFile()) {
            complain([`${PREFIX}: not a regular file: ${a}`]);
            return { code: 2 };
        }
        p.names.push(real);
    }
    return p;
}

export async function run(args: string[]): Promise<number> {
    // Canonical on BOTH sides of the fence: a named path is resolved with
    // realpath, and on macOS that turns /var into /private/var, so an
    // uncanonicalised store refused every named file under a temp dir.
    let store = process.env.DROVER_SHARED_STORE || join(homedir(), '.claude-shared');
    let canonical = false;
    const canon = (): string => {
        if (!canonical) {
            canonical = true;
            try {
                if (statSync(store).isDirectory()) store = realpathSync(store);
            } catch {
                // No store yet: the fence is the uncanonical path, as in the shell.
            }
        }
        return store;
    };
    const parkedDir = (): string => join(canon(), 'superseded');

    const parsed = parse(args, parkedDir);
    if ('code' in parsed) return parsed.code;
    const parked = parkedDir();

    let parkedStat;
    try {
        parkedStat = statSync(parked);
    } catch {
        parkedStat = null;
    }
    if (!parkedStat || !parkedStat.isDirectory()) {
        say([`store: ${store}`, 'nothing is parked under superseded/ — there is nothing to reclaim.']);
        return 0;
    }

    // ---------------------------------------------------------- scan (read)
    // Everything the store holds EXCEPT the parked tree. Walking the top
    // level rather than naming `projects` means a second shared dir added
    // later is covered without editing this.
    const storeFiles: Seen[] = [];
    let top: string[] = [];
    try {
        top = readdirSync(store).sort();
    } catch {
        top = [];
    }
    for (const name of top) {
        const d = join(store, name);
        if (d === parked) continue;
        let st;
        try {
            st = lstatSync(d);
        } catch {
            continue;
        }
        if (st.isDirectory()) walkFiles(d, storeFiles);
    }
    const parkedFiles: Seen[] = [];
    walkFiles(parked, parkedFiles);

    if (parkedFiles.length === 0) {
        say([`store: ${store}`, 'superseded/ holds no files — there is nothing to reclaim.']);
        return 0;
    }

    // --------------------------------------------------------- decide (pure)
    const verdicts = decide(storeFiles, parkedFiles, store, parked);

    // -------------------------------------------------------- compare (read)
    compare(verdicts);

    // -------------------------------------------------------------- account
    const going = toGo(verdicts, parsed.names);
    const freed = freedBytes(verdicts, going);
    const count = (op: Op): number => verdicts.filter((v) => v.op === op).length;
    const nLinked = count('LINKED');
    const nCopy = count('COPY');
    const nKeep = count('ORPHAN') + count('DIVERGED');
    const nNamed = parsed.names.length;
    const nGoing = going.length;

    const lines: string[] = [];
    if (!parsed.apply) lines.push('DRY RUN — nothing will be deleted. Re-run with --apply to reclaim.');
    lines.push(
        `store: ${store}`,
        '',
        `parked under superseded/: ${parkedFiles.length} files, ${human(inodeBytes(verdicts))}`,
        `  ${nLinked} extra hard links to the store — deleting them frees nothing (${human(inodeBytes(verdicts, 'LINKED'))})`,
        `  ${nCopy} separate copies whose content the store already holds`,
        `  ${nKeep} hold lines no store file has`,
        '',
    );
    if (nKeep > 0) {
        lines.push(
            'NOT IN THE STORE — the only copy of what is in them. --apply never',
            'deletes these; name the path to delete one anyway:',
        );
        for (const v of verdicts) {
            if (v.op === 'DIVERGED') lines.push(`  ${v.only} lines only here  ${v.path}`);
            else if (v.op === 'ORPHAN') lines.push(`  no store copy at all  ${v.path}`);
        }
        lines.push('');
    }
    if (nNamed > 0) {
        lines.push('NAMED on the command line — these go too, whatever they hold:');
        for (const n of parsed.names) lines.push(`  ${n}`);
        lines.push('');
    }
    if (nGoing === 0) {
        lines.push('nothing to reclaim — every parked file left holds lines the store does not.');
        say(lines);
        return 0;
    }
    if (!parsed.apply) {
        lines.push(`would delete ${nGoing} · would free ${human(freed)} · would keep ${nKeep}`, 'DRY RUN — nothing was deleted.');
        say(lines);
        return 0;
    }
    say(lines);

    // ---------------------------------------------------------------- apply
    // One unlink per file and no recursion: a recursive delete of a parked
    // directory would take the unique copies inside it along with the
    // redundant ones, which is the exact outcome this command exists to
    // prevent. `rm -f`: a file already gone is not an error.
    let deleted = 0;
    for (const p of going) {
        try {
            unlinkSync(p);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        deleted++;
    }
    const before = countDirs(parked);
    pruneEmpty(parked);
    const after = countDirs(parked);

    const tail = [`deleted ${deleted} · freed ${human(freed)} · kept ${nKeep} · pruned ${before - after} empty directories`];
    if (after === 0) tail.push('superseded/ is gone: everything it held is in the store.');
    say(tail);
    return 0;
}
