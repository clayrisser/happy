/**
 * How drover edits a file it does NOT own (DROVE-306), in node (DROVE-315).
 *
 * The node twin of cattle-drover/lib/drover-config-block.sh. That file's own
 * header says why it exists and this one does not repeat it; what matters here
 * is that the four constants below are a WIRE FORMAT. A shell install has
 * already written `# >>> drover >>>` into real tmux configs on real machines.
 * An implementation that spells the markers, the backup suffix or the stamp
 * differently cannot find, rewrite or remove any of them — so those four are
 * transcribed, not reinterpreted, and cattle-drover/tests/config.bats asserts
 * the shell's values while config.test.ts asserts these.
 *
 * THE CONTRACT, unchanged by the port:
 *
 *   1. MARKED BLOCKS. Everything drover writes lives between the two markers,
 *      exact text, whole line. A rewrite replaces what is between them; an
 *      uninstall removes exactly that span and nothing else.
 *
 *   2. BACKUP BEFORE THE FIRST WRITE, once, to a stamped path under
 *      $STATE_DIR/backups. One per target file for the life of the machine.
 *
 *   3. IDEMPOTENT AND CONVERGENT. A second run changes nothing; a changed body
 *      is rewritten in place rather than appended beside.
 *
 *   4. CREATING IS NOT APPENDING. Both are allowed, and the caller must be
 *      able to say which one happened.
 *
 *   5. REFUSE RATHER THAN GUESS. A BEGIN with no END, or two BEGINs, is
 *      reported and left alone.
 *
 * PORTABILITY was the shell's problem and is not this file's — node has no
 * `sed -i` to spell two ways — but the SHAPE is kept: every rewrite composes
 * the new file whole and renames it into place, which is what leaves the
 * original exactly as it was when a write fails, and what writes THROUGH a
 * symlinked dotfile instead of replacing the link with a regular file.
 */

import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// --- THE CONTRACT AS DATA (read this first if you are porting it again) ------
//
// Named constants rather than literals buried in a matcher, for the same
// reason the shell named them: the port is a transcription and not an
// interpretation, and the tests assert these values rather than the code that
// uses them.
export const droverBlockBegin = '# >>> drover >>>';
export const droverBlockEnd = '# <<< drover <<<';
export const droverConfigBackupSuffix = '.bak';
/** The UTC stamp, as date(1) spells it. `stampNow` is the node rendering. */
export const droverConfigBackupStamp = '+%Y%m%dT%H%M%SZ';

export type Env = Record<string, string | undefined>;

/** Where this reader gets $HOME and $STATE_DIR from. */
export interface ConfigCtx {
    env: Env;
    home: string;
}

export function configCtx(env: Env = process.env, home?: string): ConfigCtx {
    return { env, home: home ?? env.HOME ?? homedir() };
}

/**
 * `date -u '+%Y%m%dT%H%M%SZ'`, in node. Written out rather than reached for
 * through a formatter so the two spellings cannot drift: a backup filed by the
 * shell and one filed here have to sort into the same sequence.
 */
export function stampNow(now: Date = new Date()): string {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
        + `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

/**
 * The real file behind a symlink.
 *
 * A dotfile is very often a link into a dotfiles repo (~/.tmux.conf ->
 * ~/dotfiles/tmux.conf). Renaming onto the link REPLACES THE LINK with a
 * regular file, which silently detaches the user from their own repo —
 * precisely the "trashed a config I did not create" this contract prevents. So
 * every write resolves first and edits the file the link points at. Bounded,
 * because a symlink cycle is a thing that exists.
 */
export function droverConfigResolve(path: string): string {
    let p = path;
    for (let i = 0; i < 16; i++) {
        let link: string;
        try {
            if (!lstatSync(p).isSymbolicLink()) break;
            link = readlinkSync(p);
        } catch {
            break;
        }
        if (!link) break;
        p = link.startsWith('/') ? link : join(dirname(p), link);
    }
    return p;
}

/**
 * Where the pre-drover copies live.
 *
 * SCOPED TO THE HOME THE CONFIG BELONGS TO, and that is not fussiness.
 * STATE_DIR is EXPORTED into every shell drover starts, so it is inherited by
 * anything run from inside a session — a test suite included. A run that fakes
 * HOME and does not also fake STATE_DIR would otherwise file its fixtures'
 * backups in the REAL state dir, one more on every run, forever. So an
 * inherited STATE_DIR pointing outside the CURRENT $HOME is not this home's
 * state dir and is ignored; DROVER_CONFIG_BACKUP_DIR is the explicit escape
 * hatch and is never second-guessed.
 *
 * The XDG fallback here is NOT the DROVE-309 question. It is the shell's own
 * `${XDG_STATE_HOME:-$HOME/.local/state}` inside this one function, reached
 * only when an inherited STATE_DIR has been discarded, and it is transcribed
 * so a backup filed by the shell and one filed here land in the same place.
 */
export function droverConfigBackupDir(ctx: ConfigCtx = configCtx()): string {
    const { env, home } = ctx;
    if (env.DROVER_CONFIG_BACKUP_DIR) return env.DROVER_CONFIG_BACKUP_DIR;
    const underHome = (p: string | undefined): boolean => !!p && (p === home || p.startsWith(`${home}/`));

    let s = env.STATE_DIR;
    if (!underHome(s)) s = undefined;
    if (!s) {
        let base = env.XDG_STATE_HOME || join(home, '.local', 'state');
        if (!underHome(base)) base = join(home, '.local', 'state');
        s = join(base, 'cattle-drover');
    }
    return join(s, 'backups');
}

/**
 * The flattened basename a backup of <path> is filed under. Flattened rather
 * than nested because two files called tmux.conf in different directories must
 * not land on one name, and `ls` on the backups dir should say which file each
 * copy came from without opening it.
 */
export function droverConfigBackupName(path: string): string {
    return path.replace(/^\//, '').split('/').join('-');
}

/** True when a backup of <path> already exists. */
export function droverConfigBackedUp(path: string, ctx: ConfigCtx = configCtx()): boolean {
    const dir = droverConfigBackupDir(ctx);
    const name = droverConfigBackupName(path);
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return false;
    }
    return entries.some((e) => e.startsWith(`${name}.`) && e.endsWith(droverConfigBackupSuffix));
}

export class ConfigRefusal extends Error {
    constructor(readonly lines: string[]) {
        super(lines[0] ?? 'drover: refused');
        this.name = 'ConfigRefusal';
    }
}

/**
 * Copy <path> aside ONCE, before drover's first write to it. Returns the
 * backup path when it made one and null when it did not. Throws a
 * ConfigRefusal when it wanted to make one and could not, which is a refusal
 * to proceed rather than a warning: a write with no way back is the thing
 * being outlawed.
 *
 * The copy carries the original's mode, because ~/.claude.json is 0600 and a
 * world-readable backup of a private file is a new problem in place of an old
 * one.
 */
export function droverConfigBackup(
    path: string,
    ctx: ConfigCtx = configCtx(),
    now: Date = new Date(),
): string | null {
    if (!isFile(path)) return null;
    // DROVER'S OWN FILES ARE NOT SOMEBODY'S CONFIG. accounts.json lives in the
    // checkout and the ledgers and stamps live in the state dir; drover made
    // all of them, so a copy under "what did this look like before drover
    // touched it" answers a question nobody asked and makes the backups
    // listing lie about what drover has edited.
    const own = [ctx.env.DROVER_DIR, ctx.env.STATE_DIR];
    for (const root of own) {
        if (root && path.startsWith(`${root}/`)) return null;
    }
    if (droverConfigBackedUp(path, ctx)) return null;

    const dir = droverConfigBackupDir(ctx);
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        throw new ConfigRefusal([`drover: cannot create ${dir} — refusing to edit ${path} without a backup`]);
    }
    let out = join(dir, `${droverConfigBackupName(path)}.${stampNow(now)}${droverConfigBackupSuffix}`);
    for (let n = 1; existsSync(out) && n < 100; n++) {
        out = `${out.slice(0, -droverConfigBackupSuffix.length)}-${n}${droverConfigBackupSuffix}`;
    }
    try {
        copyFileSync(path, out);
        const st = statSync(path);
        chmodSync(out, st.mode & 0o7777);
        utimesSync(out, st.atime, st.mtime);
    } catch {
        throw new ConfigRefusal([`drover: could not back ${path} up to ${out} — refusing to edit it`]);
    }
    return out;
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function readLines(path: string): string[] {
    const text = readFileSync(path, 'utf8');
    // A trailing newline terminates the last line rather than starting an
    // empty one — the same thing awk sees.
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

export type BlockState = 'absent' | 'present' | 'malformed';

/**
 * absent | present | malformed.
 *
 * `malformed` is a first-class answer rather than an error, because the caller
 * has to be able to tell "there is nothing of mine here" from "there is
 * something of mine here and I cannot safely touch it".
 */
export function droverBlockState(path: string): BlockState {
    if (!isFile(path)) return 'absent';
    let lines: string[];
    try {
        lines = readLines(path);
    } catch {
        return 'malformed';
    }
    let open = false;
    let bad = false;
    let nb = 0;
    let ne = 0;
    for (const line of lines) {
        if (line === droverBlockBegin) {
            if (open) bad = true;
            open = true;
            nb++;
        } else if (line === droverBlockEnd) {
            if (!open) bad = true;
            open = false;
            ne++;
        }
    }
    if (bad || open || nb !== ne || nb > 1) return 'malformed';
    return nb === 1 ? 'present' : 'absent';
}

/**
 * What is currently between the markers, without them. Empty when there is no
 * block. Answers "is this already what we would write" without rewriting the
 * file to find out.
 */
export function droverBlockBody(path: string): string[] {
    if (!isFile(path)) return [];
    let lines: string[];
    try {
        lines = readLines(path);
    } catch {
        return [];
    }
    const out: string[] = [];
    let inside = false;
    for (const line of lines) {
        if (line === droverBlockBegin) {
            inside = true;
            continue;
        }
        if (line === droverBlockEnd) {
            inside = false;
            continue;
        }
        if (inside) out.push(line);
    }
    return out;
}

/**
 * Swap the whole file. The temp file lives beside the target so the rename
 * stays inside one filesystem, and it inherits the target's mode when there is
 * one: a rename that widens a private file is a security bug wearing an
 * atomicity costume.
 */
export function droverConfigReplace(target: string, content: string): void {
    const dir = dirname(target);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.drover-config-${process.pid}.tmp`);
    let mode: number | undefined;
    try {
        mode = statSync(target).mode & 0o7777;
    } catch {
        mode = undefined;
    }
    try {
        writeFileSync(tmp, content);
        if (mode !== undefined) chmodSync(tmp, mode);
        renameSync(tmp, target);
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            // The temp file is the only thing left to clean, and failing to
            // clean it must not mask the write's own error.
        }
        throw e;
    }
}

/** The marked block, alone, as text with a trailing newline. */
export function droverBlockRender(body: string[]): string {
    return [droverBlockBegin, ...body, droverBlockEnd].join('\n') + '\n';
}

export type InstallDid = 'created' | 'appended' | 'rewrote' | 'unchanged';

export interface InstallResult {
    did: InstallDid;
    /** The backup this call made, or null when it made none. */
    backup: string | null;
}

/**
 * Converge the marked block.
 *
 *   created    the file did not exist; it does now, and holds only the block
 *   appended   the file existed and had no drover block; it has one now
 *   rewrote    the block was there and its content has changed
 *   unchanged  the block was there and already says exactly this
 *
 * Throws a ConfigRefusal when the file is malformed or the backup could not be
 * taken. The file is untouched on every failing path.
 */
export function droverBlockInstall(
    file: string,
    body: string[],
    ctx: ConfigCtx = configCtx(),
    now: Date = new Date(),
): InstallResult {
    const path = droverConfigResolve(file);
    const state = droverBlockState(path);

    if (state === 'malformed') {
        throw new ConfigRefusal([
            `drover: ${path} has an unbalanced drover block — refusing to touch it.`,
            `  Expected one '${droverBlockBegin}' closed by one '${droverBlockEnd}'.`,
            '  Fix the markers by hand (or delete the block) and run this again.',
        ]);
    }

    if (state === 'present' && droverBlockBody(path).join('\n') === body.join('\n')) {
        return { did: 'unchanged', backup: null };
    }

    const block = droverBlockRender(body);

    // The backup is taken before ANY of the writing paths below, and a failure
    // to take it stops the write. Nothing is copied when the file does not
    // exist yet: there are no bytes to get back to, and `created` says so.
    const backup = droverConfigBackup(path, ctx, now);

    let did: InstallDid;
    let next: string;
    if (state === 'present') {
        did = 'rewrote';
        const lines = readLines(path);
        const out: string[] = [];
        let skip = false;
        for (const line of lines) {
            if (!skip && line === droverBlockBegin) {
                out.push(...block.replace(/\n$/, '').split('\n'));
                skip = true;
                continue;
            }
            if (skip) {
                if (line === droverBlockEnd) skip = false;
                continue;
            }
            out.push(line);
        }
        next = out.length ? out.join('\n') + '\n' : '';
    } else if (!isFile(path) || readFileSync(path).length === 0) {
        // An existing but EMPTY file counts as created rather than appended:
        // there is nothing above the block to have been separated from, and
        // saying "appended" about a file with no content in it is a lie the
        // reader would have to go and check.
        did = 'created';
        next = block;
    } else {
        did = 'appended';
        // One blank line between the user's last line and our first, so the
        // block reads as a block. Removal drops exactly that one blank line
        // again, which is what makes install-then-uninstall byte-identical.
        //
        // THE ONE EXCEPTION, stated rather than hidden: a config whose last
        // line has no newline terminator gains one, because a marker has to
        // start at column 0 of its own line. Uninstall cannot know to take it
        // away again, so such a file comes back one byte longer. The backup is
        // the way back to the exact original.
        const existing = readFileSync(path, 'utf8');
        next = existing + (existing.endsWith('\n') ? '' : '\n') + '\n' + block;
    }

    droverConfigReplace(path, next);
    return { did, backup };
}

export type RemoveDid = 'removed' | 'deleted' | 'absent';

/**
 * Take the marked block back out.
 *
 *   removed    the block is gone and everything else is byte for byte as it was
 *   deleted    the file held nothing BUT the block, so the file is gone too
 *   absent     there was no drover block here
 *
 * `deleted` is the exact inverse of `created`. A file whose entire content was
 * drover's block is a file drover made, and leaving an empty tmux.conf behind
 * would be leaving litter that changes what tmux does on the next machine the
 * dotfiles are copied to.
 */
export function droverBlockRemove(file: string): RemoveDid {
    const path = droverConfigResolve(file);
    const state = droverBlockState(path);

    if (state === 'malformed') {
        throw new ConfigRefusal([
            `drover: ${path} has an unbalanced drover block — refusing to touch it.`,
            `  Remove the lines between '${droverBlockBegin}' and`,
            `  '${droverBlockEnd}' by hand; guessing at the span could take`,
            '  the rest of the file with it.',
        ]);
    }
    if (state === 'absent') return 'absent';

    // `held` carries at most one blank line so the blank that install put
    // above the block is dropped WITH the block, and a blank line the user
    // wrote two lines above it is not.
    const lines = readLines(path);
    const out: string[] = [];
    let skip = false;
    let held: string | null = null;
    for (const line of lines) {
        if (!skip && line === droverBlockBegin) {
            held = null;
            skip = true;
            continue;
        }
        if (skip) {
            if (line === droverBlockEnd) skip = false;
            continue;
        }
        if (held !== null) {
            out.push(held);
            held = null;
        }
        if (line === '') {
            held = line;
            continue;
        }
        out.push(line);
    }
    if (held !== null) out.push(held);

    const next = out.length ? out.join('\n') + '\n' : '';
    if (next.length === 0) {
        unlinkSync(path);
        return 'deleted';
    }
    droverConfigReplace(path, next);
    return 'removed';
}
