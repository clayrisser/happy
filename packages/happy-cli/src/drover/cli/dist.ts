/**
 * What the fork's dist is, and how the last build went (DROVE-315).
 *
 * The read-only half of cattle-drover/lib/drover-dist.sh, which `drover status`
 * reads to answer the question that cost an outage nothing on the screen could
 * explain: is the thing every session execs actually the code in the tree?
 *
 * That line exists because a half-finished merge took out every session AND the
 * daemon while the bus was up, the bridge was connected and the services were
 * loaded. `pnpm build` was `shx rm -rf dist && tsc --noEmit && pkgroll` — the
 * DELETE runs first — so a build that failed at tsc had already destroyed the
 * dist every session needs. Clay spent the outage believing that adding an
 * account had broken the drover.
 *
 * Only the accessors are here. The lock, the build, the floor restore and
 * dist_ensure are writers that belong with the service wrappers when those
 * port; a status screen must never take the build lock to answer a question.
 *
 * Every accessor answers "nothing" rather than throwing, for the same reason
 * the shell's do: all three callers run under `set -e`, where
 * `x=$(cmd-that-fails)` aborts the script, so a missing failure marker — the
 * NORMAL case, a healthy build — would have killed the session start the file
 * exists to protect.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `cksum` of a string, as POSIX defines it: CRC-32 over the bytes, then over
 * the length written little-endian-least-significant-byte-first, complemented.
 *
 * dist_state_dir keys the floor by the cli path so a fixture tree in the bats
 * suite can never write over the snapshot the real fork depends on, and it uses
 * cksum "because it is POSIX and every shell has it; this is a directory name,
 * not a signature". The node twin has to produce the SAME directory name, or it
 * would read a floor nobody wrote.
 */
export function cksum(text: string): number {
    const bytes = Buffer.from(text, 'utf8');
    let crc = 0;
    const step = (byte: number): void => {
        crc = ((crc << 8) >>> 0) ^ cksumTable[((crc >>> 24) ^ byte) & 0xff];
        crc = crc >>> 0;
    };
    for (const b of bytes) step(b);
    let len = bytes.length;
    while (len > 0) {
        step(len & 0xff);
        len = Math.floor(len / 256);
    }
    return (~crc) >>> 0;
}

const cksumTable: number[] = (() => {
    const table: number[] = new Array(256);
    for (let i = 0; i < 256; i++) {
        let value = i << 24;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 0x80000000) ? (((value << 1) >>> 0) ^ 0x04c11db7) : ((value << 1) >>> 0);
        }
        table[i] = value >>> 0;
    }
    return table;
})();

/** Read a file, or null. A directory, a permission error and an absent file are the same answer. */
function slurp(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

/** A file's mtime in whole seconds, the `stat -f %m || stat -c %Y` probe the whole tree runs. */
export function mtimeSeconds(path: string): number | null {
    try {
        return Math.floor(statSync(path).mtimeMs / 1000);
    } catch {
        return null;
    }
}

/**
 * `dist_state_dir <happy-cli-dir>` — where this checkout's floor lives.
 *
 * The shell reads STATE_DIR out of the environment with the pre-DROVE-309
 * fallback still spelled inline; the node twin takes the state dir it is given
 * so a test can point it at a temp tree.
 */
export function distStateDir(cliDir: string, stateDir?: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
    const root = stateDir
        ?? env.STATE_DIR
        ?? join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'cattle-drover');
    return join(root, 'build', String(cksum(cliDir)));
}

/**
 * `dist_valid <happy-cli-dir>` — true when the built entrypoint resolves.
 *
 * The check is cheap and exact: every relative import in the entrypoint must
 * resolve on disk. That is precisely what node is about to do, so a pass here
 * means node will not throw ERR_MODULE_NOT_FOUND. Unlike the shell this does
 * not print the missing chunk — `drover status` discards that stderr anyway
 * (`dist_valid "$cli" 2>/dev/null`), and a status screen is not a build log.
 */
export function distValid(cliDir: string): boolean {
    const dir = join(cliDir, 'dist');
    const entry = join(dir, 'index.mjs');
    const text = slurp(entry);
    if (text === null) return false;
    for (const line of text.split('\n')) {
        const m = line.match(/^import '\.\/([^']*)';$/);
        if (!m) continue;
        if (!existsSync(join(dir, m[1]))) return false;
    }
    return true;
}

/** The paths `find src package.json tsconfig.json` walks, as one flat list of files. */
function sourceFiles(cliDir: string): string[] {
    const out: string[] = [];
    const walk = (path: string): void => {
        let st;
        try {
            st = statSync(path);
        } catch {
            return;
        }
        if (st.isDirectory()) {
            let entries: string[];
            try {
                entries = readdirSync(path);
            } catch {
                return;
            }
            for (const e of entries) walk(join(path, e));
            return;
        }
        out.push(path);
    };
    walk(join(cliDir, 'src'));
    walk(join(cliDir, 'package.json'));
    walk(join(cliDir, 'tsconfig.json'));
    return out;
}

/** A file's mtime in milliseconds, for comparisons `-newer` makes at sub-second precision. */
function mtimeMsOf(path: string): number | null {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return null;
    }
}

/** Is any source strictly newer than `path`? The `find -newer -print -quit` question. */
function anySourceNewerThan(cliDir: string, path: string): boolean {
    const mark = mtimeMsOf(path);
    if (mark === null) return false;
    for (const f of sourceFiles(cliDir)) {
        const at = mtimeMsOf(f);
        if (at !== null && at > mark) return true;
    }
    return false;
}

/**
 * `dist_stale <happy-cli-dir>` — true when sources are newer than the
 * entrypoint. A missing entrypoint is stale, which is what `[ -f ] || return 0`
 * says.
 */
export function distStale(cliDir: string): boolean {
    const entry = join(cliDir, 'dist', 'index.mjs');
    if (!existsSync(entry)) return true;
    return anySourceNewerThan(cliDir, entry);
}

/** One `key=value` line out of a stamp file. The first match wins, as `head -1` does. */
function stampField(path: string, key: string): string {
    const text = slurp(path);
    if (text === null) return '';
    const prefix = `${key}=`;
    for (const line of text.split('\n')) {
        if (line.startsWith(prefix)) return line.slice(prefix.length);
    }
    return '';
}

/** `dist_good_field <happy-cli-dir> <key>` — one value out of the last-good stamp. */
export function distGoodField(cliDir: string, key: string, stateDir?: string): string {
    return stampField(join(distStateDir(cliDir, stateDir), 'last-good'), key);
}

/** `dist_last_build_field <happy-cli-dir> <key>` — one value out of the fork's own build record. */
export function distLastBuildField(cliDir: string, key: string): string {
    return stampField(join(cliDir, '.build', 'last'), key);
}

/** `dist_failure_reason` — the first line of the failure marker, or ''. */
export function distFailureReason(cliDir: string, stateDir?: string): string {
    const text = slurp(join(distStateDir(cliDir, stateDir), 'failed'));
    if (text === null) return '';
    return text.split('\n')[0] ?? '';
}

/** `dist_failure_files` — every line after the first, `sed -n '2,$p'`. */
export function distFailureFiles(cliDir: string, stateDir?: string): string[] {
    const text = slurp(join(distStateDir(cliDir, stateDir), 'failed'));
    if (text === null) return [];
    const lines = text.split('\n');
    // sed prints lines 2..$ of the FILE; a trailing newline makes no final line.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(1);
}

/** `dist_failure_at` — the failure marker's mtime, or null. */
export function distFailureAt(cliDir: string, stateDir?: string): number | null {
    return mtimeSeconds(join(distStateDir(cliDir, stateDir), 'failed'));
}

/**
 * `dist_failure_unchanged <happy-cli-dir>` — true when a failure is recorded
 * AND no source has moved since. Same walk as distStale, same reason it is
 * cheap: it decides whether the next start will retry the build at all.
 */
export function distFailureUnchanged(cliDir: string, stateDir?: string): boolean {
    const mark = join(distStateDir(cliDir, stateDir), 'failed');
    if (!existsSync(mark)) return false;
    return !anySourceNewerThan(cliDir, mark);
}

/** `dist_age_human <epoch>` — "14m", "2h 03m", "3d 05h". */
export function distAgeHuman(at: number, now: number = Math.floor(Date.now() / 1000)): string {
    let age = now - at;
    if (age < 0) age = 0;
    if (age < 60) return `${age}s`;
    if (age < 3600) return `${Math.floor(age / 60)}m`;
    const pad = (n: number): string => String(n).padStart(2, '0');
    if (age < 86400) return `${Math.floor(age / 3600)}h ${pad(Math.floor((age % 3600) / 60))}m`;
    return `${Math.floor(age / 86400)}d ${pad(Math.floor((age % 86400) / 3600))}h`;
}

/**
 * `fmt_epoch <seconds> '+%Y-%m-%d %H:%M'` — an epoch as a LOCAL date string
 * (DROVE-323). The shell branches on the kernel because BSD `date` reads a bare
 * integer only through `-r` and GNU reads a Unix time only through `-d @<n>`;
 * node has neither problem, and neither spelling of the bug.
 */
export function fmtEpochMinute(at: number): string {
    const d = new Date(at * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `dist_line <happy-cli-dir>` — the one-line summary `drover status` prints
 * under the daemon: what dist is on disk, and how the last build went, from the
 * record scripts/build.cjs writes on every run, including one Clay ran by hand.
 *
 * The live repro on 2026-08-31 had the screen saying only "daemon DOWN" while
 * the actual fact was "dist missing, last build failed 2 minutes ago on a test".
 */
export function distLine(cliDir: string, now: number = Math.floor(Date.now() / 1000)): string {
    const entry = join(cliDir, 'dist', 'index.mjs');
    let what: string;
    if (existsSync(entry)) {
        const at = mtimeSeconds(entry);
        what = at !== null
            ? `${fmtEpochMinute(at)} (${distAgeHuman(at, now)} ago)`
            : 'present';
    } else {
        what = 'MISSING — nothing for the daemon or the bridge to load';
    }
    const status = distLastBuildField(cliDir, 'status');
    const at = distLastBuildField(cliDir, 'at');
    const when = at ? ` ${distAgeHuman(Number(at), now)} ago` : '';
    let build: string;
    if (status === 'ok') {
        build = `ok${when}`;
    } else if (status === 'failed') {
        build = `FAILED${when} (${distLastBuildField(cliDir, 'reason')})`;
    } else {
        build = 'no record (built before scripts/build.cjs, or not by it)';
    }
    return `dist      ${what} · last build ${build}`;
}
