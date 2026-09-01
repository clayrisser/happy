/**
 * `drover share-sessions` — every account's session data in ONE place, so a
 * flip stops copying it (DROVE-40), in node (DROVE-315).
 *
 * A straight port of cattle-drover/libexec/drover-share-sessions: the same
 * plan, the same three passes, the same lines. tests/share.bats stays the spec
 * of the shell file until its arm is flipped; share-sessions.test.ts asserts
 * the same paths, inodes, counts and sentences against this one.
 *
 * WHY. `claude --resume <id>` reads the transcript from
 * $CLAUDE_CONFIG_DIR/projects/<munged-cwd>/<id>.jsonl, and a flip is precisely
 * a change of CLAUDE_CONFIG_DIR. A flip used to COPY the transcript into the
 * target account and overwrite whatever was there, on the theory that the
 * source is always the newer copy. Measured false: one session stood at 6.3M
 * under ~/.claude and 9.1M under jamrizzi at the same moment. The fix is not a
 * better copy, it is not copying: every account points at one store, and the
 * second account resumes the first's session because it is the same file.
 *
 * WHAT IS SHARED. `projects/` only: transcripts, the sibling <id>/ dirs holding
 * subagent transcripts, and memory/. NOT `.claude.json`, `settings.json`,
 * `commands/` or `plugins/` — those are what make an account an account. And
 * NOT `uploads/`: the claude binary's config-dir symlink policy table reads
 * `case "uploads": return "refuse"`, and a symlinked uploads/ breaks the
 * terminal paste path. projects/ is followed; that was proven live.
 *
 * THE PLAN AND THE APPLY ARE ONE COMPUTATION. The whole plan is computed
 * read-only and printed, and only then executed row by row, so what you
 * approve is what runs. An earlier draft decided as it walked, and with an
 * empty store nothing ever collided.
 *
 * IT RUNS WHILE SESSIONS ARE LIVE. Every account dir is on the store's
 * filesystem, and claude reopens the transcript for every append rather than
 * holding it open, so a hard link is invisible to a writer and a rename is
 * re-resolved on its next write. Three passes, per account and shared dir:
 *
 *   1. LINK. Every winner is hard-linked into the store. The account dir is
 *      untouched; a live writer keeps appending to what is now also the
 *      store's file. Losers stay where they are.
 *   2. SWAP. rename <cfg>/<sub> to <store>/superseded/<account>/<sub>, then
 *      symlink <cfg>/<sub> -> <store>/<sub>. Two syscalls; an append landing
 *      between them fails once with ENOENT and nothing is corrupted.
 *   3. CATCH UP. Walk the parked dir. A file whose store key does not exist
 *      yet was created after pass 1 scanned; link it in. A file that merely
 *      grew is the same inode and needs nothing.
 *
 * The parked dir IS the superseded copy: the winners in it are extra hard
 * links costing no space, the losers are the only real bytes. Nothing is ever
 * deleted; disk comes back only when Clay removes <store>/superseded/ himself.
 *
 * SAFETY. Dry run is the default; `--apply` is the only path that writes. On
 * a collision the LARGEST file wins the store and every other copy stays under
 * <store>/superseded/<account>/ with its path intact, so a bad merge is
 * recoverable by hand. Re-running is a no-op once linked, and an interrupted
 * run resumes: the store's own contents are scanned as one more account, and a
 * file already hard-linked is recognised by inode.
 *
 * WHAT THIS ARM DOES DIFFERENTLY, all of it at the argument line. Help answers
 * here, before a single stat: the shell had no --help (anything but --apply
 * was the usage line, exit 2), this arm keeps that exit for an unknown word
 * and answers --help/-h/help with the usage, exit 0, like the other ported
 * verbs. A stray argument after --apply is refused rather than ignored — the
 * shell looked at $1 only, and a verb that writes should not shrug at a word
 * it did not understand. Everything past the argument line — the plan, its
 * order, the counts, every sentence — is the shell's.
 */

import { spawnSync } from 'node:child_process';
import {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    renameSync,
    statSync,
    symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';

import { busGet } from './bus';
import { droverEnv, droverVar } from './env';

const USAGE = `drover share-sessions — one session store for every account, so a flip
stops copying transcripts (DROVE-40).

USAGE
  drover share-sessions            print the plan, change nothing
  drover share-sessions --apply    execute it

  DROVER_SHARED_STORE=<dir>        where the store lives (default ~/.claude-shared)

WHAT IS SHARED. projects/ only: transcripts, the sibling <id>/ dirs holding
subagent transcripts, and memory/. Not .claude.json, settings.json, commands/
or plugins/ (those are what make an account an account), and not uploads/
(claude refuses a symlinked uploads/ and the terminal paste path breaks).

HOW. The whole plan is computed read-only and printed; --apply runs that plan
and nothing else. Per account: every winner is hard-linked into the store, the
account's projects/ is parked under <store>/superseded/<account>/ and replaced
by a symlink to the store, and anything written between the scan and the swap
is linked in after. On a collision the LARGEST copy wins the store and every
other copy stays under superseded/, path intact. Nothing is ever deleted.

Safe with live sessions: claude reopens the transcript for every append, so an
append that lands inside the two-syscall swap fails once and nothing is lost.
Re-running is a no-op once every account is linked.
`;

/**
 * The directories that hold session data rather than account identity, and
 * that claude will follow through a symlink. See the header on uploads/.
 */
const SHARED_DIRS: readonly string[] = ['projects'];

/** One file the scan saw, and where it wants to live. */
export interface ScanRow {
    /** `<sub>/<rel>`: the path under the store. Two accounts holding the same session produce two rows under one key. */
    key: string;
    bytes: number;
    /** `main`, an account dir's name, or `(store)` for the store's own contents. */
    account: string;
    path: string;
    /** What tells a collision from a file an earlier, interrupted run already linked. */
    ino: bigint;
}

export type PlanRow =
    | { op: 'LINK'; from: string; to: string }
    | { op: 'KEEP'; from: string; to: string; bytes: number }
    | { op: 'EVICT'; from: string; to: string; bytes: number }
    | { op: 'SWAP'; src: string; dest: string; account: string }
    | { op: 'SHARED'; account: string; sub: string };

/** `[ -d ]`: a directory, through a symlink if it is one. */
function isDir(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** `[ -L ]`. */
function isSymlink(p: string): boolean {
    try {
        return lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

/**
 * `find <root> -type f 2>/dev/null`: regular files only, symlinks neither
 * followed nor listed, an unreadable directory skipped. Paths are `<root>/<rel>`
 * with root as given, the way find prints them.
 */
function walkFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const p = `${dir}/${e.name}`;
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) out.push(p);
        }
    };
    walk(root);
    return out;
}

/**
 * Every config dir drover knows about: main is ~/.claude, the rest live under
 * ~/.claude-accounts. Read from disk rather than accounts.json so an account
 * that exists but was never registered is not silently left behind holding the
 * only copy of something. The glob's order: dotfiles skipped, names sorted.
 */
export function configDirs(home: string): string[] {
    const dirs = [`${home}/.claude`];
    const accounts = `${home}/.claude-accounts`;
    if (!isDir(accounts)) return dirs;
    let names: string[];
    try {
        names = readdirSync(accounts);
    } catch {
        return dirs;
    }
    for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const d = `${accounts}/${name}`;
        if (isDir(d)) dirs.push(d);
    }
    return dirs;
}

export function accountName(cfg: string, home: string): string {
    return cfg === `${home}/.claude` ? 'main' : basename(cfg);
}

/**
 * One row per file under `<root>`, keyed by where it wants to live in the
 * store. One stat per file rather than a subprocess each: there are ~36k files
 * across the five accounts.
 */
export function scanDir(root: string, sub: string, account: string): ScanRow[] {
    const rows: ScanRow[] = [];
    if (!isDir(root)) return rows;
    for (const path of walkFiles(root)) {
        let st;
        try {
            st = statSync(path, { bigint: true });
        } catch {
            continue;
        }
        rows.push({
            key: `${sub}/${path.slice(root.length + 1)}`,
            bytes: Number(st.size),
            account,
            path,
            ino: st.ino,
        });
    }
    return rows;
}

function cmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Group by key, largest file wins the store, everyone else loses. A loser in
 * an account stays put and rides into <store>/superseded/<account>/ with the
 * swap, so KEEP rows are a report and nothing else. A loser already in the
 * store has to be moved aside before the winner can be linked over it, so
 * EVICT rows are real and come before their key's LINK. Ties lose too:
 * identical content is not worth trusting when the whole reason for this verb
 * is an assumption about "the newer copy" turning out to be wrong. `(store)`
 * winning means the file simply stays put, and it wins every tie: `(` sorts
 * before any account name. A row sharing the winner's inode is the same file
 * seen through a second path — an earlier run got this far — and needs
 * nothing.
 *
 * The shell's `LC_ALL=C sort -k1,1 -k2,2nr -k3,3 | awk`, row for row.
 */
export function decide(rows: readonly ScanRow[], store: string): PlanRow[] {
    const sorted = [...rows].sort(
        (a, b) => cmp(a.key, b.key) || b.bytes - a.bytes || cmp(a.account, b.account),
    );
    const plan: PlanRow[] = [];
    let last: string | null = null;
    let wino = -1n;
    let win: PlanRow | null = null;
    let evicts: PlanRow[] = [];
    const flush = (): void => {
        plan.push(...evicts);
        if (win) plan.push(win);
        evicts = [];
        win = null;
    };
    for (const r of sorted) {
        if (r.key !== last) {
            flush();
            last = r.key;
            wino = r.ino;
            win = r.account === '(store)' ? null : { op: 'LINK', from: r.path, to: `${store}/${r.key}` };
            continue;
        }
        if (r.ino === wino) continue;
        if (r.account === '(store)') {
            evicts.push({ op: 'EVICT', from: r.path, to: `${store}/superseded/store/${r.key}`, bytes: r.bytes });
        } else {
            plan.push({ op: 'KEEP', from: r.path, to: `${store}/superseded/${r.account}/${r.key}`, bytes: r.bytes });
        }
    }
    flush();
    return plan;
}

/**
 * The whole plan, read-only: LINK/KEEP/EVICT rows from the decision, then one
 * SWAP or SHARED row per account and shared dir. A missing <cfg>/<sub> still
 * gets a SWAP: the swap creates the link either way, so every account ends up
 * pointing at the store rather than growing a private dir later.
 */
export function computePlan(home: string, store: string): PlanRow[] {
    const swaps: PlanRow[] = [];
    const scan: ScanRow[] = [];
    for (const cfg of configDirs(home)) {
        const name = accountName(cfg, home);
        for (const sub of SHARED_DIRS) {
            const src = `${cfg}/${sub}`;
            // Already a symlink: this account is migrated, leave it entirely
            // alone. This is what makes a re-run a no-op rather than a re-merge.
            if (isSymlink(src)) {
                swaps.push({ op: 'SHARED', account: name, sub });
                continue;
            }
            swaps.push({ op: 'SWAP', src, dest: `${store}/${sub}`, account: name });
            scan.push(...scanDir(src, sub, name));
        }
    }
    // The store's own contents are scanned too, as the pseudo-account
    // `(store)`. Without that, a second run after a partial one would treat a
    // file already in the store as absent and evict the wrong side. Skipped
    // when every account is already linked: nothing left to decide against.
    if (swaps.some((s) => s.op === 'SWAP')) {
        for (const sub of SHARED_DIRS) scan.push(...scanDir(`${store}/${sub}`, sub, '(store)'));
    }
    return [...decide(scan, store), ...swaps];
}

interface Tally {
    links: number;
    keeps: number;
    evicts: number;
    swaps: number;
    shared: number;
}

function tally(plan: readonly PlanRow[]): Tally {
    const t: Tally = { links: 0, keeps: 0, evicts: 0, swaps: 0, shared: 0 };
    for (const r of plan) {
        if (r.op === 'LINK') t.links++;
        else if (r.op === 'KEEP') t.keeps++;
        else if (r.op === 'EVICT') t.evicts++;
        else if (r.op === 'SWAP') t.swaps++;
        else t.shared++;
    }
    return t;
}

/** `date +%Y%m%dT%H%M%S`, local time. */
function stamp(d: Date): string {
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sameFile(a: string, b: string): boolean {
    return statSync(a, { bigint: true }).ino === statSync(b, { bigint: true }).ino;
}

/**
 * Park a store file that is losing to a larger account copy. Only ever the
 * store's own side: an account's losers never move on their own, the swap
 * carries them.
 */
function evict(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
}

/**
 * Hard-link every file under the parked dir whose key the store does not have
 * yet. Those are the files created between the scan and the swap; anything
 * else is either the same inode already or a loser the plan reported. Returns
 * the number linked.
 */
function catchUp(parked: string, sub: string, store: string): number {
    let n = 0;
    for (const f of walkFiles(parked)) {
        const to = `${store}/${sub}/${f.slice(parked.length + 1)}`;
        if (existsSync(to)) continue;
        mkdirSync(dirname(to), { recursive: true });
        linkSync(f, to);
        n++;
    }
    return n;
}

/** The shell's `REFUSING:` line — printed, then exit 1, nothing else touched. */
export class ShareRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ShareRefused';
    }
}

/** Run the plan. The only writer in this file. */
export function execute(
    plan: readonly PlanRow[],
    store: string,
    now: () => Date = () => new Date(),
): { linked: number; caught: number } {
    let linked = 0;
    let caught = 0;
    let lastdir = '';
    for (const row of plan) {
        switch (row.op) {
            case 'EVICT':
                evict(row.from, row.to);
                break;
            case 'LINK': {
                // The plan is sorted by key, so directories cluster; one mkdir
                // per directory rather than one per file.
                const dir = dirname(row.to);
                if (dir !== lastdir) {
                    lastdir = dir;
                    mkdirSync(dir, { recursive: true });
                }
                if (existsSync(row.to)) {
                    // Not in the plan: a store file that appeared after the
                    // scan, from an account already on the symlink. Same inode
                    // is a no-op; a different one is a collision the plan could
                    // not see, decided the same way — the plan's winner takes
                    // the key, the newcomer is kept.
                    if (sameFile(row.from, row.to)) break;
                    evict(row.to, `${store}/superseded/store/${row.to.slice(store.length + 1)}`);
                }
                linkSync(row.from, row.to);
                linked++;
                break;
            }
            case 'SWAP': {
                const { src: a, dest: b, account: c } = row;
                mkdirSync(b, { recursive: true });
                let parked = `${store}/superseded/${c}/${basename(b)}`;
                // An earlier run parked here and died before the link. Never
                // merge into it — a rename would nest the new dir inside the
                // old one.
                if (existsSync(parked)) parked = `${parked}.${stamp(now())}`;
                mkdirSync(dirname(parked), { recursive: true });
                let tries = 0;
                while (!isSymlink(a)) {
                    if (existsSync(a)) {
                        // Every trip after the first is a writer that recreated
                        // the dir inside the window. Park that too and catch up
                        // from it.
                        tries++;
                        if (tries > 5) {
                            throw new ShareRefused(`REFUSING: ${a} keeps reappearing while being swapped. No link made.`);
                        }
                        const p = tries === 1 ? parked : `${parked}.${tries}`;
                        renameSync(a, p);
                        // Never link onto an existing directory: BSD ln would
                        // put the link INSIDE it, and the account would carry on
                        // writing to a private dir under a store name.
                        if (!existsSync(a)) symlinkSync(b, a);
                        caught += catchUp(p, basename(b), store);
                    } else {
                        symlinkSync(b, a);
                    }
                }
                break;
            }
            case 'KEEP':
            case 'SHARED':
                break;
        }
    }
    return { linked, caught };
}

/** `pgrep -f <pattern> | wc -l`; 0 when pgrep is missing or matches nothing. */
function pgrepCount(pattern: string): number {
    const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || typeof r.stdout !== 'string') return 0;
    return r.stdout.split('\n').filter((l) => l.length > 0).length;
}

/**
 * The live sessions the bus reports, one line each, in the shell's format. A
 * bus that is down, slow, or answering something that is not JSON contributes
 * nothing, as `curl -s -m 3 ... || true` did.
 */
async function liveOnBus(droverUrl: string): Promise<string[]> {
    let body: string;
    try {
        body = (await busGet('/v1/sessions', 3000, droverUrl)).body;
    } catch {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return [];
    }
    const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(sessions)) return [];
    const lines: string[] = [];
    for (const x of sessions as { id?: unknown; state?: unknown; account?: unknown; cwd?: unknown }[]) {
        if (!x || typeof x !== 'object') continue;
        if (!String(x.state || '').startsWith('live')) continue;
        lines.push(`  ${String(x.id).slice(0, 8)}  ${x.account || '-'}  ${x.state}  ${x.cwd || ''}`);
    }
    return lines;
}

export interface ShareInput {
    /** $HOME: every account dir is found under it. */
    home: string;
    /** DROVER_SHARED_STORE. */
    store: string;
    /** Write, or only print the plan. */
    apply: boolean;
    /** The bus, for the live-session warning. */
    droverUrl: string;
    /** `pgrep -f <pattern> | wc -l`. Injectable so a test does not read the host's process table. */
    countProcesses?: (pattern: string) => number;
    /** Where a line goes. stdout by default. */
    say?: (line: string) => void;
    /** The clock, for a parked dir's timestamp suffix. */
    now?: () => Date;
}

/**
 * The verb: plan, report, and — under --apply — execute. Resolves to the exit
 * code. The report is written as it is computed, so a run that fails halfway
 * through the apply has already said what it was about to do.
 */
export async function shareSessions(input: ShareInput): Promise<number> {
    const say = input.say ?? ((line: string): void => void process.stdout.write(line + '\n'));
    const count = input.countProcesses ?? pgrepCount;
    const now = input.now ?? ((): Date => new Date());
    const { home, store, apply } = input;

    const plan = computePlan(home, store);
    const t = tally(plan);

    if (!apply) say('DRY RUN — nothing will be written. Re-run with --apply to execute this plan.');
    say(`store: ${store}`);
    say('');

    if (t.keeps + t.evicts > 0) {
        say('COLLISIONS — the same file exists in more than one place. The LARGEST');
        say('wins the store; every other copy stays under superseded/, never deleted:');
        for (const row of plan) {
            if (row.op !== 'KEEP' && row.op !== 'EVICT') continue;
            say(`  ${row.bytes} bytes  ${row.from}`);
            say(`    -> ${row.to}`);
        }
        say('');
    }

    // A running session is fine: pass 1 links and the swap is two syscalls
    // (see the header). It is still worth knowing who is up, because a write
    // that lands inside the swap fails once, and if a session reports an error
    // a moment from now this is why. Three sources, because the first draft
    // had one and it matched nothing: the claude binary's process name is its
    // full path (~/.local/share/claude/versions/2.1.251), so `pgrep -x claude`
    // was always false.
    let live = '';
    let n = count('claude/versions/');
    if (n > 0) live += ` ${n} claude`;
    n = count('dist/index.mjs claude');
    if (n > 0) live += ` ${n} happy-cli`;
    const busLive = await liveOnBus(input.droverUrl);
    if (live || busLive.length > 0) {
        say('WARNING: sessions are running and are writing to files this shares.');
        say('That is supported — see the header — but an append that lands inside a');
        say('swap fails once.');
        if (live) say(`  processes:${live}`);
        if (busLive.length > 0) {
            say('  live on the bus:');
            for (const l of busLive) say(l);
        }
        say('');
    }

    if (!apply) {
        say(`would link ${t.links} · supersede ${t.keeps + t.evicts} · swap ${t.swaps} · already shared ${t.shared}`);
        say('DRY RUN — nothing was written.');
        return 0;
    }

    let done: { linked: number; caught: number };
    try {
        done = execute(plan, store, now);
    } catch (error) {
        if (error instanceof ShareRefused) {
            say(error.message);
            return 1;
        }
        throw error;
    }
    say(
        `linked ${done.linked} · superseded ${t.keeps + t.evicts} · swapped ${t.swaps} · caught up ${done.caught} · already shared ${t.shared}`,
    );
    return 0;
}

export async function run(args: string[]): Promise<number> {
    const first = args[0];
    if (first === '--help' || first === '-h' || first === 'help') {
        process.stdout.write(USAGE);
        return 0;
    }
    let apply = false;
    if (args.length === 1 && first === '--apply') {
        apply = true;
    } else if (args.length !== 0) {
        process.stderr.write('usage: drover share-sessions [--apply]\n');
        return 2;
    }

    const home = homedir();
    const store = droverVar('DROVER_SHARED_STORE', `${home}/.claude-shared`);
    try {
        return await shareSessions({ home, store, apply, droverUrl: droverEnv().droverUrl });
    } catch (error) {
        // `set -eu` in the shell: the first failed syscall ends the run, loudly.
        // The plan already printed says how far it got.
        process.stderr.write(`drover share-sessions: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}
