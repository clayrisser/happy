/**
 * `drover home` — one ~/.drover for everything drover owns (DROVE-309), in
 * node (DROVE-315 wave 4). THE READ HALF ONLY.
 *
 * WHAT IS HERE, AND WHAT DELIBERATELY IS NOT. cattle-drover's
 * libexec/drover-home has five subcommands. Two of them only look at the disk
 * and print — `status` and `plan` — plus `--help`, and those three are ported
 * here, sentence for sentence, against the same etc/drover.env answers env.ts
 * already computes. The other three do NOT move:
 *
 *   migrate   moves six trees and leaves a symlink at each old path
 *   rollback  moves them back
 *   verify    writes post.* records into the snapshot and runs the Keychain and
 *             `claude auth status` probes; it is the gate migrate rolls back on,
 *             so it is part of the write half, not the read half
 *
 * They stay in POSIX sh because this migration has never been run on Clay's
 * real machine yet, and a rewrite must not be the thing that performs it the
 * first time. The engine that does the moving, lib/drover-home.sh, is not
 * translated here at all — there is no second copy of it to drift.
 *
 * So `home` KEEPS owner=shell in bin/drover: `drover home <anything>` reaches
 * libexec/drover-home exactly as it did. This module is reachable by name
 * (`node dist/index.mjs home status`) and by the verb table, and when it is
 * handed a write subcommand it says so and exits HOME_WRITE_STAYS_IN_SHELL
 * rather than pretending or shelling out. Nothing in this file moves, removes,
 * links or writes a byte anywhere; home.test.ts asserts that against a fixture
 * tree, before and after every run.
 *
 * PATHS COME FROM env.ts AND NOWHERE ELSE. droverHomePath() there is the node
 * twin of drover_home_path() in etc/drover.env — the new path when it is there,
 * else the legacy path when THAT is there, else the new one — and there are no
 * XDG lookups on either side, which is the DROVE-309 ruling.
 *
 * ONE PROBE FOR THE MACHINE. `du`, `lsof`, `launchctl` and the
 * DROVER_HOME_WRITERS_PROBE shell-out are the only things that leave this
 * process, and they all sit on HomeProbe so a test can hand in a double that
 * throws instead of measuring Clay's box.
 *
 * DIVERGENCES, all of them:
 *   - `status` re-resolves STATE_DIR in a clean environment by calling
 *     droverEnv() with STATE_DIR unset, where the shell spawned
 *     `env -u STATE_DIR sh -c '. etc/drover.env'`. Same answer, no subprocess.
 *     The shell's spawn could fail and fall through to an empty string; this
 *     one cannot, so a pathological machine that made the shell print an empty
 *     "a fresh shell resolves" tail gets the real path here.
 *   - `home_real_home` runs `id -un` then tilde-expands it; this reads the same
 *     password-database entry through os.userInfo(). $HOME is not consulted by
 *     either, which is what lets a test point HOME at a fixture.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { delimiter, basename, join } from 'node:path';
import { homedir, userInfo } from 'node:os';

import { droverEnv } from './env';

type Env = Record<string, string | undefined>;

/**
 * The exit code a write subcommand gets here.
 *
 * It is a sentinel, not a failure: it means "this verb exists, and the half you
 * asked for is still the shell file". A dispatcher that ever routes `home` to
 * node may read it as "fall through to libexec/drover-home"; until the write
 * half ports, bin/drover routes `home` to the shell verb outright and nothing
 * has to.
 */
export const HOME_WRITE_STAYS_IN_SHELL = 3;

/** The subcommands that move bytes. Named here so the refusal cannot drift from the dispatch. */
export const writeSubcommands: readonly string[] = ['migrate', 'verify', 'rollback'];

const HELP = `drover home — one ~/.drover for everything drover owns.

USAGE
  drover home [status]     each mover's state (legacy, migrated, absent), what
                           etc/drover.env resolves today, live writers, last run
  drover home plan         the moves, their sizes, the gates, the commands
                           around them. Touches nothing.
  drover home migrate      snapshot -> move -> verify, with an automatic
                           rollback on a failed verify. --no-rollback keeps a
                           failed tree in place for inspection.
  drover home verify       run the gates again against the latest snapshot
  drover home rollback     reverse the last move; proves nothing was lost

THE MOVES (bytes move; a symlink stays at the old path)
  ~/.happy                       -> ~/.drover/happy
  ~/.shotgun                     -> ~/.drover/shotgun
  ~/.claude-accounts             -> ~/.drover/claude-accounts   (symlink is permanent: the
                                                                Keychain is keyed on the path)
  ~/.claude-shared               -> ~/.drover/claude-shared
  ~/.rulesync                    -> ~/.drover/rulesync
  ~/.local/state/cattle-drover   -> ~/.drover/state

NEVER MOVED  ~/.claude  ~/.claude.json  ~/.cursor  ~/.codex  (the harnesses read them)

ENV
  DROVER_HOME=<dir>            where everything goes (default ~/.drover; no XDG)
  DROVER_MIGRATE_ALLOW=1       required to mutate the login user's real home
  DROVER_HOME_LIVE_GATES=0     skip the Keychain and \`claude auth status\` probes
                               on the real home (not recommended)
  DROVER_HOME_WRITERS_PROBE    a command whose stdout replaces the writer scan
                               (tests inject a writer, or none, with it)

See docs/drover-home-migration.md for the runbook and the hazards.
`;

// --- the machine, behind one object ------------------------------------------

/**
 * Everything in this verb that leaves the process. A test hands in a double
 * whose members throw, so a read path that reached for the real box fails the
 * test instead of measuring it.
 */
export interface HomeProbe {
    /** `du -sh <path> 2>/dev/null | awk '{print $1}'` — the size column, or ''. */
    duSh(path: string): string;
    /** `sh -c "$DROVER_HOME_WRITERS_PROBE"` — the suite's own injection point. */
    writersProbe(command: string): string;
    /** `command -v launchctl` */
    launchctlPresent(): boolean;
    /** `launchctl print <target>` exited 0. */
    launchctlLoaded(target: string): boolean;
    /** `command -v lsof` */
    lsofPresent(): boolean;
    /** `lsof -n -w -F pcn` on stdout. */
    lsof(): string;
}

/** `command -v <name>`, as a PATH walk: the name is a file this user can execute. */
export function onPath(name: string, env: Env): boolean {
    if (name.includes('/')) return existsSync(name);
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (dir === '') continue;
        try {
            if (statSync(join(dir, name)).isFile()) return true;
        } catch {
            // Not there, or not readable: `command -v` says no to both.
        }
    }
    return false;
}

/** spawnSync refuses an `env` holding undefined; the shell's own environment holds only strings. */
function definedOnly(env: Env): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
    return out;
}

/**
 * The real machine. Every spawn carries the SAME environment the verb was
 * handed, not the ambient one: `du -sh` reads BLOCKSIZE, and a node arm that
 * inherited a different one would print a different size from the shell arm on
 * the identical tree.
 */
export function defaultHomeProbe(env: Env = process.env): HomeProbe {
    const spawnEnv = definedOnly(env);
    return {
        duSh(path: string): string {
            const r = spawnSync('du', ['-sh', path], { encoding: 'utf8', env: spawnEnv });
            const first = (r.stdout ?? '').split('\n')[0] ?? '';
            const fields = first.trim().split(/[ \t]+/).filter((f) => f !== '');
            return fields[0] ?? '';
        },
        writersProbe(command: string): string {
            const r = spawnSync('sh', ['-c', command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: spawnEnv });
            return r.stdout ?? '';
        },
        launchctlPresent: () => onPath('launchctl', env),
        launchctlLoaded(target: string): boolean {
            const r = spawnSync('launchctl', ['print', target], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], env: spawnEnv });
            return r.status === 0;
        },
        lsofPresent: () => onPath('lsof', env),
        lsof(): string {
            const r = spawnSync('lsof', ['-n', '-w', '-F', 'pcn'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: spawnEnv });
            return r.stdout ?? '';
        },
    };
}

/** What the verb reads the world through. */
export interface HomeCtx {
    env: Env;
    /** $HOME — what a test overrides. */
    home: string;
    /** The login user's home per the password database — what a test cannot. */
    realHome: string;
    probe: HomeProbe;
}

export function homeCtx(env: Env = process.env, home: string = homedir()): HomeCtx {
    return { env, home, realHome: homeRealHome(env, home), probe: defaultHomeProbe(env) };
}

// --- the tables (lib/drover-home.sh) ------------------------------------------

export interface Mover {
    /** Where the tree lives before a migration. */
    old: string;
    /** Where it lives after one. */
    next: string;
    /** basename of the new path: happy, shotgun, claude-accounts, ... */
    tag: string;
}

/** home_movers: old|new, one per line, in the shell's order. */
export function homeMovers(srcHome: string, droverHome: string): Mover[] {
    const pairs: [string, string][] = [
        [join(srcHome, '.happy'), join(droverHome, 'happy')],
        [join(srcHome, '.shotgun'), join(droverHome, 'shotgun')],
        [join(srcHome, '.claude-accounts'), join(droverHome, 'claude-accounts')],
        [join(srcHome, '.claude-shared'), join(droverHome, 'claude-shared')],
        [join(srcHome, '.rulesync'), join(droverHome, 'rulesync')],
        [join(srcHome, '.local', 'state', 'cattle-drover'), join(droverHome, 'state')],
    ];
    return pairs.map(([old, next]) => ({ old, next, tag: homeTag(next) }));
}

/** home_stayers: read by the harnesses themselves, never moved. */
export function homeStayers(srcHome: string): string[] {
    return ['.claude', '.claude.json', '.cursor', '.codex'].map((n) => join(srcHome, n));
}

export function homeTag(path: string): string {
    return basename(path);
}

// --- helpers ------------------------------------------------------------------

function isSymlink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

/** `[ -d "$1" ]`: follows symlinks, like the shell's test. */
function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** home_canon: the directory with symlinks resolved, or the path itself when it is not one. */
export function homeCanon(path: string): string {
    if (!isDir(path)) return path;
    try {
        return realpathSync(path);
    } catch {
        // `(cd -P -- "$1" && pwd -P)` that fails prints nothing.
        return '';
    }
}

/**
 * home_real_home: the login user's home per the password database. $HOME is
 * what a test overrides; this is what it cannot. The shell reads it as
 * `eval printf %s "~$(id -un)"`, which is getpwnam; os.userInfo() is getpwuid,
 * the same file, and both fall back to $HOME when the answer is not absolute.
 */
export function homeRealHome(env: Env = process.env, home: string = homedir()): string {
    let h = '';
    try {
        h = userInfo().homedir ?? '';
    } catch {
        h = '';
    }
    return h.startsWith('/') ? h : (env.HOME ?? home);
}

/** home_is_real: is SRC_HOME the login user's own home? */
export function homeIsReal(srcHome: string, realHome: string): boolean {
    return homeCanon(srcHome) === homeCanon(realHome);
}

/** home_tilde: ~/x for a path under SRC_HOME, ~ for SRC_HOME itself, verbatim otherwise. */
export function homeTilde(path: string, srcHome: string): string {
    if (path.startsWith(`${srcHome}/`)) return `~/${path.slice(srcHome.length + 1)}`;
    if (path === srcHome) return '~';
    return path;
}

/**
 * home_mover_state, the six states:
 *   legacy        the old path is a real directory; nothing has moved
 *   migrated      the old path is a symlink to exactly the new path
 *   absent        neither exists
 *   new-only      the new path exists and the old one is gone: the compat
 *                 symlink is missing, which is the "never silent" rule broken
 *   conflict      both are real directories; a move would clobber one
 *   foreign-link  the old path is a symlink somewhere else; not ours to touch
 */
export function homeMoverState(old: string, next: string): string {
    if (isSymlink(old)) {
        let target = '';
        try {
            target = readlinkSync(old);
        } catch {
            target = '';
        }
        return target === next ? 'migrated' : 'foreign-link';
    }
    if (isDir(old)) return existsSync(next) ? 'conflict' : 'legacy';
    if (existsSync(next)) return 'new-only';
    return 'absent';
}

export interface MoverState extends Mover {
    state: string;
}

/** mover_states: one row per mover, tag / state / old / new. */
export function moverStates(ctx: HomeCtx): MoverState[] {
    return homeMovers(srcHomeOf(ctx), droverHomeOf(ctx))
        .map((m) => ({ ...m, state: homeMoverState(m.old, m.next) }));
}

/** summary: fresh / migrated (n of n) / legacy (n to move) / partial (m of n migrated). */
export function summary(states: MoverState[]): string {
    let total = 0;
    let mig = 0;
    let leg = 0;
    for (const s of states) {
        if (s.state === 'absent') continue;
        if (s.state === 'migrated') mig += 1;
        else if (s.state === 'legacy') leg += 1;
        total += 1;
    }
    if (total === 0) return 'fresh';
    if (mig === total) return `migrated (${mig} of ${total})`;
    if (leg === total) return `legacy (${total} to move)`;
    return `partial (${mig} of ${total} migrated)`;
}

/** blocked_states: the rows a move cannot touch. */
export function blockedStates(states: MoverState[]): MoverState[] {
    return states.filter((s) => s.state === 'conflict' || s.state === 'foreign-link' || s.state === 'new-only');
}

function srcHomeOf(ctx: HomeCtx): string {
    return ctx.env.SRC_HOME || ctx.home;
}

function droverHomeOf(ctx: HomeCtx): string {
    // etc/drover.env sets DROVER_HOME before lib/drover-home.sh is sourced, so
    // the lib's `${DROVER_HOME:-$SRC_HOME/.drover}` is always a no-op.
    return droverEnv(ctx.env, ctx.home).droverHome;
}

/** live_gates_on: only the login user's real home can run the Keychain and auth probes. */
export function liveGatesOn(ctx: HomeCtx): boolean {
    return homeIsReal(srcHomeOf(ctx), ctx.realHome) && (ctx.env.DROVER_HOME_LIVE_GATES ?? '1') !== '0';
}

// --- writers: what would break if a mover moved right now ---------------------

/**
 * home_writers: pid<TAB>command<TAB>path per open file under any mover, plus one
 * line per loaded launchd unit on the real home. Empty means quiesced.
 * DROVER_HOME_WRITERS_PROBE replaces the whole probe, so the suite injects a
 * writer, or none, without lsof.
 */
export function homeWriters(ctx: HomeCtx): string {
    const injected = ctx.env.DROVER_HOME_WRITERS_PROBE;
    if (injected) return ctx.probe.writersProbe(injected);

    let out = '';
    const srcHome = srcHomeOf(ctx);
    if (homeIsReal(srcHome, ctx.realHome) && ctx.probe.launchctlPresent()) {
        const uid = process.getuid ? process.getuid() : 0;
        for (const s of ['bus', 'relay', 'bridge', 'daemon']) {
            if (ctx.probe.launchctlLoaded(`gui/${uid}/com.bitspur.cattle-drover.${s}`)) {
                out += `launchd\tcom.bitspur.cattle-drover.${s}\t(unit loaded: make unlaunchd)\n`;
            }
        }
    }
    if (!ctx.probe.lsofPresent()) return out;

    // Both spellings of each mover, so a writer that reached the new path
    // through the old one still shows.
    const prefixes = new Set<string>();
    for (const m of homeMovers(srcHome, droverHomeOf(ctx))) {
        for (const p of [m.old, m.next]) {
            prefixes.add(p);
            if (existsSync(p)) {
                const canon = homeCanon(p);
                if (canon !== '') prefixes.add(canon);
            }
        }
    }
    return out + writersFromLsof(ctx.probe.lsof(), [...prefixes]);
}

/** The awk half of home_writers: lsof's -F pcn stream, filtered to the movers. */
export function writersFromLsof(stream: string, prefixes: string[]): string {
    const pre = prefixes.filter((p) => p !== '');
    let pid = '';
    let cmd = '';
    let out = '';
    for (const line of stream.split('\n')) {
        if (line.startsWith('p')) {
            pid = line.slice(1);
            continue;
        }
        if (line.startsWith('c')) {
            cmd = line.slice(1);
            continue;
        }
        if (!line.startsWith('n')) continue;
        const name = line.slice(1);
        for (const p of pre) {
            if (name === p || name.startsWith(`${p}/`)) {
                out += `${pid}\t${cmd}\t${name}\n`;
                break;
            }
        }
    }
    return out;
}

// --- the snapshot record ------------------------------------------------------

function snapRootOf(ctx: HomeCtx): string {
    return join(droverHomeOf(ctx), 'migrate');
}

/** latest_snap: the target of migrate/latest, when it is a symlink to a directory. */
export function latestSnap(ctx: HomeCtx): string {
    const link = join(snapRootOf(ctx), 'latest');
    if (!isSymlink(link)) return '';
    if (!isDir(link)) return '';
    try {
        return readlinkSync(link);
    } catch {
        return '';
    }
}

// --- printf, as printf ---------------------------------------------------------

/** printf %-Ns. */
function padRight(s: string, n: number): string {
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** printf %Ns. */
function padLeft(s: string, n: number): string {
    return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/** `$(...)`: command substitution strips trailing newlines, and only those. */
function stripTrailingNewlines(s: string): string {
    let end = s.length;
    while (end > 0 && s[end - 1] === '\n') end -= 1;
    return s.slice(0, end);
}

/** `wc -l`: newlines, not lines. */
function countNewlines(s: string): number {
    let n = 0;
    for (const c of s) if (c === '\n') n += 1;
    return n;
}

// --- the verbs ------------------------------------------------------------------

/** cmd_status. Reads; prints; touches nothing. */
export function cmdStatus(ctx: HomeCtx): string {
    const srcHome = srcHomeOf(ctx);
    const tilde = (p: string): string => homeTilde(p, srcHome);
    const resolved = droverEnv(ctx.env, ctx.home);
    const states = moverStates(ctx);
    const lines: string[] = [];
    const say = (s: string): void => void lines.push(`${s}\n`);

    say(`drover home: ${tilde(resolved.droverHome)}   ${summary(states)}`);
    for (const s of states) {
        say(`  ${padRight(s.tag, 16)} ${padRight(s.state, 13)} ${tilde(s.old)} -> ${tilde(s.next)}`);
    }
    const blocked = blockedStates(states);
    if (blocked.length > 0) {
        say('  BLOCKED: a move cannot touch these until they are sorted by hand:');
        for (const b of blocked) say(`    ${b.tag} is ${b.state} (${b.old})`);
    }

    // What a fresh shell would resolve STATE_DIR to, against what this process
    // carries. bin/drover exports STATE_DIR into every session it starts, so a
    // shell inside one carries the pre-move spelling.
    const inherited = ctx.env.STATE_DIR ?? '';
    const fresh = droverEnv({ ...ctx.env, STATE_DIR: undefined }, ctx.home).stateDir;
    if (inherited !== '' && fresh !== resolved.stateDir) {
        say(`  STATE_DIR          ${tilde(resolved.stateDir)}   (inherited from this shell; a fresh shell resolves ${tilde(fresh)})`);
    } else {
        say(`  STATE_DIR          ${tilde(resolved.stateDir)}`);
    }
    say(`  DROVER_HAPPY_HOME  ${tilde(resolved.happyHome)}`);

    const writers = countNewlines(homeWriters(ctx));
    if (writers === 0) say('  writers            none (a move could run now)');
    else say(`  writers            ${writers} open (drover home plan lists them)`);

    const snap = latestSnap(ctx);
    if (snap !== '') {
        let statusText = 'unknown';
        try {
            statusText = stripTrailingNewlines(readFileSync(join(snap, 'status'), 'utf8'));
        } catch {
            statusText = 'unknown';
        }
        say(`  last run           ${basename(snap)} ${statusText}`);
    } else {
        say('  last run           none');
    }
    return lines.join('');
}

/** cmd_plan. The moves, their sizes, the gates, the commands around them. Touches nothing. */
export function cmdPlan(ctx: HomeCtx): string {
    const srcHome = srcHomeOf(ctx);
    const tilde = (p: string): string => homeTilde(p, srcHome);
    const droverHome = droverHomeOf(ctx);
    const states = moverStates(ctx);
    const lines: string[] = [];
    const say = (s: string = ''): void => void lines.push(`${s}\n`);

    say('drover home plan — what `drover home migrate` would do. Nothing is touched.');
    say();
    say('MOVES  (bytes move; a symlink stays at the old path, so every old spelling still resolves)');
    for (const s of states) {
        const old30 = padRight(tilde(s.old), 30);
        if (s.state === 'legacy') {
            say(`  ${old30} ${padLeft(ctx.probe.duSh(s.old), 8)}  -> ${tilde(s.next)}`);
        } else if (s.state === 'migrated') {
            say(`  ${old30} ${padLeft('-', 8)}     ${tilde(s.next)} (already)`);
        } else if (s.state === 'absent') {
            say(`  ${old30} ${padLeft('-', 8)}     (absent, skipped)`);
        } else {
            say(`  ${old30} ${padLeft('-', 8)}     BLOCKED: ${s.state}`);
        }
    }
    say();
    // The shell's `$(... printf '%s  ' ...)` keeps the trailing two spaces:
    // command substitution strips newlines, not blanks.
    say(`NEVER MOVED  ${homeStayers(srcHome).map((s) => `${tilde(s)}  `).join('')}`);
    say("  These are the harnesses' own files. Their fingerprint is taken before and after; a difference fails the run.");
    say();
    say('GATES after the move (any failure rolls the move back and exits nonzero)');
    say("  every mover's sha256-per-file inventory equals its pre-move inventory");
    say('  every old path is a symlink to exactly its new path');
    say('  accounts.json configDir strings, their expansions and their Keychain service names are byte-identical');
    say('  ~/.claude, ~/.claude.json, ~/.cursor, ~/.codex fingerprint unchanged; ~/.claude/projects still resolves');
    if (liveGatesOn(ctx)) {
        say('  every Keychain item present before is present after; no account goes from signed-in to signed-out');
    } else {
        say('  (Keychain and auth probes run only on the login user\'s real home)');
    }
    say();
    say('WRITERS right now');
    const writers = stripTrailingNewlines(homeWriters(ctx));
    if (writers === '') {
        say('  none');
    } else {
        for (const line of writers.split('\n')) {
            const f = line.split('\t');
            say(`  ${padRight(f[0] ?? '', 8)} ${padRight(f[1] ?? '', 24)} ${f[2] ?? ''}`);
        }
    }
    say();
    say('SEQUENCE, from an interactive terminal on this machine');
    say('  1. make unlaunchd                      # boot out bus, relay, bridge, daemon (KeepAlive would restart a stopped one)');
    say('  2. exit every drover, happy and claude session; drover home status must say writers: none');
    say('  3. DROVER_MIGRATE_ALLOW=1 drover home migrate');
    say(`  4. env -u STATE_DIR make launchd       # re-render the plists against STATE_DIR=${tilde(join(droverHome, 'state'))} and bootstrap`);
    say('  5. drover home status; start a session; drover accounts');
    say('  rollback at any point:  make unlaunchd; DROVER_MIGRATE_ALLOW=1 drover home rollback; env -u STATE_DIR make launchd');
    return lines.join('');
}

/** What a write subcommand gets: the truth, and where the work actually lives. */
export function writeHalfRefusal(sub: string): string {
    return `drover home: ${sub} is not in the node port; it moves real bytes and stays in\n`
        + '  cattle-drover/libexec/drover-home (DROVE-315). bin/drover routes `drover home`\n'
        + `  to that shell verb, so \`drover home ${sub}\` still runs it.\n`;
}

export async function run(args: string[], ctxIn?: HomeCtx): Promise<number> {
    // Help first, before an env read, a file read or a subprocess: the loadtime
    // gate in tests/libexec-loadtime.bats counts a spawn on --help as a
    // load-time side effect, and it is right.
    const sub = args[0] === undefined || args[0] === '' ? 'status' : args[0];
    if (sub === '-h' || sub === '--help' || sub === 'help') {
        process.stdout.write(HELP);
        return 0;
    }
    if (sub === 'status' || sub === 'plan') {
        const ctx = ctxIn ?? homeCtx();
        process.stdout.write(sub === 'status' ? cmdStatus(ctx) : cmdPlan(ctx));
        return 0;
    }
    if (writeSubcommands.includes(sub)) {
        process.stderr.write(writeHalfRefusal(sub));
        return HOME_WRITE_STAYS_IN_SHELL;
    }
    process.stderr.write(`drover home: unknown subcommand '${sub}' (status, plan, migrate, verify, rollback; --help)\n`);
    return 2;
}
