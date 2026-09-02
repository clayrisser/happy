/**
 * `drover trust` in node — pre-accept Claude Code's three one-time dialogs
 * (DROVE-315 wave 4, porting libexec/drover-trust).
 *
 * WHY THE VERB EXISTS, in one paragraph, because the port is worthless if the
 * next reader thinks it is a convenience. Claude Code raises three gates a
 * wrapped session can answer none of: the workspace trust dialog ("Is this a
 * project you created or one you trust?", default "No, exit"), the bypass
 * permissions disclaimer that `--dangerously-skip-permissions` itself SUMMONS
 * (also default "No, exit"), and the first-run onboarding wizard, which has no
 * default at all and simply sits on a theme picker. Each one kills or wedges a
 * session nobody is sitting at. This records the answers Clay already gave —
 * trust for a directory he just told the drover to work in, acceptance of a
 * mode the drover itself turns on, and that first-run has been seen.
 *
 * IT IS A SECURITY VERB, so two rules outrank every convenience:
 *
 *   - Nothing here is a NEW grant. Only an explicit `true` is ever read as a
 *     source, `$HOME` never enters the ledger, a directory that no longer
 *     exists is dropped, and a directory nobody has trusted stays a question
 *     on every account. Every refusal in the shell is a refusal here, with the
 *     same sentence and the same exit code.
 *   - Nothing it reads may reach the screen. The configs it walks hold OAuth
 *     accounts and API keys; the only thing this verb ever prints is a count
 *     ("...in N file(s)", behind DROVER_TRUST_VERBOSE) and the name of a
 *     configDir spelling it refused. Never a key, never a path out of a
 *     ledger, never a document.
 *
 * ONE SUBPROCESS BUDGET: ZERO. The shell file spent 41 subprocesses on a
 * steady-state run before DROVE-287 put a stamp in front of it, 29 of them jq.
 * Here jq is JSON.parse, `realpath` is fs.realpathSync, `stat` is fs.lstatSync,
 * `sort`/`awk`/`xargs` are arrays. `TrustProbe` is the seam every ps/tmux/gum
 * shell-out would sit behind if this verb had one; it has none, the module body
 * never calls it, and trust.test.ts hands in a double that THROWS to keep it
 * that way.
 *
 * --- DELIBERATE DIVERGENCES FROM THE SHELL -----------------------------------
 *
 * 1. `command -v jq || exit 0`. There is no jq here, so the bail-out has no
 *    meaning: node parses JSON itself. A machine with no jq gets the stamps
 *    from the node arm where the shell arm would have written nothing. That is
 *    strictly more of what the verb is for, and the only observable difference
 *    is on a machine that cannot run the shell arm at all.
 *
 * 2. `detect_stat_fmt` probed `stat -f` then `stat -c` with a real spawn. The
 *    answer is a property of the platform's coreutils, so it is read off
 *    process.platform instead. Same two answers, no spawn — which also takes
 *    one process off the full pass the shell always paid.
 *
 * 3. `sort -u` over the union runs under the caller's LC_COLLATE; node sorts by
 *    code unit, which is `LC_ALL=C sort`. Order never changes an ANSWER — the
 *    stamp's want/seen lines are only ever tested for membership — so the two
 *    arms agree on every write. They can differ in the ORDER of the stamp's
 *    want/seen lines under a non-C collation, and a stamp whose lines the other
 *    arm would have ordered differently is still read correctly by both.
 *
 * 4. `$me`, the script's own line in the fingerprint, is
 *    `<droverDir>/libexec/drover-trust` — the SHELL file, not this module. The
 *    two arms share one stamp ($STATE_DIR/trust.stamp) while bin/drover can
 *    still call either, so they have to fingerprint the same things: a node run
 *    that omitted the shell file would leave a stamp that survives an edit to
 *    libexec/drover-trust, which is exactly the invalidation DROVE-287 built.
 *
 * Everything else is transliterated: the same function names in camelCase, the
 * same order of operations, the same exit codes (always 0 — this verb NEVER
 * blocks a session, a dialog being better than no claude at all), and every
 * user-visible string copied rather than retold.
 */

import {
    accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync,
    readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { accountConfigFile, accountDataDir, home as homeOf, jqJson } from './account-store';
import { configCtx, droverConfigBackup, type ConfigCtx } from './configBlock';
import { droverEnv, parseLocalEnv } from './env';

export type Env = Record<string, string | undefined>;

/**
 * The seam every `ps` / `tmux` / `gum` / `launchctl` / `security` / `codesign`
 * reach would sit behind. This verb has NONE — it is filesystem and JSON — and
 * the test hands in a double that throws so a future edit that reaches for
 * Clay's real machine fails the suite instead of measuring it.
 */
export interface TrustProbe {
    spawn(command: string, args: string[]): { code: number; out: string; err: string };
}

/** The probe that would run a real process. Never called; kept so the seam is real. */
export const realTrustProbe: TrustProbe = {
    spawn() {
        throw new Error('drover trust: this verb runs no subprocess');
    },
};

export interface TrustOptions {
    env?: Env;
    home?: string;
    /** `$PWD` — what `${1-$PWD}` falls back to when no argument is given. */
    cwd?: string;
    probe?: TrustProbe;
    /** `date -u` for a backup's name. */
    now?: Date;
    out?: (s: string) => void;
    err?: (s: string) => void;
}

/** The shell's `--help` heredoc, byte for byte. */
export const helpText = `drover trust [dir] — pre-accept Claude Code's three one-time dialogs.

A wrapped session can answer none of them. The trust dialog kills the first run
in a new directory; the bypass-permissions disclaimer — which
--dangerously-skip-permissions is what raises — kills every run and loops the
launcher relaunching it; the first-run onboarding sits on a theme picker
forever, which is what a flip onto a newly added account used to land in.

This records the directory as trusted, the bypass dialog as accepted, and
first-run as settled, in the ambient config and in every account's, so a flip
does not walk back into one. Trust and onboarding land in
<configDir>/.claude.json, bypass in the account's settings.json, which is a
different directory for the ambient account.

It also MIRRORS TRUST BETWEEN ACCOUNTS (DROVE-271). Trust is recorded per
config dir, so a directory Clay answered "yes" for on one account is a fresh
question on every other, and an account added from the phone starts with an
empty ledger — its first session anywhere stops on the dialog. A directory
trusted on ANY of this machine's accounts is therefore trusted on all of them.
Only an explicit yes is copied, only for directories that still exist, and
never for $HOME. A directory nobody has trusted stays a question everywhere.
Off on its own with DROVER_TRUST_MIRROR=0.

Running it is also the repair for an account added before this existed: every
registry row is stamped on every session start, so nothing needs doing per
account.

It keeps a stamp of every file it reads and writes ($STATE_DIR/trust.stamp, or
$DROVER_TRUST_STAMP) and does nothing when none of them has moved (DROVE-287):
this runs before every session start, and the full pass — a jq per config, per
account, per settings file — cost seconds under load. On the common start it is
one stat and exit. -f / --force ignores the stamp and does the full pass now.

Off with DROVER_SKIP_PERMISSIONS=0, and off under DROVER_DRY_RUN: a run that
only says what it would do writes nothing (DROVE-322). Trust is never applied to $HOME — Claude
Code does not persist home-directory trust, so writing it there would be a lie.
The bypass stamp still happens there, because it is not per-directory.
`;

// --- the stat fingerprint ----------------------------------------------------

export type StatFmt = 'bsd' | 'gnu' | '';

/**
 * detect_stat_fmt, without the probe spawn. BSD stat speaks `-f '%N'`, GNU stat
 * speaks `-c '%n'`, and which one a machine has is decided by its platform.
 */
export function detectStatFmt(platform: string = process.platform): StatFmt {
    return platform === 'darwin' || platform.endsWith('bsd') ? 'bsd' : 'gnu';
}

/**
 * One fingerprint line for one path, in the spelling that stat(1) would have
 * printed it: BSD `%N\t%m\t%z\t%p\t%Y`, GNU `%n\t%Y\t%s\t%f\t%N`.
 *
 * lstat, not stat: BSD stat(1) without -L reads the LINK, which is why a
 * symlink's target is a field at all. Throws when the path cannot be read, so
 * the whole fingerprint fails rather than printing a line that lies.
 */
export function statLine(path: string, fmt: StatFmt): string {
    const st = lstatSync(path, { bigint: true });
    const mtime = String(st.mtimeNs / 1000000000n);
    const size = String(st.size);
    const link = st.isSymbolicLink() ? readlinkSync(path) : '';
    if (fmt === 'bsd') {
        // %p is st_mode in octal with no leading zero: 100644, 120755, 40755.
        // %Y is the link target, and empty for anything that is not a link.
        return `${path}\t${mtime}\t${size}\t${st.mode.toString(8)}\t${link}`;
    }
    // %f is the raw mode in lowercase hex; %N is the shell-quoted name, with
    // ` -> 'target'` appended for a symlink.
    const quoted = link ? `'${path}' -> '${link}'` : `'${path}'`;
    return `${path}\t${mtime}\t${size}\t${st.mode.toString(16)}\t${quoted}`;
}

/**
 * fingerprint_of — a path list in, one line per path out. `<path>\t-` when the
 * path is absent, so a config APPEARING (an account freshly installed) and one
 * VANISHING are both a changed line. The missing lines come first and the
 * present ones follow in input order, which is the order stat(1) printed them.
 *
 * Returns null when the fingerprint could not be taken at all: better a full
 * pass than a print that lies.
 */
export function fingerprintOf(paths: string[], fmt: StatFmt): string | null {
    if (!fmt) return null;
    let missing = '';
    const present: string[] = [];
    for (const p of paths) {
        if (!p) continue;
        if (pathExistsOrIsLink(p)) present.push(p);
        else missing += `${p}\t-\n`;
    }
    if (present.length === 0) return missing;
    try {
        return missing + present.map((p) => statLine(p, fmt)).join('\n') + '\n';
    } catch {
        return null;
    }
}

/** `[ -e "$p" ] || [ -L "$p" ]` — a dangling symlink is still a path that is there. */
function pathExistsOrIsLink(p: string): boolean {
    try {
        lstatSync(p);
        return true;
    } catch {
        return false;
    }
}

// --- jq, transcribed ---------------------------------------------------------

type Doc = Record<string, unknown>;

/**
 * A json document read off disk. `ok: false` is "jq could not read this file",
 * which is a different answer from a file whose whole content is `null` — jq
 * happily assigns into null, and a config that does not parse is left alone.
 */
type ReadResult = { ok: true; doc: unknown } | { ok: false };

function readDoc(path: string): ReadResult {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return { ok: false };
    }
    try {
        return { ok: true, doc: JSON.parse(text) as unknown };
    } catch {
        return { ok: false };
    }
}

/** jq's `null` is an object you can assign into; an array or a scalar is not. */
function asObject(doc: unknown): Doc | null {
    if (doc === null || doc === undefined) return {};
    if (typeof doc !== 'object' || Array.isArray(doc)) return null;
    return doc as Doc;
}

/** `X // false` — jq's alternative falls through on FALSE as well as null. */
function orFalse(v: unknown): unknown {
    return v === null || v === undefined || v === false ? false : v;
}

/** `jq -r` of one value: a string prints as itself, everything else as JSON. */
function raw(v: unknown): string {
    return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * `[.projects // {} | to_entries[] | select(.value.hasTrustDialogAccepted == true) | .key]`
 *
 * ONLY AN EXPLICIT `true` IS A SOURCE. Measured on 2.1.252: answering "No,
 * exit" writes NOTHING, so `false` on disk is the default on an entry Claude
 * Code made for another reason and never a recorded refusal. Returns null where
 * jq would have errored — a `projects` that is not an object, or an entry whose
 * value cannot be indexed — so the caller skips that file exactly as the
 * shell's per-file fallback did.
 */
export function trustedKeysOf(doc: unknown): string[] | null {
    const root = asObject(doc);
    if (!root) return null;
    const projects = orFalse(root.projects) === false ? {} : root.projects;
    if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return null;
    const keys: string[] = [];
    for (const [k, v] of Object.entries(projects as Doc)) {
        if (v === null) continue;
        if (typeof v !== 'object' || Array.isArray(v)) return null;
        if ((v as Doc).hasTrustDialogAccepted === true) keys.push(k);
    }
    return keys;
}

/**
 * The stamp's verify filter for a .claude.json that CHANGED: onboarded, still
 * holding every applied (`want`) directory, and trusting nothing outside
 * `seen`. A key outside `seen` is a human's fresh "yes" and MUST reach the
 * other accounts, so it fails this and takes the full pass.
 */
export function verifyConfig(doc: unknown, want: string[], seen: string[]): boolean {
    const root = asObject(doc);
    if (!root) return false;
    if (orFalse(root.hasCompletedOnboarding) !== true) return false;
    const trusted = trustedKeysOf(doc);
    if (trusted === null) return false;
    const t = new Set(trusted);
    const s = new Set(seen);
    return want.every((d) => t.has(d)) && trusted.every((d) => s.has(d));
}

// --- the verb ----------------------------------------------------------------

export async function run(args: string[], opts: TrustOptions = {}): Promise<number> {
    // 1. --help answers FIRST, before any env read, file read or subprocess.
    //    cattle-drover's tests/libexec-loadtime.bats treats anything else as a
    //    load-time side effect.
    const first = args[0] ?? '';
    if (first === '-h' || first === '--help') {
        (opts.out ?? ((s) => void process.stdout.write(s)))(helpText);
        return 0;
    }

    const env = opts.env ?? process.env;
    const err = opts.err ?? ((s: string) => void process.stderr.write(s));
    const home = opts.home ?? homeOf(env as NodeJS.ProcessEnv);
    const cwd = opts.cwd ?? process.cwd();

    // 2. -f sits AFTER --help and BEFORE the dir argument, so `drover trust -f ""`
    //    still means "no project".
    let rest = args;
    let force = false;
    if (rest[0] === '-f' || rest[0] === '--force') {
        force = true;
        rest = rest.slice(1);
    }

    const de = droverEnv(env, home);
    // The four switches the shell reads straight off the environment after
    // sourcing etc/drover.env — so local.env can set them too. Read through ONE
    // overlay rather than four droverVar() calls, which would re-read local.env
    // four times on a path whose whole point is that it is cheap.
    const local: Record<string, string> = {};
    const localFile = join(de.stateDir, 'local.env');
    if (existsSync(localFile)) {
        try {
            Object.assign(local, parseLocalEnv(readFileSync(localFile, 'utf8')));
        } catch {
            // Unreadable is the same as absent, which is what `[ -r ]` says too.
        }
    }
    // `${NAME:-default}`, so an EMPTY value falls back the way the shell's does.
    // `DROVER_TRUST_MIRROR=` is the shell saying "leave it at 1", and a reader
    // that took the empty string literally would silently turn the mirror off.
    const pick = (name: string, fallback: string): string => {
        const v = local[name] ?? env[name] ?? '';
        return v === '' ? fallback : v;
    };
    /** `[ -n "${NAME:-}" ]` — set AND not empty. */
    const set = (name: string): boolean => (local[name] ?? env[name] ?? '') !== '';

    // 3. A DRY RUN WRITES NOTHING (DROVE-322). bin/drover calls this on the
    //    session-start path BEFORE the guard that stops a dry run from launching
    //    the CLI, and proving dispatch is what DROVER_DRY_RUN is FOR — so the
    //    whole bats suite would otherwise stamp every real config on the way past.
    if (set('DROVER_DRY_RUN')) return 0;
    if (de.skipPermissions !== '1') return 0;
    // `command -v jq >/dev/null || exit 0` has no node twin. See the header.

    // 4. `${1-$PWD}` and not `${1:-$PWD}`: an EXPLICITLY EMPTY first argument
    //    means "no project", and it is how `drover account login` asks for the
    //    account-level stamps alone. Omitting it still means $PWD.
    const dir = rest.length > 0 ? rest[0] : cwd;
    // Claude keys the entry on the RESOLVED path: on macOS /tmp is a symlink,
    // and a session started in /tmp/x is recorded under /private/tmp/x.
    let trustDir = '';
    if (isDir(dir)) {
        try {
            trustDir = realpathSync(dir);
        } catch {
            trustDir = '';
        }
    }

    // Claude Code refuses to persist trust for the home directory itself, so
    // writing the key there would look like it worked and change nothing. Only
    // the TRUST stamp drops out — the bypass dialog is not per-directory.
    //
    // $HOME is resolved before the comparison because $dir already was; on a
    // home behind a symlink a raw comparison misses and stamps an entry nothing
    // reads. Resolved only when there is a directory to compare, because the
    // fast path below is counted in single spawns.
    let homeReal = '';
    if (trustDir) {
        homeReal = tryRealpath(home);
        if (trustDir === homeReal || trustDir === home) trustDir = '';
    }

    const ctx: ConfigCtx = configCtx(env, home);
    const trustStamp = pick('DROVER_TRUST_STAMP', join(de.stateDir, 'trust.stamp'));
    const mirrorOn = pick('DROVER_TRUST_MIRROR', '1');
    // See divergence 4: the SHELL file, because the two arms share one stamp.
    const me = shellVerbPath(de.droverDir);

    let statFmt: StatFmt = '';
    let stampWantOut = '';
    let stampSeenOut = '';

    const header = (fmt: StatFmt): string =>
        `header\tv1\t${home}\t${de.accounts}\t${mirrorOn}\t${fmt}\n`;

    /**
     * write_stamp — header, union lines, stat lines, by rename so a killed run
     * leaves the old stamp rather than half of a new one. Every failure path is
     * silent: no stamp is a slow next start, never a broken one.
     */
    const writeStamp = (print: string): void => {
        const wsDir = dirname(trustStamp);
        try {
            mkdirSync(wsDir, { recursive: true });
        } catch {
            return;
        }
        const tmp = `${trustStamp}.${process.pid}`;
        try {
            writeFileSync(tmp, header(statFmt) + stampWantOut + stampSeenOut + print.replace(/\n$/, '') + '\n');
            renameSync(tmp, trustStamp);
        } catch {
            try {
                unlinkSync(tmp);
            } catch {
                // Already gone.
            }
        }
    };

    // --- the stamp: do nothing when nothing changed (DROVE-287) --------------
    //
    // Measured on the real estate (8 accounts, ~/.claude.json at 216 KB): 41
    // subprocesses per steady-state run, 29 of them jq, 2.3-10.0 s at load 27 —
    // paid before EVERY session start. The fingerprint is every file this verb
    // reads and writes; the stamp also carries the union, so a directory that is
    // already on `want` needs no work and a config that DID change is verified
    // with one read rather than re-walking the estate.
    if (!force && isReadable(trustStamp)) {
        let fastHeader = '';
        let fastWant = '';
        let fastSeen = '';
        const fastPaths: string[] = [];
        let fastOld = '';
        for (const line of readLines(trustStamp)) {
            if (line.startsWith('header\t')) fastHeader = line;
            else if (line.startsWith('want\t')) fastWant += `${line.slice(5)}\n`;
            else if (line.startsWith('seen\t')) fastSeen += `${line.slice(5)}\n`;
            else if (line.startsWith('/')) {
                fastPaths.push(line.split('\t')[0]);
                fastOld += `${line}\n`;
            }
        }
        // The header check also ADOPTS the stat spelling the stamp was written
        // in, which keeps the probe off the fast path. A stamp carried to the
        // other kind of machine makes the fingerprint below disagree, and the
        // full pass decides the format for itself.
        if (`${fastHeader}\n` === header('bsd')) statFmt = 'bsd';
        else if (`${fastHeader}\n` === header('gnu')) statFmt = 'gnu';
        else fastHeader = '';

        let fastOk = false;
        if (fastHeader && fastPaths.length > 0) {
            // A directory to trust must already be part of the union the last
            // clean run applied everywhere; anything else needs the full pass.
            // With the mirror off the stamp carries no `want` lines, so only the
            // no-directory call can take the fast path — the conservative side.
            fastOk = trustDir === '' || `\n${fastWant}`.includes(`\n${trustDir}\n`);
        }
        let nowPrint: string | null = null;
        if (fastOk) {
            nowPrint = fingerprintOf(fastPaths, statFmt);
            if (!nowPrint) {
                // The stat failed or said nothing. Full pass, and let it decide
                // the format for itself rather than trust the header that lied.
                fastOk = false;
                statFmt = '';
            }
        }
        if (fastOk && nowPrint) {
            // The whole point. One stat, one string compare, done.
            if (nowPrint === fastOld) return 0;

            // Something moved. The lines that differ, by leading path field.
            const old = new Set(fastOld.split('\n').filter((l) => l.length > 0));
            const changed = nowPrint.split('\n')
                .filter((l) => l.length > 0 && !old.has(l))
                .map((l) => l.split('\t')[0]);
            const want = fastWant.split('\n').filter((d) => d.length > 0);
            const seen = fastSeen.split('\n').filter((d) => d.length > 0);
            let verifyOk = true;
            for (const chPath of changed) {
                if (!verifyOk) continue;
                if (chPath.endsWith('/.claude.json')) {
                    // Changed, but does it still hold everything a clean run
                    // would leave? A file that stopped parsing fails the same way.
                    if (!isFile(chPath)) {
                        verifyOk = false;
                        continue;
                    }
                    const r = readDoc(chPath);
                    if (!r.ok || !verifyConfig(r.doc, want, seen)) verifyOk = false;
                } else if (chPath.endsWith('/settings.json')) {
                    if (!isFile(chPath)) {
                        verifyOk = false;
                        continue;
                    }
                    const r = readDoc(chPath);
                    const doc = r.ok ? asObject(r.doc) : null;
                    if (!doc || raw(orFalse(doc.skipDangerousModePermissionPrompt)) !== 'true') verifyOk = false;
                } else {
                    // The registry, the script, or something the classifier does
                    // not know. Full pass rather than guess: being wrong here is
                    // one slow start, guessing is a repair that never happens.
                    verifyOk = false;
                }
            }
            if (verifyOk) {
                // Every changed file verified clean: the change was Claude
                // Code's own churn. Refresh the stamp so the next start takes
                // the one-stat exit instead of re-verifying forever.
                for (const d of want) stampWantOut += `want\t${d}\n`;
                for (const d of seen) stampSeenOut += `seen\t${d}\n`;
                writeStamp(nowPrint);
                return 0;
            }
            stampWantOut = '';
            stampSeenOut = '';
        }
    }

    // --- the full pass -------------------------------------------------------
    //
    // Every file a session in this directory might read. The ambient pair is
    // what a bare `drover` uses (CLAUDE_CONFIG_DIR unset); each account has its
    // own, and a flip is exactly the act of moving between them.
    //
    // BOTH paths come from the ambient-aware resolvers, never from a raw
    // expansion. Built by hand once, `{"configDir":"default"}` — the spelling
    // accounts.example.json ships — expanded to the RELATIVE path
    // `default/.claude.json` and the run created ./default/.claude.json inside
    // the working tree while the ambient account's real config went unstamped.
    const configs: string[] = [`${home}/.claude.json`];
    const settings: string[] = [`${home}/.claude/settings.json`];
    if (isReadable(de.accounts)) {
        const reg = readDoc(de.accounts);
        for (const cfg of reg.ok ? registryConfigDirs(reg.doc) : []) {
            if (!cfg) continue;
            const cfgDir = accountDataDir(cfg, home);
            // A relative spelling that is NOT the ambient one can only be a
            // typo. Refused out loud, the way drover-sync-commands already
            // refuses it — a stray config written next to wherever the session
            // started is both wrong and invisible. The data dir and the config
            // file are resolved from the same expansion, so this one test covers
            // both.
            if (!cfgDir.startsWith('/')) {
                err(`drover-trust: skipping configDir '${cfg}' — not an absolute path\n`);
                continue;
            }
            configs.push(accountConfigFile(cfg, home));
            settings.push(`${cfgDir}/settings.json`);
        }
    }

    let stamped = 0;
    // Set by any write that FAILED, anywhere. It is what keeps the stamp
    // honest: a run that could not finish its work must not be remembered as
    // one that did.
    let trustFailed = false;

    /**
     * The write half of json_write, with the once-per-file backup the shell
     * turns on by sourcing lib/drover-config-block.sh. ~/.claude.json and
     * ~/.claude/settings.json are Clay's, not drover's, and this is the only
     * place that stamps them (DROVE-306). Silent on every failure path, exactly
     * as `json_write ... >/dev/null 2>&1` was.
     */
    const writeDoc = (file: string, body: unknown): boolean => {
        try {
            droverConfigBackup(file, ctx, opts.now);
        } catch {
            return false;
        }
        const dir = dirname(file);
        try {
            mkdirSync(dir, { recursive: true });
        } catch {
            return false;
        }
        // Seeded from the target's MODE so the replacement of a 0600 file is
        // still 0600 — without it the rename hands ~/.claude.json whatever the
        // umask says and quietly widens a private file.
        const tmp = `${dir}/.drover-${process.pid}.json`;
        try {
            // Seeding is best-effort, the way `cp -p ... || :` was: a target
            // that cannot be copied is still replaced, it just does not inherit
            // its own mode.
            try {
                if (existsSync(file)) copyFileSync(file, tmp);
            } catch {
                // The shell ignored this too.
            }
            writeFileSync(tmp, `${jqJson(body)}\n`);
            renameSync(tmp, file);
            return true;
        } catch {
            try {
                unlinkSync(tmp);
            } catch {
                // Already gone.
            }
            return false;
        }
    };

    /**
     * stamp <file> <read> <update> <create> — set one key, and only when it is
     * not already true. These files are LIVE — Claude Code rewrites them as
     * sessions run — so every avoided write is an avoided chance to lose
     * somebody else's concurrent update. Every failure path returns without
     * throwing; a config that does not parse is a DECISION (kept, never
     * rewritten) and not a failure, so it does not poison the stamp.
     */
    const stamp = (
        file: string,
        read: (doc: Doc) => unknown,
        update: (doc: Doc) => Doc | null,
        create: () => Doc,
    ): void => {
        let body: Doc;
        if (pathExistsOrIsLink(file)) {
            const r = readDoc(file);
            if (!r.ok) return;
            const doc = asObject(r.doc);
            if (!doc) return;
            let have: string;
            try {
                have = raw(read(doc));
            } catch {
                have = '';
            }
            if (have === 'true') return;
            const next = update(doc);
            if (!next) return;
            body = next;
        } else {
            // Never invent a config dir for an account that is not installed.
            if (!isDir(dirname(file))) return;
            body = create();
        }
        if (!writeDoc(file, body)) {
            // Still not fatal — a dialog is better than no claude at all — but
            // the stamp must not remember this run as one that finished.
            trustFailed = true;
            return;
        }
        stamped += 1;
    };

    // The workspace trust dialog, per directory, in every config.
    if (trustDir) {
        for (const file of configs) {
            stamp(
                file,
                (doc) => {
                    const p = doc.projects;
                    if (p === null || p === undefined) return false;
                    if (typeof p !== 'object' || Array.isArray(p)) throw new Error('jq: cannot index');
                    const entry = (p as Doc)[trustDir];
                    if (entry === null || entry === undefined) return false;
                    if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error('jq: cannot index');
                    return orFalse((entry as Doc).hasTrustDialogAccepted);
                },
                (doc) => {
                    const p = doc.projects ?? {};
                    if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
                    const entry = (p as Doc)[trustDir] ?? {};
                    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
                    return {
                        ...doc,
                        projects: { ...(p as Doc), [trustDir]: { ...(entry as Doc), hasTrustDialogAccepted: true } },
                    };
                },
                () => ({ projects: { [trustDir]: { hasTrustDialogAccepted: true } } }),
            );
        }
    }

    // THE THIRD DIALOG, and it is the one that stranded Clay (DROVE-246). A
    // config dir that has never run interactively opens on Claude Code's
    // FIRST-RUN ONBOARDING before it does anything else — which is exactly the
    // account a flip has just been pointed at.
    //
    // NOT per-directory, so it sits outside the trustDir guard — but it lives in
    // the GLOBAL CONFIG next to trust, not in settings.json, which is why it
    // walks $configs rather than joining the settings loop below.
    //
    // Doing it HERE is what repairs the accounts that are already broken: this
    // runs on every session start against every registry row, so an account that
    // predates the fix is settled the next time any drover session starts.
    for (const file of configs) {
        stamp(
            file,
            (doc) => orFalse(doc.hasCompletedOnboarding),
            (doc) => ({ ...doc, hasCompletedOnboarding: true, hasSeenTasksHint: true, remoteDialogSeen: true }),
            () => ({ hasCompletedOnboarding: true, hasSeenTasksHint: true, remoteDialogSeen: true }),
        );
    }

    // THE UNION (DROVE-271). Trust is per config dir, so every directory Clay
    // has already trusted is a fresh question on every other account, and an
    // account added later inherits nothing at all. Counted on the real machine:
    // the default account held 80 trusted directories, jamrizzi 51, and
    // account-7 — the newest, added from the phone — held 3.
    //
    // A directory trusted on ANY of this machine's accounts is trusted on all of
    // them. That is not a new grant and not a new answer: it is the SAME answer
    // Clay already gave, about the SAME directory, on the SAME machine.
    if (mirrorOn === '1') {
        // jq stops at the first input it cannot parse and never reaches the
        // rest, so the shell kept a per-file fallback for a corrupt config. Node
        // reads each file itself, which IS that fallback: an unparseable config
        // is skipped and every account after it is still read.
        const seenKeys: string[] = [];
        for (const file of configs) {
            if (!isFile(file)) continue;
            const r = readDoc(file);
            if (!r.ok) continue;
            const keys = trustedKeysOf(r.doc);
            if (keys === null) continue;
            seenKeys.push(...keys);
        }
        // The raw union sorted and deduplicated becomes the stamp's `seen`
        // lines; the filtered list its `want` lines.
        const seenSorted = [...new Set(seenKeys)].sort();

        // The home guard below needs the resolved spelling, which the top of the
        // verb no longer computes when there was no directory argument.
        if (!homeReal) homeReal = tryRealpath(home);

        const want = seenSorted.filter((d) => {
            // The same home guard as the stamp above: Claude Code refuses to
            // persist home-directory trust, so an entry there is a lie that
            // reads like a fix. It can only get into the union from an older
            // config, and the union is where it would then be copied into
            // eleven more. Directories that no longer exist are dropped: dead
            // worktrees and test scratch are dead weight in every config forever.
            if (d === homeReal || d === home) return false;
            return isDir(d);
        });

        if (want.length > 0) {
            for (const file of configs) {
                // Never invent a config for an account that is not installed,
                // and never write a file whose only content is somebody else's
                // trust ledger. The onboarding pass above has already created
                // the file if the account's directory exists, so anything still
                // missing here is an account that is not there.
                if (!isFile(file)) continue;
                const r = readDoc(file);
                if (!r.ok) continue;
                const root = asObject(r.doc);
                if (!root) continue;
                const projects = root.projects;
                let existing: Doc;
                if (projects === null || projects === undefined) existing = {};
                else if (typeof projects !== 'object' || Array.isArray(projects)) continue;
                else existing = projects as Doc;
                // Emits nothing when nothing is missing — so an account already
                // holding the union is not rewritten at all. These files are
                // live; every avoided write is an avoided chance to lose a
                // running session's concurrent update.
                const add = want.filter((d) => {
                    const entry = existing[d];
                    if (entry === null || entry === undefined) return true;
                    if (typeof entry !== 'object' || Array.isArray(entry)) return false;
                    return orFalse((entry as Doc).hasTrustDialogAccepted) !== true;
                });
                if (add.length === 0) continue;
                const nextProjects: Doc = { ...existing };
                for (const d of add) {
                    const entry = nextProjects[d];
                    const base = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Doc : {};
                    nextProjects[d] = { ...base, hasTrustDialogAccepted: true };
                }
                if (!writeDoc(file, { ...root, projects: nextProjects })) {
                    trustFailed = true;
                    continue;
                }
                stamped += 1;
            }
        }

        // What the stamp will carry: the union as applied (want) and as read
        // (seen). Built here, while the files still exist; written only by a
        // clean run at the bottom.
        for (const d of want) stampWantOut += `want\t${d}\n`;
        for (const d of seenSorted) stampSeenOut += `seen\t${d}\n`;
    }

    // Top level, not under projects[]: the bypass disclaimer is accepted once
    // for the account, not once per directory.
    for (const file of settings) {
        stamp(
            file,
            (doc) => orFalse(doc.skipDangerousModePermissionPrompt),
            (doc) => ({ ...doc, skipDangerousModePermissionPrompt: true }),
            () => ({ skipDangerousModePermissionPrompt: true }),
        );
    }

    if (set('DROVER_TRUST_VERBOSE') && stamped > 0) {
        err(`drover: pre-accepted the trust, bypass and first-run dialogs in ${stamped} file(s)\n`);
    }

    // The stamp, and only after a clean run: a run that failed a single write
    // has left files it cannot describe, so it records nothing and the next
    // start does the whole pass again — late is recoverable, "remembered as
    // done" is not. Fingerprinted NOW rather than at the top, because this run
    // may have just written some of these files and their mtimes have moved.
    if (!statFmt) statFmt = detectStatFmt();
    if (!trustFailed && statFmt) {
        const endPrint = fingerprintOf([de.accounts, me, ...configs, ...settings], statFmt);
        if (endPrint) writeStamp(endPrint);
    }
    return 0;
}

// --- the small readers -------------------------------------------------------

/**
 * `jq -r '.[]?.configDir // empty'` over the registry. `.[]?` iterates an
 * array's elements or an object's values and suppresses anything else; a row
 * that is not an object makes jq abort, which is the whole registry going
 * unread rather than half of it.
 */
export function registryConfigDirs(doc: unknown): string[] {
    let rows: unknown[];
    if (Array.isArray(doc)) rows = doc;
    else if (doc && typeof doc === 'object') rows = Object.values(doc as Doc);
    else return [];
    const out: string[] = [];
    for (const row of rows) {
        if (row === null || row === undefined) continue;
        if (typeof row !== 'object' || Array.isArray(row)) return [];
        const v = (row as Doc).configDir;
        if (v === null || v === undefined) continue;
        out.push(raw(v));
    }
    return out;
}

/** The shell verb's own resolved path — `$self` joined to the invoked basename. See divergence 4. */
function shellVerbPath(droverDir: string): string {
    const file = join(droverDir, 'libexec', 'drover-trust');
    try {
        return join(dirname(realpathSync(file)), 'drover-trust');
    } catch {
        return file;
    }
}

function tryRealpath(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
}

function isDir(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function isFile(p: string): boolean {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

/** `[ -r "$p" ]` — present AND readable by this process. */
function isReadable(p: string): boolean {
    try {
        accessSync(p, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

/** The stamp's lines; a trailing newline terminates the last rather than starting an empty one. */
function readLines(p: string): string[] {
    let text: string;
    try {
        text = readFileSync(p, 'utf8');
    } catch {
        return [];
    }
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}
