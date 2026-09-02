/**
 * `drover clone` — start a NEW session in another harness, seeded with this
 * one's conversation (DROVE-58, DROVE-337's `--seed`), in node (DROVE-315).
 *
 * A straight port of cattle-drover/libexec/drover-clone. Clay: "when dealing
 * with different harnesses you can't flip between them, but we should be able
 * to clone a session into another harness."
 *
 * A FLIP works only because two Claude accounts read the same transcript file —
 * one shared session store since DROVE-40 — so the conversation is carried
 * rather than retold, and the session id the phone watches never changes. No
 * other harness can read a Claude transcript, so there is nothing to carry.
 * A CLONE is therefore a different thing wearing a different word: a NEW
 * session, in whatever harness, started with a SUMMARY of an old one. The seed
 * says so in its first paragraph, because a clone that believes it is a
 * continuation answers confidently from context it does not have.
 *
 * ONE MODE still holds (DROVE-1). The clone is a real TUI in a real tmux
 * window, exactly like every other session. With no tmux to open a window in,
 * this FAILS and says why; it does not quietly produce a second kind of
 * session that the terminal can never see.
 *
 * WHAT NODE CHANGES. The registry lookup was `curl | jq`; here it is one fetch
 * and JSON.parse, through an injectable port so a test never reaches a bus.
 * The ledger was `jq` plus lib/drover-json.sh; here it is JSON.parse and an
 * atomic temp-file-then-rename, the same contract. The EXPORT stays a
 * shell-out: engine/export.js is cattle-drover's, not this fork's, and the
 * seed it writes is the whole point of the verb.
 *
 * Two things the shell did that node does not need, and so does not do: the
 * two `jq is required to …` refusals (there is no jq on this path any more),
 * and the bare `[ -z "$TMUX" ]` test, which ./harness/tmuxEntry's header
 * documents as wrong on this machine — a pane on drover's own `-L drover-login`
 * server sets $TMUX and is not a home for a session. droverTmuxHavePane answers
 * the question the shell meant to ask, and answers it the same way for every
 * case the bats suite pins.
 *
 * Help answers before anything else — no env read, no file, no bus — the way
 * the shell answered it before `set -e` reached a single stat.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { droverEnv } from './env';
import { droverTmuxHavePane, shQuote, type Env } from './harness/tmuxEntry';

const HELP = `drover clone — seed a NEW session in another harness with this one's
conversation. A flip moves a session between ACCOUNTS; a clone copies its
context into another HARNESS, which cannot read a Claude transcript at all.

USAGE
  drover clone                      This tmux pane's session, into Claude
  drover clone <session>            That session (id or id prefix)
  drover clone <session> --to claude|opencode|cursor|pi

OPTIONS
  --to <harness>        where it lands (default claude)
  --turns <n>           newest N turns (default 40; 0 = the whole read window)
  --transcript <file>   export this file instead of asking the bus. The way to
                        export a session the bus has never seen.
  --cwd <dir>           working directory for the clone and for the diff
  --account <name>      account the clone starts on (default: drover decides)
  --no-diff             leave the working-tree diff out of the seed
  --print               write the seed to stdout and open nothing
  --seed-only           write the seed file, print its path, open nothing

WHAT IS IN THE SEED
  Every user and assistant turn as text, oldest-first, capped to the newest N
  with the cap stated in the seed. One line per tool CALL. The working-tree
  diff at the end, because where the tree sits now is the state — the edit
  history is noise. Never thinking, never tool output, never attachments.

LINEAGE
  Both halves are recorded in one ledger, so \`drover sessions\` and the app show
  cloned-from on the new session and cloned-to on the old one. The clone fills
  in its own id the first time it speaks.

  drover clone --list               every clone this machine has made

See also: drover flip (same session, another account) · docs/clone.md
`;

// --- the harness seam --------------------------------------------------------
//
// Everything harness-specific is these two functions, so a new harness is two
// cases rather than a second copy of this file.
//
// NOTHING SITS IN THE REFUSING CASE ANY MORE. Every named harness has a real
// command below; only an unknown one is turned away.
//
// The RULE that put harnesses there stands, because it is why the case existed.
// Never guess at a CLI we have not driven. Clay: "if you have to fall back then
// things aren't set up correctly in the first place". The failure mode is the
// worst one available: a window opens, a harness starts with no context at all,
// and success is reported over the top of it. So a harness earns its case
// by having a seeded start built for it, one at a time. opencode left the
// refusing case in DROVE-56, pi in DROVE-295, cursor in DROVE-337. A harness
// added later starts back in it.

export const knownHarnesses = ['claude', 'opencode', 'cursor', 'pi'] as const;

export function harnessKnown(name: string): boolean {
    return (knownHarnesses as readonly string[]).includes(name);
}

/**
 * The pane's command for that harness, or null when it is not one we drive —
 * the caller prints the reason, exactly as the shell's `return 2` arm did.
 *
 * `--seed` is the ONE contract all four share: the FLAG travels through the
 * account picker and the `drover account use` re-entry, and only the final exec
 * expands the file into the session's first prompt. The seed is tens of
 * kilobytes, so it must not ride in a tmux command line where one stray quote
 * turns it into a syntax error.
 */
export function harnessCommand(harness: string, seed: string, root: string): string | null {
    const drover = shQuote(join(root, 'bin', 'drover'));
    const file = shQuote(seed);
    switch (harness) {
        case 'claude':
            return `exec ${drover} --seed ${file}`;
        case 'opencode':
            // DROVE-56 built this lane. `drover opencode --seed <file>` starts a
            // real OpenCode TUI in the pane and the bridge submits the seed as
            // that session's first prompt once it owns it — over OpenCode's own
            // API, so nothing is typed into the pane.
            return `exec ${drover} opencode --seed ${file}`;
        case 'pi':
            // DROVE-295 built this lane. `drover pi --seed <file>` hands the file
            // to adapters/pi-bridge.mjs, which submits it as the session's first
            // prompt over pi's own rpc protocol once the session is registered.
            //
            // Worth knowing what a clone INTO pi means: the retold conversation
            // is read by whatever LOCAL model is in force, which has a smaller
            // context window than the cloud harnesses. A long clone will compact
            // rather than fail, but it will compact sooner.
            return `exec ${drover} pi --seed ${file}`;
        case 'cursor':
            // DROVE-337 built this lane. `drover cursor --seed <file>` hands the
            // file to the fork CLI's cursor runner, which submits it as the
            // session's first turn.
            //
            // Worth knowing what a clone INTO cursor means: the model is NOT
            // picked for you. Measured, and carried in libexec/drover-cursor's
            // own header: `cursor-agent --model X` does not scope X to the run,
            // it WRITES X into ~/.cursor/cli-config.json as the machine-wide
            // default, IDE included. A clone that chose a model would be
            // choosing it for every later Cursor session on this Mac, so it
            // chooses none and the clone starts on whatever that login already
            // defaults to. Change it from the app's model picker, which is
            // scoped to the session.
            return `exec ${drover} cursor --seed ${file}`;
        default:
            return null;
    }
}

// --- what the verb asks the machine ------------------------------------------

/** One row of GET /v1/sessions, as much of it as this verb reads. */
export interface BusSession {
    id?: unknown;
    transcript?: unknown;
    cwd?: unknown;
    account?: unknown;
    pane?: unknown;
    paneAmbiguous?: unknown;
    lastActivity?: unknown;
}

/**
 * Everything that is not argv, injected. The default reaches the real machine;
 * a test hands in ports that answer from fixtures or throw, which is how "no
 * live bus, no live tmux, no real export" is proven rather than promised.
 */
export interface CloneIo {
    env: Env;
    /** $PWD, for `${cwd:-$PWD}`. */
    cwd: string;
    /** `$$`, the second half of the clone id. */
    pid: number;
    now: () => Date;
    out: (text: string) => void;
    err: (text: string) => void;
    /**
     * `curl -sS -m 10 "$DROVER_URL/v1/sessions?limit=200"` — the body as text,
     * throwing ONLY on a transport failure. curl without -f answers 0 for a
     * 404 too, and the shell then let jq find nothing; a body that does not
     * parse is not an unreachable bus.
     */
    sessions: (url: string) => Promise<string>;
    /** `node <root>/engine/export.js <args>`, stdio inherited; its exit code. */
    exportSeed: (root: string, args: string[]) => number;
    /** `tmux <args>`, stdio inherited; its exit code. */
    tmux: (args: string[]) => number;
}

function passthrough(bin: string, argv: string[]): number {
    const r = spawnSync(bin, argv, { stdio: 'inherit' });
    if (r.error) return 1;
    return r.status ?? 1;
}

export function defaultIo(): CloneIo {
    return {
        env: process.env,
        cwd: process.cwd(),
        pid: process.pid,
        now: () => new Date(),
        out: (text) => {
            process.stdout.write(text);
        },
        err: (text) => {
            process.stderr.write(text);
        },
        sessions: async (url) => {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            return res.text();
        },
        exportSeed: (root, args) => passthrough('node', [join(root, 'engine', 'export.js'), ...args]),
        tmux: (args) => passthrough('tmux', args),
    };
}

// --- arguments ---------------------------------------------------------------

export type CloneMode = 'open' | 'print' | 'seed' | 'list';

export interface CloneOptions {
    sess: string;
    to: string;
    turns: string;
    transcript: string;
    cwd: string;
    account: string;
    /** '--no-diff' or '', spliced into the export argv the way the shell did. */
    diffFlag: string;
    mode: CloneMode;
    /** Set when the loop hit -h/--help or an unknown option. */
    stop?: { help: boolean; error?: string; code: number };
}

/** The shell's `while [ $# -gt 0 ]` loop, case for case. */
export function parseArgs(args: string[]): CloneOptions {
    const o: CloneOptions = {
        sess: '',
        to: 'claude',
        turns: '40',
        transcript: '',
        cwd: '',
        account: '',
        diffFlag: '',
        mode: 'open',
    };
    let i = 0;
    const value = (): string => args[i + 1] ?? '';
    while (i < args.length) {
        const a = args[i];
        if (a === '--to') {
            o.to = value();
            i += 2;
        } else if (a.startsWith('--to=')) {
            o.to = a.slice('--to='.length);
            i += 1;
        } else if (a === '--turns') {
            o.turns = value();
            i += 2;
        } else if (a === '--transcript') {
            o.transcript = value();
            i += 2;
        } else if (a === '--cwd') {
            o.cwd = value();
            i += 2;
        } else if (a === '--account') {
            o.account = value();
            i += 2;
        } else if (a === '--no-diff') {
            o.diffFlag = '--no-diff';
            i += 1;
        } else if (a === '--print') {
            o.mode = 'print';
            i += 1;
        } else if (a === '--seed-only') {
            o.mode = 'seed';
            i += 1;
        } else if (a === '--list') {
            o.mode = 'list';
            i += 1;
        } else if (a === '-h' || a === '--help') {
            o.stop = { help: true, code: 0 };
            return o;
        } else if (a.startsWith('-')) {
            o.stop = { help: false, error: `drover clone: unknown option ${a} (try --help)`, code: 2 };
            return o;
        } else {
            o.sess = a;
            i += 1;
        }
    }
    return o;
}

// --- the ledger --------------------------------------------------------------

/** One row of $STATE_DIR/clones.json, as this verb writes it. */
export interface CloneRow {
    id: string;
    at: string;
    from: string;
    /** null until the clone speaks: its own session id does not exist yet. */
    to: string | null;
    harness: string;
    cwd: string;
    account: string | null;
    seed: string;
    turns: number;
}

/**
 * The `--list` report, the jq program line for line. `.from[0:8] // "?"` slices
 * first and falls back second, so a row with no `from` prints `?`; a `to` that
 * is null is the row still waiting for its clone to speak.
 */
export function renderCloneList(rows: readonly unknown[]): string[] {
    if (rows.length === 0) return ['no clones yet'];
    return rows.map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
        const at = str(r.at) ?? '?';
        const from = str(r.from);
        const to = str(r.to);
        const harness = str(r.harness) ?? '?';
        const cwd = str(r.cwd) ?? '?';
        return `${at}  ${from === null ? '?' : from.slice(0, 8)} -> ${to === null ? '(not started yet)' : to.slice(0, 8)}  ${harness}  ${cwd}`;
    });
}

/**
 * json_read's contract: the file's rows, or [] when it is missing. A file that
 * exists but does not parse is NOT silently replaced by an empty list — that
 * would discard the ledger on a typo — so it answers null and the caller stops.
 */
function readLedger(path: string, io: CloneIo): unknown[] | null {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return [];
    }
    try {
        const v: unknown = JSON.parse(text);
        if (!Array.isArray(v)) throw new Error('not an array');
        return v;
    } catch {
        io.err(`drover: ${path} is not valid JSON — refusing to rewrite it\n`);
        return null;
    }
}

/**
 * json_write's contract: a temp file BESIDE the target, then a rename, because
 * rename is the only atomic operation a filesystem gives us. The temp inherits
 * the target's mode where there is one, so a replacement never widens a private
 * file to whatever the umask says.
 */
function writeLedger(path: string, rows: readonly unknown[], pid: number): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.drover-${pid}.json`);
    writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`);
    try {
        chmodSync(tmp, statSync(path).mode & 0o7777);
    } catch {
        // No target yet, or a mode we cannot read: the default is right.
    }
    renameSync(tmp, path);
}

// --- helpers -----------------------------------------------------------------

/** `[ -r <path> ]`. */
function readable(path: string): boolean {
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function say(io: CloneIo, lines: string[]): void {
    io.out(`${lines.join('\n')}\n`);
}

function complain(io: CloneIo, lines: string[]): void {
    io.err(`${lines.join('\n')}\n`);
}

/** `date -u +%Y%m%dT%H%M%SZ` and `date -u +%Y-%m-%dT%H:%M:%SZ`, one clock read. */
function stamps(now: Date): { compact: string; iso: string } {
    const s = now.toISOString().slice(0, 19);
    return { compact: `${s.replace(/[-:]/g, '')}Z`, iso: `${s}Z` };
}

// --- the verb ----------------------------------------------------------------

export async function run(args: string[], io: CloneIo = defaultIo()): Promise<number> {
    const o = parseArgs(args);
    if (o.stop) {
        if (o.stop.help) {
            io.out(HELP);
            return 0;
        }
        complain(io, [o.stop.error ?? '']);
        return o.stop.code;
    }

    const denv = droverEnv(io.env);
    const root = denv.droverDir;
    const stateDir = denv.stateDir;
    const ledger = join(stateDir, 'clones.json');

    if (o.mode === 'list') {
        if (!readable(ledger)) {
            say(io, ['no clones yet']);
            return 0;
        }
        const rows = readLedger(ledger, io);
        if (rows === null) return 1;
        say(io, renderCloneList(rows));
        return 0;
    }

    if (!/^[0-9]+$/.test(o.turns)) {
        complain(io, [`drover clone: --turns needs a number, got '${o.turns}'`]);
        return 2;
    }

    if (!harnessKnown(o.to)) {
        complain(io, [`drover clone: unknown harness '${o.to}' (claude, opencode, cursor, pi)`]);
        return 2;
    }

    // --- which session -------------------------------------------------------
    //
    // The registry is the ONE thing that maps a session id to the transcript on
    // disk, and asking it is not optional: a scan of ~/.claude/projects here
    // would be a second, worse copy of a thing the bus already does with bounds
    // (engine/registry.js, BASED-110). `--transcript` is not a fallback for the
    // bus being down — it is the way to export a file the bus has never seen.

    let sess = o.sess;
    let transcript = o.transcript;
    let cwd = o.cwd;
    let srcAccount: string;

    if (!transcript) {
        let body: string;
        try {
            body = await io.sessions(`${denv.droverUrl}/v1/sessions?limit=200`);
        } catch {
            complain(io, [
                `drover clone: the bus is unreachable at ${denv.droverUrl}, so there is no way`,
                '  to look a session id up. Start it (drover status), or name the file:',
                '  drover clone --transcript <path/to/session.jsonl> --cwd <dir>',
            ]);
            return 1;
        }
        // jq's `2>/dev/null || match=`: a body that is not the shape we asked
        // for yields no matches, which is a different sentence from an
        // unreachable bus and must stay one.
        let all: BusSession[] = [];
        try {
            const parsed = JSON.parse(body) as { sessions?: unknown };
            if (Array.isArray(parsed?.sessions)) all = parsed.sessions as BusSession[];
        } catch {
            all = [];
        }

        const pane = io.env.TMUX_PANE ?? '';
        let match: BusSession[];
        if (sess) {
            match = all.filter((s) => typeof s.id === 'string' && s.id.startsWith(sess));
        } else if (pane) {
            match = all.filter((s) => s.pane === pane && s.paneAmbiguous !== true);
        } else {
            complain(io, [
                'drover clone: no session named and not inside tmux, so there is no',
                '  pane to read one from. Name it: drover clone <session id>',
                '  (drover sessions lists them)',
            ]);
            return 2;
        }
        // `sort_by(-.lastActivity)`: newest first, and stable, so rows the bus
        // gave no activity for keep the order it sent them in.
        const activity = (s: BusSession): number => (typeof s.lastActivity === 'number' ? s.lastActivity : 0);
        match = match.slice().sort((a, b) => activity(b) - activity(a));

        if (match.length === 0) {
            if (sess) {
                complain(io, [`drover clone: the bus knows no session starting '${sess}'`]);
            } else {
                complain(io, [
                    `drover clone: the bus binds no session to this pane (${pane || '?'}).`,
                    '  A session started with plain `claude` is not in the registry;',
                    '  name one with `drover clone <id>` (drover sessions lists them).',
                ]);
            }
            return 1;
        }
        // Several matches on a prefix is ambiguous, and a clone of the wrong
        // conversation is a plausible-looking waste of a whole session. Say which.
        if (sess && match.length > 1) {
            complain(io, [
                `drover clone: '${sess}' matches ${match.length} sessions:`,
                ...match.map((s) => `  ${String(s.id)}  ${typeof s.cwd === 'string' && s.cwd ? s.cwd : '?'}`),
            ]);
            return 2;
        }
        const row = match[0];
        sess = typeof row.id === 'string' ? row.id : '';
        transcript = typeof row.transcript === 'string' ? row.transcript : '';
        if (!cwd) cwd = typeof row.cwd === 'string' ? row.cwd : '';
        srcAccount = typeof row.account === 'string' ? row.account : '';
        if (!transcript) {
            complain(io, [
                `drover clone: session ${sess} has written no transcript yet, so there is`,
                '  no conversation to clone. Say something to it first.',
            ]);
            return 1;
        }
    } else {
        srcAccount = io.env.DROVER_ACCOUNT ?? '';
        if (!sess) sess = basename(transcript, '.jsonl');
    }

    if (!readable(transcript)) {
        complain(io, [`drover clone: cannot read the transcript at ${transcript}`]);
        return 1;
    }

    // --- export --------------------------------------------------------------

    const clock = stamps(io.now());
    const cloneId = `${clock.compact}-${io.pid}`;
    const seed = join(stateDir, 'clones', `${cloneId}.md`);

    // Built as a LIST rather than the shell's `${var:+--flag "$var"}`, which was
    // unquoted at expansion time: a working directory with a space in it became
    // two arguments and the export ran against a path that does not exist.
    const argv = ['--transcript', transcript, '--turns', o.turns, '--session', sess, '--to', o.to];
    if (cwd) argv.push('--cwd', cwd);
    if (srcAccount) argv.push('--account', srcAccount);
    if (o.diffFlag) argv.push(o.diffFlag);

    if (o.mode === 'print') {
        return io.exportSeed(root, argv);
    }

    mkdirSync(join(stateDir, 'clones'), { recursive: true });
    const exported = io.exportSeed(root, [...argv, '--out', seed]);
    if (exported !== 0) return exported;

    if (o.mode === 'seed') {
        io.out(`${seed}\n`);
        return 0;
    }

    // The pane command comes BEFORE the ledger row, so a harness that is turned
    // away leaves no clone recorded that never happened.
    let paneCmd = harnessCommand(o.to, seed, root);
    if (paneCmd === null) {
        complain(io, [`drover clone: unknown harness '${o.to}' (claude, opencode, cursor, pi)`]);
        return 2;
    }
    // An explicit account is the human overruling the picker, exactly as it is
    // for a normal start, so it rides as the flag rather than as an environment
    // stamp: `drover account use` is the ONE place that sets or unsets
    // CLAUDE_CONFIG_DIR, and a bare DROVER_ACCOUNT in the pane would name an
    // account without moving the config dir to match it.
    if (o.account) paneCmd = `${paneCmd} --account ${shQuote(o.account)}`;

    // --- the window ----------------------------------------------------------
    //
    // ONE MODE (DROVE-1): a session is a real Claude Code TUI in a tmux window.
    // A clone is a session, so the same rule applies to it, and the same refusal.
    if (!droverTmuxHavePane(io.env)) {
        complain(io, [
            'drover clone: not inside tmux — a clone is a real session, so it needs a',
            '  window to be a session IN (DROVE-1). The seed is written:',
            `    ${seed}`,
            '',
            '  Start tmux and run this again, or start the harness yourself with it.',
        ]);
        return 3;
    }

    // --- lineage -------------------------------------------------------------
    //
    // ONE ledger, both directions. The row is written with `to: null` because
    // the clone's own session id does not exist yet — Claude Code allocates it
    // at startup, inside the window we are about to open. The new pane carries
    // DROVER_CLONE_ID, its SessionStart hook already forwards its own
    // environment to the bus (adapters/claude-session.sh), and the bus closes
    // the row the first time the clone speaks. Nothing here polls and nothing
    // here guesses.
    const rows = readLedger(ledger, io);
    if (rows === null) return 1;
    const row: CloneRow = {
        id: cloneId,
        at: clock.iso,
        from: sess,
        to: null,
        harness: o.to,
        cwd: cwd || io.cwd,
        account: srcAccount === '' ? null : srcAccount,
        seed,
        turns: Number(o.turns),
    };
    // Newest last, and bounded: this is a log of a rare action, not a metric.
    writeLedger(ledger, [...rows, row].slice(-200), io.pid);

    const targetDir = cwd || io.cwd;
    const name = basename(targetDir) || 'clone';

    if (io.env.DROVER_DRY_RUN) {
        io.out(`tmux new-window -c ${targetDir} -n clone-${name} -e DROVER_CLONE_ID=${cloneId} ${paneCmd}\n`);
        return 0;
    }

    // `-e` needs tmux 3.2+; every drover machine has it because the daemon's
    // spawn path already relies on it (tmuxSpawn.ts).
    const opened = io.tmux([
        'new-window',
        '-c',
        targetDir,
        '-n',
        `clone-${name}`,
        '-e',
        `DROVER_CLONE_ID=${cloneId}`,
        paneCmd,
    ]);
    if (opened !== 0) return opened;

    say(io, [
        `cloned ${sess.slice(0, 8)} into a new ${o.to} session`,
        `  seed: ${seed}`,
        '  the clone\'s own id lands on the ledger the first time it speaks:',
        '    drover clone --list',
    ]);
    return 0;
}
