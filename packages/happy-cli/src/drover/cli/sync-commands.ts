/**
 * `drover sync-commands` in node — libexec/drover-sync-commands, transliterated
 * (DROVE-315 wave 4).
 *
 * WHAT IT IS FOR is argued at length in the shell file's header and none of it
 * is repeated here: /flip and /todos written into every account's config dir so
 * the TERMINAL slash command is real; skills/ and agents/ SYMLINKED so a flip
 * costs quota and not capability; settings.json MERGED (hooks mirrored,
 * permissions add-only) because a flipped session was running with no ask-*
 * gates and no deny rules; .claude.json's mcpServers MIRRORED so a server
 * switched off in mcps.enabled is switched off everywhere; the same source
 * mirrored into OpenCode's `mcp` block by engine/opencode-mirror.js; and a
 * stamp over every path it reads and writes so the common start does no work at
 * all. Read cattle-drover/libexec/drover-sync-commands for the reasoning. This
 * file is the same program with the subprocesses removed.
 *
 * ONE READER for the OpenCode half. engine/opencode-mirror.js STAYS in the
 * cattle-drover checkout and is loaded into this process by loadEngine, exactly
 * as the bus loads it — the conversion, the ${VAR}->{env:VAR} rewrite and the
 * splice are its own and are not translated here. The shell spawned `node
 * engine/opencode-mirror.js` and read its stdout; this calls the same
 * `main(argv)` and captures the same stdout, because that function writes its
 * report rather than returning it.
 *
 * NO PROBE OBJECT, and that is a finding rather than an omission. The shell's
 * 164 subprocesses were `stat`, `jq`, `cmp`, `readlink`, `ln`, `mkdir`, `cp`
 * and `date` — every one of them a filesystem or JSON operation node does in
 * process. There is no `ps`, no `tmux`, no `gum`, no `launchctl` and no pty
 * anywhere in this verb, so nothing here can reach Clay's machine by way of a
 * shell-out. The one seam that leaves this module is the engine load, and it is
 * injectable (SyncCommandsIo) so a test can hand in a double that throws.
 *
 * DELIBERATE DIVERGENCES, each named because the shell file is the spec:
 *
 *  1. `no jq — nothing written` is unreachable. node parses JSON in process, so
 *     the branch that exits 0 on a machine without jq has no counterpart.
 *  2. `skipped opencode (node is not on PATH)` is unreachable for the same
 *     reason: this IS node.
 *  3. The stat-format probe does not spawn `stat`. darwin gets the BSD spelling
 *     (`%N %m %z %p %Y`), anything else the GNU one (`%n %Y %s %f %N`), from
 *     `process.platform` rather than by trying both; and the third case — a
 *     machine with NEITHER stat, which degrades to no stamp at all — cannot
 *     happen, because fs.lstat is always there.
 *  4. `$me` in the fingerprint is still the realpath of the SHELL file, not of
 *     this module. That keeps the stamp byte-interoperable while bin/drover can
 *     still run either implementation over the same $STATE_DIR: whichever ran
 *     last, the other reads its stamp and agrees. The cost is that editing THIS
 *     file does not invalidate the stamp; `--force` is the escape hatch, and a
 *     new build's dist path would have invalidated it on every rebuild, which
 *     is worse.
 *  5. Ordering is BYTE order. `sort -u` and sh's `*` glob order by the locale's
 *     collation; this orders by bytes. For the lowercase ASCII names these
 *     paths actually carry the two agree; they separate only where case or
 *     punctuation would (`Zed.md` before `agent-os` here, after it under
 *     en_US).
 *  6. Object key order is JS's: string keys keep insertion order, but an
 *     integer-like key is reordered to the front. jq keeps every key where it
 *     found it. No key in settings.json or .claude.json is integer-like.
 *  7. jq 1.7 preserves a number's original literal, so an untouched `1.0` is
 *     written back as `1.0`; JSON.parse/stringify normalises it to `1`.
 *  8. `--slurpfile` reads a STREAM of JSON values and takes the first; this
 *     reads exactly one document and treats a second as a parse failure.
 */

import {
    accessSync,
    chmodSync,
    constants,
    copyFileSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { accountDataDir, home as homeOf, jsonWrite } from './account-store';
import { loadEngine } from './engine';
import { droverEnv } from './env';

// --- the three heredocs, byte for byte ---------------------------------------

const helpText = `drover-sync-commands — put /flip in every account's Claude Code config dir.

USAGE
  libexec/drover-sync-commands        Silent; run before every session start
  libexec/drover-sync-commands -v     Say what it did to each account
  libexec/drover-sync-commands -f     Ignore the stamp and sync everything

It keeps a stamp of every path it reads and writes (\$STATE_DIR, or
\$DROVER_SYNC_STAMP) and does nothing when none of them has moved, because it
runs before every session start and the full pass costs 164 subprocesses --
seconds, on a loaded machine. Only the accounts whose own files changed are
re-checked; a changed ~/.claude/settings.json, ~/.claude.json or registry
re-checks all of them. --force ignores the stamp.

It writes <configDir>/commands/flip.md and <configDir>/commands/todos.md for
every account in the registry (\$DROVER_ACCOUNTS), rewriting only when the
content differs, then links the default account's skills/, agents/ and the
rest of its commands/ into every account so a flip costs quota and not
capability. It never removes anything: an entry that is already there is kept,
which is also how an account keeps a tree of its own.

It also merges the default account's \`hooks\` and \`permissions\` into every
account's settings.json, because a flipped session was running with no ask-*
gates and no deny rules at all. Everything else in that file -- theme, model,
effortLevel, modelSettings, tui, skipDangerousModePermissionPrompt,
enabledPlugins, crossSessionInbound, agentPushNotifEnabled,
remoteControlAtStartup -- is per-account and is left exactly as found. allow,
deny and ask are add-only, so a merge can never widen a rule away; hooks are
mirrored. The old file is copied into <configDir>/drover-backups/ before any
write, and a settings.json that does not parse is never rewritten.

And it MIRRORS the default account's \`mcpServers\` into every account's
.claude.json, because a flipped session had none of the forty MCP servers
\`~/.shotgun\` configures. Mirrored rather than unioned so a server switched off
in mcps.enabled is switched off everywhere. Nothing else in that file is read
from the default: the OAuth identity, the usage caches, the first-run gates and
projects/ are per-account and are left exactly as found. Same backup and same
refusal to rewrite a file that does not parse.

And it mirrors the SAME source into OpenCode's \`mcp\` block
(~/.config/opencode/opencode.jsonc), converted to OpenCode's own schema by
engine/opencode-mirror.js -- type local/remote, command as an array, \${VAR}
rewritten to {env:VAR}. A \${VAR:-default} becomes {env:VAR} when the variable
is set here and the default when it is not, named either way in a comment
inside the block (DROVE-317). A server whose config OpenCode still cannot
express (a \${VAR:+alt}) is skipped BY NAME, on stdout and in that same block.
Everything outside it is preserved byte for byte; hand edits inside it lose to
the mirror and are reported when they do.

It never blocks: every failure path exits 0, because a session without those
commands beats no session.
`;

/**
 * The command file. The model-facing text has to survive being re-read in
 * HISTORY after the resume — the transcript carries this exchange onto the new
 * account — so it says explicitly that a past flip is not an instruction.
 */
export function render(request: string): string {
    return `---
description: "Cattle Drover: move this session onto another Claude account"
argument-hint: "[account]"
allowed-tools: Bash(${request}:*)
---

<!-- managed by drover-sync-commands (BASED-98); edits are overwritten -->

Flip status: !\`${request} $ARGUMENTS\`

Relay the flip status line above to the user in one short sentence and stop —
no tools, no follow-up work. If it says the flip was requested, the Cattle
Drover wrapper is about to stop this claude and resume the conversation on the
other account; being cut off mid-reply is expected. If it names a problem (not
drover-managed, only one account, bus unreachable), that message IS the
answer. If you are reading this in history after the session resumed, the flip
already happened — do not act on it again.
`;
}

/**
 * /todos — the terminal view of the needs-you list (DROVE-53). It has to be a
 * command FILE for the same reason /flip does: Claude Code's TUI parses slash
 * commands itself and never consults the drover wrapper.
 */
export function renderTodos(todos: string): string {
    return `---
description: "Cattle Drover: what this session still needs you to do"
argument-hint: "[--done <id>] [--mine]"
allowed-tools: Bash(${todos}:*)
---

<!-- managed by drover-sync-commands (DROVE-53); edits are overwritten -->

Open to-dos: !\`${todos} $ARGUMENTS\`

Relay the list above to the user as it is, adding nothing. These are things the
user has to DO — a push, a login, a command on a box — raised by a session with
\`drover needs\`. They are not project management and not your task list, so do
not offer to do them, do not restate them as a plan, and do not treat an open
one as an instruction to you. If the list is empty, say so in one line and stop.
`;
}

// --- jq semantics, only the parts this program uses ---------------------------

/** jq's `//`: the alternative on null and on FALSE, not only on null. */
function jqAlt(value: unknown, fallback: unknown): unknown {
    return value === null || value === undefined || value === false ? fallback : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A jq program that errored. The caller prints the shell's `kept ...` line. */
class JqError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JqError';
    }
}

/** jq's `==`: deep, and order-insensitive on objects. */
function jqEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => jqEqual(item, b[i]));
    }
    if (isObject(a) && isObject(b)) {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jqEqual(a[k], b[k]));
    }
    return false;
}

/** jq's `length`, for the `(.permissions | length) == 0` test. */
function jqLength(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'boolean') throw new JqError('boolean has no length');
    if (typeof value === 'number') return Math.abs(value);
    if (typeof value === 'string') return [...value].length;
    if (Array.isArray(value)) return value.length;
    return Object.keys(value as object).length;
}

/**
 * `def add($a; $b): ($a // []) + (($b // []) - ($a // []));` — a union that
 * keeps the account's order, adds only what is missing, and is a fixed point on
 * the second run. jq's `-` removes every element of the right from the left.
 */
function add(a: unknown, b: unknown): unknown[] {
    const left = jqAlt(a, []);
    const right = jqAlt(b, []);
    if (!Array.isArray(left) || !Array.isArray(right)) throw new JqError('cannot union a non-array');
    return left.concat(right.filter((item) => !left.some((seen) => jqEqual(seen, item))));
}

/** The settings merge. `undefined` means the merge would change nothing. */
export function settingsMerge(def: unknown, cur: unknown): Record<string, unknown> | undefined {
    const d = jqAlt(def, {});
    const c = jqAlt(cur, {});
    if (!isObject(d) || !isObject(c)) throw new JqError('cannot index a non-object');
    const dp = jqAlt(d.permissions, {});
    const cp = jqAlt(c.permissions, {});
    if (!isObject(dp) || !isObject(cp)) throw new JqError('cannot index a non-object');
    const allow = add(cp.allow, dp.allow);
    const deny = add(cp.deny, dp.deny);
    const ask = add(cp.ask, dp.ask);

    const merged: Record<string, unknown> = { ...c };
    if (Object.prototype.hasOwnProperty.call(d, 'hooks')) merged.hooks = d.hooks;
    const permissions: Record<string, unknown> = { ...cp };
    if (allow.length > 0) permissions.allow = allow;
    if (deny.length > 0) permissions.deny = deny;
    if (ask.length > 0) permissions.ask = ask;
    merged.permissions = permissions;
    if (jqLength(merged.permissions) === 0) delete merged.permissions;

    return jqEqual(merged, c) ? undefined : merged;
}

/**
 * The mcpServers mirror. A default tree with no mcpServers key at all says
 * nothing, and nothing is what gets copied. `undefined` means unchanged.
 */
export function configMerge(def: unknown, cur: unknown): Record<string, unknown> | undefined {
    const d = jqAlt(def, {});
    const c = jqAlt(cur, {});
    if (!isObject(d) || !isObject(c)) throw new JqError('cannot index a non-object');
    const merged: Record<string, unknown> = { ...c };
    if (Object.prototype.hasOwnProperty.call(d, 'mcpServers')) merged.mcpServers = d.mcpServers;
    return jqEqual(merged, c) ? undefined : merged;
}

// --- the filesystem, said the way the shell tests said it ---------------------

function readable(path: string): boolean {
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

/** `[ -d path ]`, which follows symlinks. */
function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** `[ -e path ]`: follows symlinks, so a dangling link is NOT -e. */
function exists(path: string): boolean {
    try {
        statSync(path);
        return true;
    } catch {
        return false;
    }
}

/** `[ -L path ]`. */
function isLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

/** `[ -e path ] || [ -L path ]` — the fingerprint's presence test. */
function present(path: string): boolean {
    return exists(path) || isLink(path);
}

function mkdirp(path: string): boolean {
    try {
        mkdirSync(path, { recursive: true });
        return true;
    } catch {
        return false;
    }
}

/** Byte order, which is what `sort -u` and `*` order by under LC_ALL=C. */
function byteCompare(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** sh's `"$dir"/*`: sorted, and dotfiles are not matched. */
function globChildren(dir: string): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names.filter((n) => !n.startsWith('.')).sort(byteCompare).map((n) => join(dir, n));
}

/** `date -u +%Y%m%dT%H%M%SZ`. */
function utcStamp(now: Date = new Date()): string {
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
        + `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

/** `cp -p src dst`: content, mode and times. */
function copyPreserving(src: string, dst: string): boolean {
    try {
        copyFileSync(src, dst);
        const st = statSync(src);
        try {
            utimesSync(dst, st.atime, st.mtime);
        } catch {
            // A time we could not carry is not a reason to lose the backup.
        }
        return true;
    } catch {
        return false;
    }
}

// --- the fingerprint ----------------------------------------------------------

type StatFmt = 'bsd' | 'gnu';

/**
 * One stat format, two spellings. BSD: name, mtime (integer seconds), size,
 * mode, symlink target. GNU's %N quotes the name and appends the link target,
 * which is fine here -- nothing parses the tail, only the leading path field.
 */
function statLine(path: string, fmt: StatFmt): string | null {
    let st;
    try {
        st = lstatSync(path, { bigint: true });
    } catch {
        return null;
    }
    let target = '';
    if (st.isSymbolicLink()) {
        try {
            target = readlinkSync(path);
        } catch {
            target = '';
        }
    }
    const seconds = (st.mtimeNs / 1_000_000_000n).toString();
    if (fmt === 'bsd') {
        return `${path}\t${seconds}\t${st.size}\t${st.mode.toString(8)}\t${target}`;
    }
    const quoted = st.isSymbolicLink() ? `'${path}' -> '${target}'` : `'${path}'`;
    return `${path}\t${seconds}\t${st.size}\t${st.mode.toString(16)}\t${quoted}`;
}

// --- the verb -----------------------------------------------------------------

export interface SyncCommandsIo {
    /** engine/opencode-mirror.js, loaded from the checkout rather than copied. */
    loadMirror: (root: string) => Promise<{ main: (argv: string[]) => number }>;
}

const realIo: SyncCommandsIo = {
    loadMirror: (root) => loadEngine<{ main: (argv: string[]) => number }>('opencode-mirror.js', root),
};

export async function run(args: string[], io: SyncCommandsIo = realIo): Promise<number> {
    const out = (line: string): void => {
        process.stdout.write(`${line}\n`);
    };
    const errLine = (line: string): void => {
        process.stderr.write(`${line}\n`);
    };

    // The option loop, in the shell's order: an unknown argument exits 2 before
    // anything is read, and --help answers before any env, file or engine.
    let verbose = false;
    let force = false;
    for (const arg of args) {
        if (arg === '-v' || arg === '--verbose') {
            verbose = true;
        } else if (arg === '-f' || arg === '--force') {
            force = true;
        } else if (arg === '-h' || arg === '--help') {
            process.stdout.write(helpText);
            return 0;
        } else {
            errLine(`drover-sync-commands: unknown argument '${arg}' (try --help)`);
            return 2;
        }
    }

    const say = (line: string): void => {
        if (verbose) out(line);
    };

    const env = process.env;
    const denv = droverEnv(env);
    const home = homeOf(env);
    const registry = denv.accounts;

    // `$me` is the SHELL file's realpath and `$root` its checkout, so the
    // fingerprint this writes is the one the shell file reads (divergence 4).
    const shellFile = join(denv.droverDir, 'libexec', 'drover-sync-commands');
    let me = shellFile;
    try {
        me = realpathSync(shellFile);
    } catch {
        // Not there: the fingerprint records it as missing, exactly as the
        // shell would for any other absent path.
    }
    const self = dirname(me);
    const root = dirname(self);

    const request = join(self, 'drover-flip-request');
    const todosBin = join(self, 'drover-todos');

    // The tree everything else is linked FROM: the default account, which is
    // the one `~/.shotgun` regen writes. Overridable so a test can point the
    // link pass at a fixture instead of the real ~/.claude.
    const defaultDir = env.DROVER_DEFAULT_CONFIG_DIR || accountDataDir('default', home);

    // ...and the .claude.json that tree's mcpServers are read from, which is
    // NOT inside it. Claude Code reads (CLAUDE_CONFIG_DIR || $HOME)/.claude.json
    // and the ambient account runs with the variable unset.
    const defaultConfig = defaultDir === `${home}/.claude`
        ? `${home}/.claude.json`
        : join(defaultDir, '.claude.json');

    // Where OpenCode's config lives, resolved EXACTLY as engine/mcp.js reads it
    // -- OPENCODE_CONFIG_DIR, then XDG, then ~/.config -- because the file this
    // writes is the file `drover mcps opencode` and the phone report read.
    const ocDir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
    const ocJsonc = join(ocDir, 'opencode.jsonc');
    const ocJson = join(ocDir, 'opencode.json');
    const ocTarget = present(ocJsonc) ? ocJsonc : present(ocJson) ? ocJson : ocJsonc;

    // Where `drover account login` puts a config dir it makes. Swept as well as
    // the registry, because a directory the registry has FORGOTTEN is still a
    // real config dir a `CLAUDE_CONFIG_DIR=` invocation can land on.
    const accountsHome = env.DROVER_ACCOUNTS_DIR || join(home, '.claude-accounts');

    if (!readable(registry)) {
        say(`no registry at ${registry}`);
        return 0;
    }

    // Every account's configDir SPELLING, one per line, with the omitted case
    // spelled out as "default". `(.configDir // "default")`, NOT
    // `.configDir // empty`: the second form skipped a row with no configDir
    // key and took "default" as a RELATIVE PATH.
    //
    // CURSOR ROWS ARE SKIPPED (DROVE-256). They carry no configDir, and the
    // idiom would resolve every one of them to the ambient account.
    let specsText: string;
    try {
        const doc: unknown = JSON.parse(readFileSync(registry, 'utf8'));
        // jq's `.[]?` iterates an array's elements or an object's values and
        // produces nothing for a scalar.
        const rows = Array.isArray(doc) ? doc : isObject(doc) ? Object.values(doc) : [];
        const picked: string[] = [];
        for (const row of rows) {
            // `.harness` on a non-object is a jq error, which is a `could not
            // read` and not a skipped row.
            if (!isObject(row)) throw new JqError('cannot index a non-object');
            if (String(jqAlt(row.harness, 'claude')) !== 'claude') continue;
            const spelling = jqAlt(row.configDir, 'default');
            picked.push(typeof spelling === 'string' ? spelling : JSON.stringify(spelling));
        }
        specsText = picked.join('\n').replace(/\n+$/, '');
    } catch {
        say(`could not read ${registry}`);
        return 0;
    }
    if (specsText === '') {
        say(`no accounts in ${registry}`);
        return 0;
    }
    const specs = specsText.split('\n');

    // Every account directory the registry names, resolved and absolute. The
    // registry stores the tilde form, so this is the only list that can be
    // compared against a real path.
    const registryDirs = specs
        .filter((spec) => spec !== '')
        .map((spec) => accountDataDir(spec, home))
        .filter((dir) => dir.startsWith('/'));

    // Plus the ones under $accounts_home that the registry has FORGOTTEN, but
    // only on a machine whose accounts actually live there. A throwaway
    // registry pointing at a tmpdir has no business reaching into the real
    // ~/.claude-accounts.
    const sweep = registryDirs.some((dir) => dir.startsWith(`${accountsHome}/`));

    const accountDirs: string[] = [...registryDirs];
    if (sweep) {
        for (const child of globChildren(accountsHome)) {
            if (isDir(child)) accountDirs.push(child);
        }
    }
    const accountList = [...new Set(accountDirs)].sort(byteCompare);

    // Set by any FAILED path, anywhere. It is what keeps the stamp honest: a
    // run that could not finish its work must not be remembered as one that did.
    let syncFailed = false;

    // --- the stamp: do nothing when nothing changed (DROVE-265) --------------

    const statFmt: StatFmt = process.platform === 'darwin' ? 'bsd' : 'gnu';
    const stampFile = env.DROVER_SYNC_STAMP || join(denv.stateDir, 'sync-commands.stamp');

    /** Every path the fingerprint covers, one per line, reads and writes both. */
    const fingerprintPaths = (): string[] => {
        const paths: string[] = [
            registry,
            me,
            accountsHome,
            join(defaultDir, 'settings.json'),
            defaultConfig,
            join(defaultDir, 'skills'),
            join(defaultDir, 'agents'),
            join(defaultDir, 'commands'),
            ocJsonc,
            ocJson,
            join(root, 'engine', 'opencode-mirror.js'),
        ];
        for (const entry of globChildren(join(defaultDir, 'commands'))) {
            if (present(entry)) paths.push(entry);
        }
        for (const dir of accountList) {
            if (dir === '') continue;
            paths.push(
                join(dir, 'settings.json'),
                join(dir, '.claude.json'),
                join(dir, 'skills'),
                join(dir, 'agents'),
                join(dir, 'commands'),
                join(dir, 'commands', 'flip.md'),
                join(dir, 'commands', 'todos.md'),
            );
        }
        return paths;
    };

    /**
     * A header carrying the values baked INTO the command files, then one
     * tab-separated line per path. A path that does not exist is emitted as
     * `<path>\t-` rather than left out, so a file appearing and a file
     * vanishing are both a CHANGED LINE for that path.
     */
    const fingerprint = (): string => {
        const lines: string[] = [
            `header\tv2\t${defaultDir}\t${accountsHome}\t${request}\t${todosBin}\t${sweep ? '1' : ''}\t${ocTarget}`,
        ];
        const found: string[] = [];
        for (const path of fingerprintPaths()) {
            if (path === '') continue;
            if (present(path)) {
                found.push(path);
            } else {
                lines.push(`${path}\t-`);
            }
        }
        for (const path of found) {
            const line = statLine(path, statFmt);
            if (line !== null) lines.push(line);
        }
        return lines.join('\n').replace(/\n+$/, '');
    };

    // What this run must do, and it starts WIDE OPEN. Every path that fails to
    // narrow it falls through with all of them still set, because a slow sync
    // is an annoyance and a skipped repair is a session with no MCP servers.
    //
    // Two variables per pass rather than one holding either "all" or a list:
    // the one-variable form appends a path onto the word `all` and the list
    // match then silently stops finding the FIRST entry.
    let allSettings = true;
    let allConfig = true;
    let doTree = true;
    let doOpencode = true;
    const listSettings: string[] = [];
    const listConfig: string[] = [];

    const nowPrint = force ? '' : fingerprint();
    if (nowPrint !== '' && readable(stampFile)) {
        let wasPrint = '';
        try {
            wasPrint = readFileSync(stampFile, 'utf8').replace(/\n+$/, '');
        } catch {
            wasPrint = '';
        }
        if (wasPrint !== '') {
            if (nowPrint === wasPrint) {
                // The whole point. One stat pass, one string compare, done.
                say('unchanged since the last run -- nothing to do');
                return 0;
            }
            // Something moved. Sort the lines that differ back to the pass and
            // the account they belong to; a path that vanished shows up as its
            // `<path>\t-` line.
            const seen = new Set(wasPrint.split('\n'));
            const changed = nowPrint.split('\n')
                .filter((line) => !seen.has(line))
                .map((line) => line.split('\t')[0]);
            if (changed.length > 0) {
                doTree = false;
                allSettings = false;
                allConfig = false;
                doOpencode = false;
                const mirrorJs = join(root, 'engine', 'opencode-mirror.js');
                for (const chPath of changed) {
                    if (chPath === '') continue;
                    const slash = chPath.lastIndexOf('/');
                    const chBase = slash < 0 ? chPath : chPath.slice(slash + 1);
                    const chDir = slash < 0 ? chPath : chPath.slice(0, slash);
                    if (chPath === 'header' || chPath === registry || chPath === me || chPath === accountsHome) {
                        // The account LIST, or the paths baked into the command
                        // files, may have changed. Every pass is open.
                        doTree = true;
                        allSettings = true;
                        allConfig = true;
                        doOpencode = true;
                    } else if (chPath === defaultConfig) {
                        // The one source both mirrors read.
                        allConfig = true;
                        doOpencode = true;
                    } else if (chPath === ocJsonc || chPath === ocJson || chPath === mirrorJs) {
                        // The opencode TARGET drifted, or the converter changed.
                        doOpencode = true;
                    } else if (chPath.startsWith(`${defaultDir}/`)) {
                        // The tree everything is copied and linked FROM.
                        if (chBase === 'settings.json') allSettings = true;
                        else doTree = true;
                    } else if (chBase === 'settings.json') {
                        listSettings.push(chDir);
                    } else if (chBase === '.claude.json') {
                        listConfig.push(chDir);
                    } else if (
                        chBase === 'skills' || chBase === 'agents' || chBase === 'commands'
                        || chBase === 'flip.md' || chBase === 'todos.md'
                    ) {
                        doTree = true;
                    } else {
                        // A path added to fingerprintPaths without teaching this
                        // branch about it. Do everything rather than guess.
                        doTree = true;
                        allSettings = true;
                        allConfig = true;
                        doOpencode = true;
                    }
                }
            }
        }
    }

    const needsMerge = (all: boolean, list: string[], dir: string): boolean => all || list.includes(dir);

    // --- the command files ---------------------------------------------------

    const rendered = render(request).replace(/\n+$/, '');
    const renderedTodos = renderTodos(todosBin).replace(/\n+$/, '');
    if (doTree) {
        for (const spec of specs) {
            if (spec === '') continue;
            // One resolver for every spelling: "default"/"ambient"/"~"/omitted
            // all mean ~/.claude, a leading ~/ expands, anything else is taken
            // as given.
            const dir = accountDataDir(spec, home);
            // A relative path here can only be a typo. It would plant commands/
            // under whatever directory the session happened to start in.
            if (!dir.startsWith('/')) {
                errLine(`drover-sync-commands: skipping configDir '${spec}' — not an absolute path`);
                continue;
            }
            if (!isDir(join(dir, 'commands')) && !mkdirp(join(dir, 'commands'))) {
                say(`skipped ${dir} (could not create commands/)`);
                syncFailed = true;
                continue;
            }
            // Idempotent: rewritten only when the content differs. The unchanged
            // case is an if rather than an early exit — that is exactly how a
            // second command added to this loop would have stopped being written.
            for (const [name, text] of [['flip.md', rendered], ['todos.md', renderedTodos]] as const) {
                const target = join(dir, 'commands', name);
                let current: string | null = null;
                if (readable(target)) {
                    try {
                        current = readFileSync(target, 'utf8');
                    } catch {
                        current = null;
                    }
                }
                if (current === `${text}\n`) {
                    say(`unchanged ${target}`);
                    continue;
                }
                try {
                    writeFileSync(target, `${text}\n`, 'utf8');
                    say(`wrote ${target}`);
                } catch {
                    say(`FAILED ${target}`);
                    syncFailed = true;
                }
            }
        }
    }

    // --- the shared trees ----------------------------------------------------
    //
    // See the shell file's header for WHY this is symlinks. What follows is only
    // the shape. Every branch that is not "make it" is a KEPT, never a remove.

    const linkOne = (src: string, dst: string): void => {
        if (!exists(src)) return;
        if (isLink(dst)) {
            let target = '';
            try {
                target = readlinkSync(dst);
            } catch {
                target = '';
            }
            if (target === src) say(`already linked ${dst}`);
            else say(`kept ${dst} (a symlink of its own)`);
            return;
        }
        if (exists(dst)) {
            say(`kept ${dst} (this account has its own)`);
            return;
        }
        try {
            symlinkSync(src, dst);
            say(`linked ${dst} -> ${src}`);
        } catch {
            say(`FAILED ${dst}`);
            syncFailed = true;
        }
    };

    const linkShared = (dir: string): void => {
        // The source is not linked to itself. The registry names the default
        // account like any other, so this is reached on every real machine.
        if (dir === defaultDir) return;
        if (!isDir(dir)) return;
        for (const tree of ['skills', 'agents']) {
            linkOne(join(defaultDir, tree), join(dir, tree));
        }
        // commands/ stays a REAL directory: flip.md and todos.md were written
        // into it above, per account, and a whole-directory symlink would bury
        // them.
        if (!isDir(join(defaultDir, 'commands'))) return;
        if (!isDir(join(dir, 'commands')) && !mkdirp(join(dir, 'commands'))) return;
        for (const entry of globChildren(join(defaultDir, 'commands'))) {
            if (!exists(entry)) continue;
            const base = entry.slice(entry.lastIndexOf('/') + 1);
            // drover's own two are written, not linked.
            if (base === 'flip.md' || base === 'todos.md') continue;
            linkOne(entry, join(dir, 'commands', base));
        }
    };

    // --- hooks and permissions (DROVE-249) -----------------------------------

    /** The document a `--slurpfile` of that path would have produced. */
    const slurpOne = (path: string | null): unknown => {
        if (path === null) return null;
        const text = readFileSync(path, 'utf8');
        if (text.trim() === '') return null;
        return JSON.parse(text) as unknown;
    };

    const backup = (dst: string, dir: string, prefix: string): void => {
        const bak = join(dir, 'drover-backups');
        if (!mkdirp(bak) || !copyPreserving(dst, join(bak, `${prefix}.${utcStamp()}.json`))) {
            say(`no backup for ${dst}`);
        }
    };

    let settingsSrcOk = false;
    let configSrcOk = false;
    let defaultSettingsDoc: unknown = null;
    let defaultConfigDoc: unknown = null;

    const mergeSettings = (dir: string): void => {
        // The source is never a target. ~/.claude/settings.json is
        // rulesync-generated -- writing it back is how enabledPlugins has been
        // lost before.
        if (dir === defaultDir) return;
        if (!isDir(dir)) return;
        // The source is read once per RUN, not once per account.
        if (!settingsSrcOk) return;
        const dst = join(dir, 'settings.json');
        // A missing file is an empty object, which is how a brand-new account
        // gets the gates on its very first session.
        const cur = exists(dst) ? dst : null;
        let merged: Record<string, unknown> | undefined;
        try {
            merged = settingsMerge(defaultSettingsDoc, slurpOne(cur));
        } catch {
            say(`kept ${dst} (it does not parse -- refusing to rewrite it)`);
            return;
        }
        // No output means the merge would change nothing. Most runs stop here.
        if (merged === undefined) {
            say(`unchanged ${dst}`);
            return;
        }
        if (exists(dst)) backup(dst, dir, 'settings');
        try {
            jsonWrite(dst, merged);
            say(`merged ${dst}`);
        } catch {
            say(`FAILED ${dst}`);
            syncFailed = true;
        }
    };

    // --- mcpServers (DROVE-252) ----------------------------------------------

    const mergeConfig = (dir: string): void => {
        if (dir === defaultDir) return;
        if (!isDir(dir)) return;
        if (!readable(defaultConfig)) return;
        const dst = join(dir, '.claude.json');
        if (dst === defaultConfig) return;
        // Whether the source has any servers at all was settled once per run.
        if (!configSrcOk) return;
        const cur = exists(dst) ? dst : null;
        let merged: Record<string, unknown> | undefined;
        try {
            merged = configMerge(defaultConfigDoc, slurpOne(cur));
        } catch {
            say(`kept ${dst} (it does not parse -- refusing to rewrite it)`);
            return;
        }
        if (merged === undefined) {
            say(`unchanged ${dst}`);
            return;
        }
        if (exists(dst)) backup(dst, dir, 'claude');
        try {
            jsonWrite(dst, merged);
            // jsonWrite inherits the mode of a file that was already there. One
            // this CREATED would take the umask instead, and a server definition
            // carries that server's env -- tokens included -- so a file drover
            // made starts private.
            if (cur === null) {
                try {
                    chmodSync(dst, 0o600);
                } catch {
                    // Best effort, exactly as `chmod 600 ... || :`.
                }
            }
            say(`mirrored ${dst}`);
        } catch {
            say(`FAILED ${dst}`);
            syncFailed = true;
        }
    };

    // --- opencode (DROVE-292) ------------------------------------------------
    //
    // The same source, one more consumer. The conversion, the ${VAR}->{env:VAR}
    // rewrite, the by-name skip of what cannot translate and the byte-for-byte
    // preservation of everything outside the `mcp` block are all in
    // engine/opencode-mirror.js, which is LOADED rather than translated.
    //
    // `note:` lines print even without -v -- the mirror overwriting somebody's
    // edit is worth a line on the next session start, once, which is what the
    // state file makes "once" mean.
    const mirrorOpencode = async (): Promise<void> => {
        let captured = '';
        let code: number;
        const outWrite = process.stdout.write.bind(process.stdout);
        const errWrite = process.stderr.write.bind(process.stderr);
        try {
            const mirror = await io.loadMirror(root);
            // The engine writes its report; the shell read it off a pipe and
            // discarded stderr. Both are swapped for the duration of the call,
            // which is synchronous, so nothing else can interleave.
            (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
                captured += String(c);
                return true;
            };
            (process.stderr as unknown as { write: (c: string) => boolean }).write = () => true;
            try {
                code = mirror.main(['--source', defaultConfig, '--target', ocTarget, '--state', `${stampFile}.opencode`]);
            } finally {
                (process.stdout as unknown as { write: typeof outWrite }).write = outWrite;
                (process.stderr as unknown as { write: typeof errWrite }).write = errWrite;
            }
        } catch {
            say(`FAILED ${ocTarget}`);
            syncFailed = true;
            return;
        }
        if (code !== 0) {
            say(`FAILED ${ocTarget}`);
            syncFailed = true;
            return;
        }
        for (const line of captured.replace(/\n+$/, '').split('\n')) {
            if (line === '') continue;
            if (line.startsWith('note:')) out(line);
            else say(line);
        }
    };

    if (isDir(defaultDir)) {
        // Both sources are the same file for every account, so they are read
        // ONCE here rather than eleven times inside the loop.
        const srcSettings = join(defaultDir, 'settings.json');
        if (readable(srcSettings)) {
            try {
                const doc = JSON.parse(readFileSync(srcSettings, 'utf8')) as unknown;
                // `jq -e .` exits 1 on a document that is null or false, and the
                // shell treats that exit as "does not parse".
                if (doc === null || doc === false) throw new JqError('null or false');
                defaultSettingsDoc = doc;
                settingsSrcOk = true;
            } catch {
                say("skipped settings (the default tree's settings.json does not parse)");
            }
        }
        // PRESENCE of mcpServers, not its value: the merge compares for itself,
        // and a default tree with no such key says nothing and mirrors nothing.
        if (readable(defaultConfig)) {
            try {
                const doc = JSON.parse(readFileSync(defaultConfig, 'utf8')) as unknown;
                // `has("mcpServers")` is an error on anything but an object.
                if (!isObject(doc)) throw new JqError('has() on a non-object');
                defaultConfigDoc = doc;
                if (Object.prototype.hasOwnProperty.call(doc, 'mcpServers')) configSrcOk = true;
            } catch {
                say("skipped mcpServers (the default account's .claude.json does not parse)");
            }
        }
        for (const dir of accountList) {
            if (dir === '') continue;
            if (doTree) linkShared(dir);
            if (needsMerge(allSettings, listSettings, dir)) mergeSettings(dir);
            if (needsMerge(allConfig, listConfig, dir)) mergeConfig(dir);
        }
        // A FIXTURE default tree must never mirror onto the REAL opencode
        // config. Gated on configSrcOk for the same reason as mergeConfig: a
        // source with no mcpServers says nothing, and emptying the target
        // because the source was mid-write is the original bug inverted.
        if ((env.DROVER_DEFAULT_CONFIG_DIR ?? '') !== '' && (env.OPENCODE_CONFIG_DIR ?? '') === '') {
            doOpencode = false;
        }
        if (doOpencode && configSrcOk) await mirrorOpencode();
    } else {
        say(`no default tree at ${defaultDir} -- nothing to link from`);
        syncFailed = true;
    }

    // The stamp, and only after a clean run. A run that logged a single FAILED
    // has left the tree in a state it cannot describe, so it records nothing and
    // the next start does the whole pass again -- late is recoverable,
    // "remembered as done" is not.
    //
    // Re-fingerprinted rather than reusing the print taken at the top, because
    // this run has just WRITTEN some of those paths and their mtimes have moved.
    if (!syncFailed) {
        const slash = stampFile.lastIndexOf('/');
        const stampDir = slash < 0 ? '.' : stampFile.slice(0, slash);
        if (isDir(stampDir) || mkdirp(stampDir)) {
            const endPrint = fingerprint();
            try {
                writeFileSync(stampFile, `${endPrint}\n`, 'utf8');
            } catch {
                say(`no stamp at ${stampFile}`);
            }
        }
    }

    return 0;
}
