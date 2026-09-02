/**
 * `drover check` — refuse a tree whose header comments have turned into
 * commands (DROVE-261), in node (DROVE-315).
 *
 * WHAT HAPPENED. Four lines of cattle-drover/libexec/drover-account's header
 * banner lost their leading `#`:
 *
 *   #   drover account add <name>          create it AND log it in
 *     drover account login --harness cursor [name]
 *                                        add a CURSOR subscription instead. It
 *                                        carries a token, not a config dir, and
 *                                        is run with `drover cursor ...`.
 *   #   drover account rm <name>           remove the row
 *
 * The second line is not documentation any more, it is a COMMAND, and it ran at
 * load on EVERY invocation of drover-account, blocking forever on an OAuth code
 * nobody was going to type. The backticks two lines down are live command
 * substitution as well. `~/.local/bin/drover` is a symlink into the working
 * tree, so there is no build step between that edit and every future start:
 * Clay could not start drover at all, and the session hung after the cooling
 * line with no prompt and no error.
 *
 * `sh -n` passes on all of it. It has to: a command invocation is valid shell.
 * Syntax checking can never catch this class.
 *
 * WHAT THIS ADDS OVER tests/libexec-loadtime.bats, which landed with DROVE-256
 * and PROBES each libexec script by running `--help` under a timeout with
 * shimmed binaries that record being called. That probe is real and it catches
 * the original bug. It does not make this file redundant, for three measured
 * reasons:
 *
 *   The probe only sees a side effect it can OBSERVE — a shimmed binary that
 *   got called, or a hang. Of the four lines that lost their `#` in DROVE-261,
 *   only one started with a shimmed binary. Splice back just the prose lines
 *   and the probe is green: `carries: command not found` leaves no mark, and
 *   the probe deliberately does not assert exit status. This check flags all
 *   four.
 *
 *   The probe covers libexec/ only. bin/drover, lib/*.sh, adapters/*.sh and
 *   clients/*.sh are not probed, and bin/drover is the file a bad merge broke
 *   the same night. This reads all of them.
 *
 *   The probe is a TEST. It runs when somebody runs the suite. Both outages
 *   happened because an agent was stopped before it ran anything, and the edit
 *   was live the instant it hit disk. bin/drover calls this before it
 *   dispatches, so a broken tree is refused with a message instead of hanging.
 *
 * The complement holds in the other direction too, which is why both stay: this
 * check stops reading at the first column-0 statement, so a stray command lower
 * down is the probe's to catch, not this one's.
 *
 * THE RULE, and why it is this one. Every script in that repo begins its first
 * real statement at COLUMN 0 (`set -e`, an assignment, a function definition).
 * Header prose, when it is indented at all, is indented AFTER the `#`. So:
 *
 *   The header block runs from line 2 to the line before the first non-blank,
 *   non-comment line that starts at column 0. Every non-blank line inside that
 *   block must be a comment.
 *
 * A doc line that loses its `#` keeps its indentation, so it does not end the
 * header block, it becomes a non-comment line INSIDE it. That is exactly the
 * violation, and it is caught on line 17 of the file that broke.
 *
 * HEREDOCS ARE NOT A PROBLEM, by construction rather than by luck. Opening a
 * heredoc is itself code, so a heredoc cannot begin before the first column-0
 * statement, and this never reads past that line. The prose inside `<<'EOF'`
 * and `<<'HELPTEXT'` in drover-accounts, drover-cursor and drover-cursor-login
 * sits far below it and is never examined.
 *
 * WHERE IT RUNS. `bin/drover` calls it before it dispatches, with two
 * exceptions that are deliberate and narrow:
 *
 *   `drover statusline` is exempt. tmux re-runs it every 5s per client, it has
 *   no error channel (it exits 0 with an empty line on every failure), and this
 *   check costs 40-400ms depending on how the machine feels about spawning a
 *   process that second. Paying that forever, to guard a path that cannot
 *   report the answer, is the trade DROVE-265 exists to refuse.
 *
 *   A missing or non-executable checker is skipped, not fatal. A guard that can
 *   itself brick the CLI is the bug it was written to prevent.
 *
 * DROVER_SKIP_CHECK=1 bypasses it for the one case that needs an escape hatch:
 * running drover to fix the file it is refusing. Both of those live in
 * `bin/drover`, which this port does not touch — they are the WRAPPER's
 * behaviour, still asserted by tests/check.bats, and they stay true of the
 * shell wrapper whichever language the checker itself is written in.
 *
 * WHAT MOVED, AND WHAT DID NOT. The shell ran one `awk` over every script,
 * rather than a shell loop with a spawn per file, because this is on the start
 * path and 50-odd spawns is the cost DROVE-265 is about. In node there is no
 * spawn to save: the same rule is the same rule, applied line by line, in
 * process. The one thing that had to move is the ROOT. The shell took it from
 * its own `dirname`, which no longer says anything once the checker lives in
 * the fork — so the tree read is `droverEnv().droverDir`, the cattle-drover
 * checkout, which is the tree the shell was reading all along.
 *
 * The default list is still built with a loop rather than left as a raw glob,
 * so a directory that is not there (a throwaway tree in the bats suite holds
 * only bin/ and libexec/) contributes nothing instead of handing the reader a
 * literal pattern and failing for a reason that has nothing to do with headers.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { droverEnv } from './env';

const HELP = `drover check — refuse a tree whose header comments have become commands.

USAGE
  drover check          Report every offending line, exit 1 if any
  drover check -q       Say nothing on success; still exits 1 on a failure
  drover check <file>…  Check just these files

It reads bin/*, libexec/*, lib/*.sh, adapters/*.sh and clients/*.sh, and
applies one rule: in the header block — line 2 to the line before the first
non-blank, non-comment line at column 0 — every non-blank line must be a
comment. A documentation line that loses its leading \`#\` keeps its
indentation, so it lands inside that block as a command, which is what bricked
every drover start in DROVE-261.

\`sh -n\` cannot catch that: a command invocation is valid shell. The \`sh -n\`
sweep that catches the OTHER failure (a merge that eats a \`;;\`) lives in
tests/check.bats and \`make lint\`.

A full run also checks bin/drover's OWNER TABLE against libexec/: every file
has a row, every row has a file, and every node-owned verb is actually routed
with \`run_node\`. Skipped under -q, so the CLI start path never pays for it.

bin/drover runs this before it dispatches, except for \`drover statusline\`.
DROVER_SKIP_CHECK=1 bypasses it, which is what you want while you are fixing
the file it is complaining about.
`;

/**
 * The paragraph the shell cat'd to stderr after the offending lines, blank
 * first line included. It is what turns a pair of line numbers into something
 * Clay can act on without going and finding the ticket.
 */
const WHY = `
drover-check: the lines above are inside a file's header banner but are not
comments, so they execute every time the script is loaded. That is what hung
every drover start in DROVE-261: \`drover account login --harness cursor\` sat in
drover-account's banner without its \`#\` and blocked on an OAuth code forever.

Put the \`#\` back. \`sh -n\` will not tell you: a command invocation is valid
shell, which is the whole reason this check exists.

To run anyway while you fix it:  DROVER_SKIP_CHECK=1 drover ...
`;

type Env = Record<string, string | undefined>;

/**
 * The explanation the shell cat'd after the owner-table complaints, blank first
 * line included.
 */
const OWNER_WHY = `
drover-check: bin/drover's owner table and libexec/ have drifted. Every file in
libexec/ is either routed to the fork's node CLI (owner=node, with a \`run_node
<verb>\` line) or owned by the shell file outright (owner=shell, with none). A
new file with no row is a verb nobody decided about; a node row with no
run_node is a verb the flip forgot to route.
`;

/**
 * bin/drover's owner table, its dispatch arms and its run_node call sites
 * (DROVE-315 wave 4).
 *
 * THE NODE CHECKER WAS MISSING THIS ENTIRELY, which is worse than it sounds:
 * `check` is owner=node, so a hand-typed `drover check` ran the arm that only
 * read headers and then said "headers clean" — while the shell file it
 * replaced had grown a second sweep, and its own --help still advertised it.
 * `make lint` calls libexec/drover-check by path so CI never lost the guard,
 * but the verb Clay types did, and a guard you can silence by typing the verb
 * is not a guard. This is the transliteration of that awk.
 *
 * The shell's parse, rule for rule: the table opens at a line that is exactly
 * \`drover_owner() {\` and closes at a line that is exactly \`}\`; inside it, an
 * \`owner=\` line assigns its value to every verb name banked since the last
 * one; \`case\`, \`esac\` and \`;;\` lines are skipped; any other line has its
 * backslashes, parens and pipes turned to spaces and every word shaped like a
 * verb is banked. Outside the table a line that is exactly \`<verb>)\` is a
 * dispatch arm — the table's own patterns are indented, so they cannot be
 * mistaken for one — and a \`run_node <verb> \` line anywhere is a routed verb.
 *
 * ONE DELIBERATE DIVERGENCE, and it is about ORDER, not about what is found.
 * awk's \`for (v in array)\` has no defined order, so a tree with several drifts
 * printed them in whatever order that awk's hash produced. This sorts, so the
 * report is stable run to run. The SET of complaints is identical, and the
 * differential test compares the two as sets for exactly this reason.
 */
export interface OwnerTable {
    /** Present only when bin/drover actually carries a table. */
    hasTable: boolean;
    /** verb -> "node" | "shell" (or whatever the file said). */
    owner: Map<string, string>;
    /** Verbs some line calls `run_node <verb>` for. */
    routed: Set<string>;
    /** Verbs with a `<verb>)` dispatch arm at column 0. */
    armed: Set<string>;
}

const OWNER_OPEN = /^drover_owner\(\) \{$/;
const OWNER_CLOSE = /^\}$/;
const OWNER_ASSIGN = /^[ \t\v\f\r]*owner=/;
const OWNER_NOISE = /^[ \t\v\f\r]*(case|esac|;;)/;
const OWNER_ARM = /^[a-z][a-z0-9-]*\)$/;
const OWNER_ROUTED = /^[ \t\v\f\r]*run_node[ \t\v\f\r]+[a-z][a-z0-9-]*[ \t\v\f\r]/;
const VERB_WORD = /^[a-z][a-z0-9-]*$/;

/** Parse bin/drover's text. Pure, so a fixture can hand in a table. */
export function parseOwnerTable(text: string): OwnerTable {
    const owner = new Map<string, string>();
    const routed = new Set<string>();
    const armed = new Set<string>();
    let hasTable = false;
    let inTable = false;
    let pending: string[] = [];

    for (const line of text.split('\n')) {
        // The call sites are read whether or not the table is open, exactly as
        // the awk's unguarded rule did. The function DEFINITION names no verb,
        // so it does not match.
        if (OWNER_ROUTED.test(line)) {
            const words = line.split(/[ \t\v\f\r]+/);
            const at = words.indexOf('run_node');
            if (at >= 0 && words[at + 1] !== undefined) routed.add(words[at + 1]);
        }
        if (!inTable && OWNER_OPEN.test(line)) {
            hasTable = true;
            inTable = true;
            continue;
        }
        if (inTable && OWNER_CLOSE.test(line)) {
            inTable = false;
            continue;
        }
        if (!inTable) {
            if (OWNER_ARM.test(line)) armed.add(line.slice(0, -1));
            continue;
        }
        const assign = line.match(OWNER_ASSIGN);
        if (assign) {
            const value = line.slice(assign[0].length);
            if (value !== '') for (const v of pending) owner.set(v, value);
            pending = [];
            continue;
        }
        if (OWNER_NOISE.test(line)) continue;
        for (const word of line.replace(/[\\)|]/g, ' ').split(/[ \t\v\f\r]+/)) {
            if (VERB_WORD.test(word)) pending.push(word);
        }
    }
    return { hasTable, owner, routed, armed };
}

/** The verbs libexec/ actually holds: `drover-<verb>`, regular files only. */
export function libexecVerbs(root: string): Set<string> {
    const out = new Set<string>();
    for (const path of globFiles(join(root, 'libexec'))) {
        const base = path.slice(path.lastIndexOf('/') + 1);
        if (base.startsWith('drover-')) out.add(base.slice('drover-'.length));
    }
    return out;
}

/** Every complaint, sorted. Empty when the table and the tree agree. */
export function ownerComplaints(table: OwnerTable, onDisk: Set<string>): string[] {
    const out: string[] = [];
    for (const v of [...onDisk].sort()) {
        if (!table.owner.has(v)) out.push(`libexec/drover-${v} has no row in bin/drover drover_owner()`);
    }
    for (const v of [...table.owner.keys()].sort()) {
        const owner = table.owner.get(v);
        if (!onDisk.has(v)) out.push(`drover_owner() names ${v}, but libexec/drover-${v} is gone`);
        if (owner === 'node' && !table.routed.has(v)) {
            out.push(`${v} is owned by node but nothing calls run_node ${v} — it is not routed`);
        }
        if (owner === 'shell' && table.routed.has(v)) {
            out.push(`${v} is owned by shell but bin/drover calls run_node ${v}`);
        }
        if (owner === 'shell' && !table.armed.has(v)) {
            out.push(`${v} is owned by shell but bin/drover has no ${v}) arm — it falls through to the fork CLI`);
        }
    }
    return out;
}

/**
 * The sweep over a real tree. No bin/drover, or one with no table in it — a
 * throwaway tree in the bats suite holds exactly that — has nothing to be
 * consistent with, and says nothing.
 */
export function ownerDrift(root: string): string[] {
    const drover = join(root, 'bin', 'drover');
    if (!isRegularFile(drover)) return [];
    let text: string;
    try {
        text = readFileSync(drover, 'utf8');
    } catch {
        return [];
    }
    const table = parseOwnerTable(text);
    if (!table.hasTable) return [];
    return ownerComplaints(table, libexecVerbs(root));
}

// POSIX [[:space:]], spelled out rather than reached for as \s: JS's \s also
// matches the unicode spaces and U+FEFF, and a checker that disagrees with the
// awk about what a blank line is would disagree about what a violation is.
const BLANK = /^[ \t\v\f\r]*$/;
const COMMENT = /^[ \t\v\f\r]*#/;
const COLUMN0 = /^[^ \t\v\f\r]/;

/**
 * The awk's FNR==1 test. A file with no `#!` is data, and a `#!` naming python
 * or node is somebody else's syntax, where a bare line is not a command.
 */
export function isShellScript(firstLine: string): boolean {
    return /^#![^\n]*[\/ \t\v\f\r](?:sh|bash|dash|ksh|zsh)(?:[ \t\v\f\r]|$)/.test(firstLine);
}

/** One line the header block should not have contained. */
export interface Violation {
    /** The path exactly as it was handed in — awk's FILENAME. */
    file: string;
    /** 1-based, awk's FNR. */
    line: number;
    /** The raw line, printed under the complaint. */
    text: string;
}

/**
 * The rule, over one file's text. `started` latches once the header block ends,
 * so nothing past the first column-0 statement is ever examined — that is what
 * keeps heredoc prose out of scope.
 */
export function checkText(file: string, text: string): Violation[] {
    const lines = text.split('\n');
    // A trailing newline is a record separator, not an empty record: awk reads
    // one fewer line than a naive split does.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return [];
    if (!isShellScript(lines[0])) return [];

    const out: Violation[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        // A blank line neither ends the header nor violates it.
        if (BLANK.test(line)) continue;
        // A comment, indented or not, is what the header block is made of.
        if (COMMENT.test(line)) continue;
        // Non-blank, non-comment, at column 0: the first real statement. The
        // header block ends here and this file is done.
        if (COLUMN0.test(line)) break;
        // Non-blank, non-comment, INDENTED, and still inside the header block.
        // This is the DROVE-261 shape: a documentation line that lost its
        // leading `#` and is now a command that runs at load.
        out.push({ file, line: i + 1, text: line });
    }
    return out;
}

/** `[ -f "$f" ]`: a regular file, symlinks followed, and nothing else. */
function isRegularFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

/**
 * One glob of the default list. A directory that is not there contributes
 * nothing, which is the `[ -f "$f" ] || continue` in the shell and the reason
 * the bats suite's two-directory throwaway trees work at all. Sorted, because
 * a shell glob is, and the report reads in tree order.
 */
function globFiles(dir: string, suffix?: string): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names
        // A glob does not match a leading dot.
        .filter((n) => !n.startsWith('.'))
        .filter((n) => (suffix === undefined ? true : n.endsWith(suffix)))
        .sort()
        .map((n) => join(dir, n))
        .filter(isRegularFile);
}

/** bin/*, libexec/*, lib/*.sh, adapters/*.sh, clients/*.sh — in that order. */
export function defaultFiles(root: string): string[] {
    return [
        ...globFiles(join(root, 'bin')),
        ...globFiles(join(root, 'libexec')),
        ...globFiles(join(root, 'lib'), '.sh'),
        ...globFiles(join(root, 'adapters'), '.sh'),
        ...globFiles(join(root, 'clients'), '.sh'),
    ];
}

export interface CheckOptions {
    /** The environment; process.env unless a test says otherwise. */
    env?: Env;
    /** The home directory droverEnv resolves defaults against. */
    home?: string;
}

/**
 * The verb.
 *
 *   0  every header block is comments all the way down (or there was nothing
 *      to read, which is not a failure: a tree with no scripts cannot brick)
 *   1  at least one line inside a header block runs at load
 *   2  an argument this does not know
 *
 * Named files bypass the default list entirely — `drover check <file>` is what
 * you reach for while you are fixing the thing it is complaining about, so it
 * must work on a tree that is otherwise refused.
 */
export async function run(args: string[], opts: CheckOptions = {}): Promise<number> {
    let quiet = false;
    let named: string[] | null = null;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-q' || a === '--quiet') {
            quiet = true;
            continue;
        }
        if (a === '-h' || a === '--help') {
            process.stdout.write(HELP);
            return 0;
        }
        if (a.startsWith('-')) {
            process.stderr.write(`drover-check: unknown argument '${a}' (try --help)\n`);
            return 2;
        }
        // The first non-flag argument breaks the loop; everything from there is
        // a filename.
        named = args.slice(i);
        break;
    }

    let files: string[];
    if (named !== null) {
        files = named;
    } else {
        const env = opts.env ?? process.env;
        files = defaultFiles(droverEnv(env, opts.home ?? homedir()).droverDir);
        if (files.length === 0) {
            if (!quiet) process.stdout.write('drover check: nothing to read\n');
            return 0;
        }
    }

    let bad = 0;
    for (const file of files) {
        let text: string;
        try {
            text = readFileSync(file, 'utf8');
        } catch {
            // awk answered this with `awk: can't open file <path>` and a
            // non-zero status, which fell into the same explanation block
            // below. Same outcome, same exit code, without pretending an awk
            // ran: a file that cannot be read has not been checked, and a
            // checker that shrugs at that is a checker that can be silenced by
            // a typo in a path.
            process.stderr.write(`drover-check: can't open file ${file}\n`);
            bad++;
            continue;
        }
        for (const v of checkText(file, text)) {
            bad++;
            process.stderr.write(`${v.file}:${v.line}: header comment lost its leading #, so this line RUNS at load\n`);
            process.stderr.write(`    ${v.text}\n`);
        }
    }

    if (bad > 0) {
        process.stderr.write(WHY);
        return 1;
    }

    // The owner table, on a full run only. Named files mean the run is about
    // THOSE files, and -q is the CLI start path, which must never pay for it.
    if (named === null && !quiet) {
        const env = opts.env ?? process.env;
        const root = droverEnv(env, opts.home ?? homedir()).droverDir;
        const drift = ownerDrift(root);
        if (drift.length > 0) {
            for (const line of drift) process.stderr.write(`drover-check: ${line}\n`);
            process.stderr.write(OWNER_WHY);
            return 1;
        }
    }

    if (!quiet) process.stdout.write('drover check: headers clean\n');
    return 0;
}
