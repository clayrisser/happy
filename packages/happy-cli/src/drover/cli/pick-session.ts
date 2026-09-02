/**
 * `drover pick-session` — drover's own picker for a bare `drover --resume`
 * (DROVE-50), in node (DROVE-315).
 *
 * WHY DROVER OWNS THIS. A bare `--resume` used to reach Claude Code's picker,
 * so the transcript id did not exist until the SessionStart hook fired — long
 * after runClaude had already called getOrCreateSession with a random tag.
 * Every bare resume therefore minted a NEW Happy session for a conversation the
 * phone already had one for, and the scanner then pre-marked the whole
 * transcript as history, so the new one opened EMPTY. From the phone: the
 * conversation is gone, and a duplicate "cattle-drover / No messages yet" sits
 * beside it. ~/.happy/sessions.json held a dozen of those at this cwd.
 *
 * Clay's ruling (DROVE-50): the picker is drover's, so the id is known BEFORE
 * claude starts. bin/drover turns the pick into `--resume <id>`, and the fork's
 * reattach path (src/resume/reattachClaudeSession.ts) joins the Happy session
 * that already holds that transcript, name and history intact. Late reattach at
 * the hook and archive-and-backfill were both rejected: one flashes an empty
 * session on every resume, the other grows the list and breaks links.
 *
 * WHAT A ROW KNOWS. Every session in this cwd is one row, newest first:
 *
 *   19c2f0a8  3h ago   jamrizzi  DROVER
 *
 *   id      the first 8 of the transcript id
 *   age     the transcript's mtime — when the conversation last moved
 *   acct    the account it was last on, from the whereabouts store the fork's
 *           flip controller writes ($STATE_DIR/whereabouts.json). Shown, not
 *           acted on: which account a resume actually STARTS on is decided by
 *           `pick-account` (DROVE-21), which reads this same record plus the
 *           cooldown ledger and the usage cache. Choosing here as well would be
 *           a second, dumber copy of those rules. `-` when never recorded, or
 *           recorded for an account no longer in the registry.
 *   title   custom-title.json (a rename), else the transcript's own
 *           custom-title line, else the first thing the user typed.
 *   · live  the bus says another wrapper holds it right now. Resuming one of
 *           those is what Claude Code would let you do too; the marker is so
 *           it is a choice and not a surprise.
 *
 * One projects dir holds every account's transcripts (DROVE-40), which is what
 * makes "every session in this cwd" one directory listing regardless of which
 * account wrote it — and what lets the pick resume under any account.
 *
 * OUTPUT is the picked transcript id on stdout and nothing else, for bin/drover
 * to turn into `--resume <id>`. The list itself goes to the terminal (gum's UI
 * on stderr, the numbered fallback on stderr) so `$(...)` capture never
 * swallows it. Exit 1 when there is nothing to pick or nothing was picked, so a
 * caller under `set -e` stops rather than starting a fresh session nobody asked
 * for.
 *
 * A straight port of cattle-drover/libexec/drover-pick-session. Padding is in
 * codepoints, not bytes, for the reason drover-sessions gives: printf's `%-Ns`
 * counts bytes and a title with an accent in it would skew the row. Control
 * characters become SPACES here (not the table's middle dot) so a title cannot
 * be a second row. Everything the shell shelled out for — gum, `command -v`,
 * `[ -t 0 ]`, `[ -t 2 ]`, the `read` of an answer — goes through ONE injectable
 * PickProbe, whose test double throws, so no test can ever raise a real popup.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { BusError, busGet } from './bus';
import { droverEnv } from './env';

const USAGE = `drover pick-session — pick a conversation in this directory to resume.

USAGE
  drover pick-session             Show the picker, print the id that was picked
  drover pick-session --latest    The most recent one, no picker (drover -c)
  drover pick-session --list      The rows, newest first, and nothing else
      --cwd <dir>                 ... for a directory other than $PWD

What bin/drover runs for a bare \`drover --resume\` and for \`drover -c\`, so the
Claude session id is known before claude starts and the fork CLI reattaches
the phone's existing Happy session instead of minting an empty twin
(DROVE-50). A row's account is where the session was last left, shown so the
pick is informed; \`pick-account\` (DROVE-21) is what decides where it starts.

  gum draws the list when there is a terminal; otherwise, or with
  DROVER_PICKER=plain, a numbered list is printed and a number read from
  stdin. DROVER_PICKER=gum forces gum (what the tests do, with a fake one).

  A test-harness fixture directory (/private/tmp/happy-testing-ground-*,
  /private/tmp/happy-claude-goal-fixtures*, /private/tmp/drover-trust-test*,
  */environments/data/envs/*/project) has nothing to pick unless
  DROVER_SHOW_FIXTURES=1, the same rule \`drover sessions\` applies to its rows
  (DROVE-81, lib/drover-fixtures.sh).

See also: drover sessions (every session, every cwd, from the bus)
`;

type Env = Record<string, string | undefined>;

/**
 * Everything the shell asked the machine or the human, one method per command.
 * The default asks for real; a test hands in one that answers from a fixture,
 * or one that THROWS, which is how "no real gum popup was drawn" is proven
 * rather than promised.
 */
export interface PickProbe {
    /** `[ -t 0 ]` */
    stdinIsTty(): boolean;
    /** `[ -t 2 ]` */
    stderrIsTty(): boolean;
    /** `command -v gum >/dev/null 2>&1` */
    hasGum(): boolean;
    /**
     * `gum choose --header <header> --height <n> --cursor '> ' --label-delimiter <TAB>`
     * fed `label<TAB>id` lines on stdin. The picked ID, or null for the escape
     * (gum prints nothing and exits 1).
     */
    gumChoose(input: string, header: string, height: number): string | null;
    /** `read -r ans` — one line from stdin, or null at end of input. */
    readAnswer(): string | null;
}

function ask(cmd: string, argv: string[], input?: string): { status: number | null; stdout: string } {
    const r = spawnSync(cmd, argv, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
}

export const systemProbe: PickProbe = {
    stdinIsTty: () => Boolean(process.stdin.isTTY),
    stderrIsTty: () => Boolean(process.stderr.isTTY),
    hasGum: () => {
        const r = spawnSync('command', ['-v', 'gum'], { shell: false, encoding: 'utf8', stdio: 'ignore' });
        if (!r.error && r.status === 0) return true;
        // `command` is a shell builtin, not always an executable; fall back to
        // asking gum itself, which is what `command -v` was standing in for.
        const g = spawnSync('gum', ['--version'], { encoding: 'utf8', stdio: 'ignore' });
        return !g.error;
    },
    gumChoose: (input, header, height) => {
        const r = ask('gum', [
            'choose',
            '--header', header,
            '--height', String(height),
            '--cursor', '> ',
            '--label-delimiter', '\t',
        ], input);
        if (r.status !== 0) return null;
        return r.stdout.replace(/\n$/, '');
    },
    readAnswer: () => {
        // `read -r ans` off fd 0: one line, or null at end of input.
        const buf: number[] = [];
        const one = Buffer.alloc(1);
        for (;;) {
            let n = 0;
            try {
                n = readSync(0, one, 0, 1, null);
            } catch {
                n = 0;
            }
            if (n === 0) return buf.length ? Buffer.from(buf).toString('utf8') : null;
            if (one[0] === 0x0a) return Buffer.from(buf).toString('utf8');
            buf.push(one[0]);
        }
    },
};

export interface PickOptions {
    env?: Env;
    probe?: PickProbe;
    /** `date +%s`. */
    now?: () => number;
    home?: string;
    /** $PWD, for a run with no --cwd. */
    cwd?: string;
}

// --- lib/drover-fixtures.sh, the `case` half ---------------------------------
//
// The same rule sessions.ts carries, kept identical on purpose: a row hidden by
// one verb and shown by the other is the confusion this exists to end. This is
// the sh `case` spelling, where a glob `*` crosses a `/` happily.

/** `fixture_cwd` — is this a test-harness directory? */
export function fixtureCwd(cwd: string): boolean {
    return cwd.startsWith('/private/tmp/happy-testing-ground-')
        || cwd.startsWith('/tmp/happy-testing-ground-')
        || cwd.startsWith('/private/tmp/happy-claude-goal-fixtures')
        || cwd.startsWith('/tmp/happy-claude-goal-fixtures')
        || cwd.startsWith('/private/tmp/drover-trust-test')
        || cwd.startsWith('/tmp/drover-trust-test')
        || /\/environments\/data\/envs\/[\s\S]*\/project$/.test(cwd)
        || /\/environments\/data\/envs\/[\s\S]*\/project\//.test(cwd);
}

/** `fixtures_shown` — DROVER_SHOW_FIXTURES=1 turns the rule off for a run. */
export function fixturesShown(env: Env): boolean {
    return (env.DROVER_SHOW_FIXTURES ?? '0') === '1';
}

// --- jq's string primitives, in node ------------------------------------------

const cps = (s: string): string[] => Array.from(s);
const jqLen = (s: string): number => cps(s).length;
const jqSlice = (s: string, a: number, b?: number): string => cps(s).slice(a, b).join('');

/** `def clean`: control characters become SPACES, so a title cannot be a second row. */
export function clean(v: unknown): string {
    const s = v === null || v === undefined || v === false ? '' : (typeof v === 'string' ? v : JSON.stringify(v) ?? '');
    return cps(s).map((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return c < 32 || c === 127 ? ' ' : ch;
    }).join('');
}

function pad(s: string, n: number): string {
    const gap = n - jqLen(s);
    return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** `def head($n)`: clipped at n with an ellipsis, so one row stays one line. */
function headTo(s: string, n: number): string {
    return jqLen(s) > n ? `${jqSlice(s, 0, n - 1)}…` : s;
}

/** `def age`: the transcript's mtime, in the coarsest unit that still says something. */
export function age(seconds: number): string {
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// --- one transcript, one row ---------------------------------------------------

/**
 * The head only, never the whole file. Transcripts here run to 190 MB, and the
 * title is in the first few KB — reading all of them to draw a list would cost
 * most of a minute.
 */
const HEAD_BYTES = 262144;

/** A UUID name. Claude Code refuses `--resume agent-…` since 2.0.65. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readHead(file: string, bytes: number): string {
    try {
        const fd = openSync(file, 'r');
        try {
            const buf = Buffer.alloc(bytes);
            return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString('utf8');
        } finally {
            closeSync(fd);
        }
    } catch {
        return '';
    }
}

/**
 * One read of the head answers two questions: is this a conversation at all
 * (it has a user entry — the same test the fork's claudeFindLastSession
 * applies before `--continue`), and what to call it. '' means "not a
 * conversation"; a row is never made for it on that basis alone.
 *
 * The title, in the order a human would rank them: the rename Claude Code
 * stores beside the transcript, then the custom-title line the transcript
 * itself opens with (a carried transcript keeps its name across a flip), then
 * the first thing the user typed. `<...>` and `Caveat:` prompts are Claude
 * Code's own scaffolding (slash-command echoes, local-command captures,
 * system reminders), and a meta line is one another process injected — none
 * of those is what the conversation was about. When nothing qualifies the
 * row says (untitled), which is the truth.
 */
export function rowTitle(dir: string, id: string, file: string): string {
    let renamed = '';
    const tf = join(dir, id, 'custom-title.json');
    try {
        const t = JSON.parse(readFileSync(tf, 'utf8')) as { customTitle?: unknown };
        if (typeof t?.customTitle === 'string') renamed = t.customTitle;
        else if (t && t.customTitle !== null && t.customTitle !== undefined && t.customTitle !== false) {
            renamed = JSON.stringify(t.customTitle) ?? '';
        }
    } catch {
        renamed = '';
    }

    const entries: Record<string, unknown>[] = [];
    for (const line of readHead(file, HEAD_BYTES).split('\n')) {
        try {
            const v = JSON.parse(line) as unknown;
            if (v && typeof v === 'object') entries.push(v as Record<string, unknown>);
        } catch {
            // `fromjson?` — a torn last line is skipped rather than fatal.
        }
    }
    if (!entries.some((e) => e.type === 'user')) return '';
    if (jqLen(renamed) > 0) return firstLine(renamed);

    const candidates: string[] = [];
    for (const e of entries) {
        if (e.type === 'custom-title') {
            const t = e.customTitle;
            if (t !== null && t !== undefined && t !== false) candidates.push(typeof t === 'string' ? t : String(t));
            continue;
        }
        if (e.type !== 'user' || e.isMeta === true) continue;
        const content = (e.message as Record<string, unknown> | undefined)?.content;
        let text: string;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
            text = content
                .map((c) => (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text'
                    ? String((c as Record<string, unknown>).text ?? '')
                    : null))
                .filter((c): c is string => c !== null)
                .join(' ');
        } else text = '';
        if (text.startsWith('<') || text.startsWith('Caveat:')) continue;
        candidates.push(text);
    }
    const first = candidates.find((c) => jqLen(c) > 0);
    return firstLine(first ?? '(untitled)');
}

/** `| head -1 | tr '\\t\\r' '  '` — the first line, with tabs and CRs flattened. */
function firstLine(s: string): string {
    return s.split('\n')[0].replace(/[\t\r]/g, ' ');
}

export interface RawRow {
    id: string;
    mtime: number;
    title: string;
}

/** The `ls -t` scan: newest first, UUID names only, at most `limit` of them. */
export function scanRows(dir: string, limit: number): RawRow[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const files = names
        .filter((n) => n.endsWith('.jsonl'))
        .map((n) => {
            try {
                const st = statSync(join(dir, n));
                return st.isFile() ? { name: n, mtime: st.mtimeMs, size: st.size } : null;
            } catch {
                return null;
            }
        })
        .filter((f): f is { name: string; mtime: number; size: number } => f !== null)
        // `ls -t`: newest mtime first, ties broken by name ascending.
        .sort((a, b) => (b.mtime - a.mtime) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const rows: RawRow[] = [];
    for (const f of files) {
        if (rows.length >= limit) break;
        const id = f.name.slice(0, -'.jsonl'.length);
        if (!UUID.test(id)) continue;
        let title = rowTitle(dir, id, join(dir, f.name));
        if (title === '') {
            // No user entry in the head. That only proves "not a conversation"
            // when the head IS the whole file. A transcript long enough to run
            // past the window can open with a summary or a system block and
            // still be a real conversation, and dropping one would be silent
            // and bad: `drover -c` takes the top row, so a missing row means
            // resuming the WRONG conversation. Clay's biggest transcript in
            // this directory is 190 MB. Unnamed rather than unlisted.
            if (f.size <= HEAD_BYTES) continue;
            title = '(untitled)';
        }
        rows.push({ id, mtime: Math.floor(f.mtime / 1000), title });
    }
    return rows;
}

// --- what the other stores say about these ids ---------------------------------

/**
 * Whereabouts: {<claudeSessionId>: {account, cwd, at}}, written by the fork's
 * flip controller. Keyed by cwd as well as id on purpose (a recycled id in
 * another project must not match), so the cwd is checked here too.
 *
 * Slurped, and only ONE object counts: the file is written whole by a rename,
 * but a torn or doubled one must read as "no record" rather than feed two
 * documents to the renderer and abort the pick.
 */
export function readWhereabouts(file: string, cwd: string): Record<string, string> {
    let text: string;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        return {};
    }
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch {
        // `jq -s` over a torn or doubled file: not one document, so no record.
        return {};
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        if (v.cwd !== cwd) continue;
        const account = v.account;
        out[key] = account === null || account === undefined || account === false ? '-' : String(account);
    }
    return out;
}

/**
 * Only an account bin/drover can actually start on. A recorded name that has
 * since been removed from the registry would send `drover account use` to its
 * "no such account" refusal, and the resume with it.
 */
export function readRegistry(file: string): string[] {
    try {
        const doc = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (!Array.isArray(doc)) return [];
        return doc
            .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>).name : undefined))
            .filter((n): n is string => typeof n === 'string' && n !== '');
    } catch {
        return [];
    }
}

export interface Row {
    id: string;
    age: string;
    title: string;
    acct: string;
    live: boolean;
    /** The padded human half of `<id>\\t<label>`. */
    label: string;
}

/**
 * Padded in jq, not printf, for the reason drover-sessions gives: printf's
 * `%-Ns` counts bytes, jq's `length` counts codepoints, and a title with an
 * accent in it would skew the row. The account is part of the LABEL, not a
 * field, because nothing downstream chooses on it.
 */
export function renderRows(raw: RawRow[], nowS: number, where: Record<string, string>, reg: string[], live: string[]): Row[] {
    const rows = raw.map((r) => {
        const recorded = where[r.id] ?? '-';
        return {
            id: r.id,
            age: age(nowS - r.mtime),
            title: headTo(clean(r.title === '' ? '(untitled)' : r.title), 60),
            acct: reg.includes(recorded) ? recorded : '-',
            live: live.includes(r.id),
            label: '',
        };
    });
    const wage = Math.max(...rows.map((r) => jqLen(r.age)));
    const wacct = Math.max(...rows.map((r) => jqLen(r.acct)));
    for (const r of rows) {
        r.label = `${jqSlice(r.id, 0, 8)}  ${pad(r.age, wage)}  ${pad(r.acct, wacct)}  ${r.title}${r.live ? '  · live' : ''}`;
    }
    return rows;
}

// --- the verb ------------------------------------------------------------------

function say(lines: string[]): void {
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
}

function complain(lines: string[]): void {
    if (lines.length) process.stderr.write(`${lines.join('\n')}\n`);
}

type Mode = 'pick' | 'latest' | 'list';

type Parsed = { mode: Mode; cwd: string } | { help: true } | { code: number; error: string };

export function parseArgs(args: string[]): Parsed {
    let mode: Mode = 'pick';
    let cwd = '';
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        switch (arg) {
            case '--latest':
                mode = 'latest';
                break;
            case '--list':
                mode = 'list';
                break;
            case '--cwd':
                if (i + 1 >= args.length) return { code: 2, error: 'drover pick-session: --cwd needs a directory' };
                cwd = args[i + 1];
                i += 1;
                break;
            case '-h':
            case '--help':
                return { help: true };
            default:
                return { code: 2, error: `drover pick-session: unknown argument '${arg}' (try --help)` };
        }
    }
    return { mode, cwd };
}

export async function run(args: string[], opts: PickOptions = {}): Promise<number> {
    const parsed = parseArgs(args);
    if ('help' in parsed) {
        process.stdout.write(USAGE);
        return 0;
    }
    if ('code' in parsed) {
        complain([parsed.error]);
        return parsed.code;
    }

    const env = opts.env ?? process.env;
    const probe = opts.probe ?? systemProbe;
    const home = opts.home ?? env.HOME ?? homedir();
    const nowS = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
    const denv = droverEnv(env, home);

    const registry = env.DROVER_ACCOUNTS || join(denv.droverDir, 'accounts.json');
    // The same default and the same override the bus registry uses
    // (engine/registry.js), so a test that redirects one redirects both.
    const projects = env.DROVER_PROJECTS_DIR || join(home, '.claude', 'projects');
    // Newest N. Claude Code's own picker lists everything; forty is more than a
    // screen and keeps the per-row transcript reads bounded.
    const limit = Number(env.DROVER_PICK_LIMIT || '40');

    // PHYSICAL path. Claude Code munges process.cwd(), which is the resolved
    // one: on macOS /tmp/x is /private/tmp/x in the projects dir, and $PWD in a
    // shell says /tmp/x. The whereabouts store keys on the same resolved path.
    const asked = parsed.cwd || opts.cwd || process.cwd();
    let cwd: string;
    try {
        cwd = realpathSync(resolve(asked));
    } catch {
        // The shell's `$(cd "$dir" && pwd -P)` fails here and `set -e` stops
        // the verb with cd's own words and exit 1. Same code, same shape.
        complain([`drover pick-session: cd: ${asked}: No such file or directory`]);
        return 1;
    }
    // The cwd with every character outside [A-Za-z0-9-] turned into a dash.
    const munged = cps(cwd).map((ch) => (/[A-Za-z0-9-]/.test(ch) ? ch : '-')).join('');
    const dir = join(projects, munged);

    // A test-harness directory has conversations only because a harness ran a
    // real claude in it (DROVE-81), and `drover sessions` hides those rows; the
    // picker follows the same rule, from the same file, so the two never
    // disagree about what exists. Exit 1 like "nothing to resume": a caller
    // under `set -e` stops rather than starting a fresh session in a fixture
    // nobody meant to work in. DROVER_SHOW_FIXTURES=1 shows them here too.
    if (fixtureCwd(cwd) && !fixturesShown(env)) {
        complain([
            `drover: ${cwd} is a test-harness fixture directory; its conversations are hidden`,
            '  (DROVE-81). DROVER_SHOW_FIXTURES=1 shows them.',
        ]);
        return 1;
    }

    let isDir = false;
    try {
        isDir = statSync(dir).isDirectory();
    } catch {
        isDir = false;
    }
    if (!isDir) {
        complain([`drover: nothing to resume in ${cwd} — no conversations under`, `  ${dir}`]);
        return 1;
    }

    const raw = scanRows(dir, limit);
    if (raw.length === 0) {
        complain([`drover: nothing to resume in ${cwd} — no conversation here has a user message yet`]);
        return 1;
    }

    const where = readWhereabouts(join(denv.stateDir, 'whereabouts.json'), cwd);
    const reg = readRegistry(registry);
    // Best effort, two seconds, and the bus being down is not an error here:
    // the marker is a courtesy, the pick is the point.
    let live: string[] = [];
    if ((env.DROVER_PICK_BUS ?? '1') === '1') {
        try {
            const res = await busGet('/v1/sessions?limit=200', 2000, denv.droverUrl);
            const body = JSON.parse(res.body) as { sessions?: unknown };
            if (Array.isArray(body?.sessions)) {
                live = body.sessions
                    .filter((s) => s && typeof s === 'object' && (s as Record<string, unknown>).state === 'live')
                    .map((s) => (s as Record<string, unknown>).id)
                    .filter((id): id is string => typeof id === 'string');
            }
        } catch (error) {
            if (!(error instanceof BusError) && !(error instanceof SyntaxError)) throw error;
        }
    }

    const rows = renderRows(raw, nowS(), where, reg, live);

    // --- the three ways out ----------------------------------------------------

    if (parsed.mode === 'list') {
        say(rows.map((r) => r.label));
        return 0;
    }
    if (parsed.mode === 'latest') {
        say([rows[0].id]);
        return 0;
    }

    // gum when a human is at a terminal and gum is installed; the numbered list
    // otherwise. stdin AND stderr have to be terminals: bin/drover captures
    // stdout with `$(...)`, so stdout is never one here, and gum draws on
    // stderr. A piped stdin means "the answer is coming down the pipe", which
    // is the fallback's contract and what the tests use.
    let picker = env.DROVER_PICKER ?? '';
    if (picker === '') {
        picker = probe.stdinIsTty() && probe.stderrIsTty() && probe.hasGum() ? 'gum' : 'plain';
    }

    let homeCwd = cwd;
    if (cwd.startsWith(`${home}/`)) homeCwd = `~${cwd.slice(home.length)}`;
    else if (cwd === home) homeCwd = '~';
    const header = `resume which conversation?  ${homeCwd}`;

    let picked = '';
    if (picker === 'gum') {
        // `label<TAB>id` with --label-delimiter, so gum prints the ID of the
        // row and nothing has to be parsed back out of a padded label. Escape
        // prints nothing and exits 1, which is "no session picked" below.
        const height = Math.min(rows.length, 15);
        const input = `${rows.map((r) => `${r.label}\t${r.id}`).join('\n')}\n`;
        picked = probe.gumChoose(input, header, height) ?? '';
    } else {
        complain([
            header,
            ...rows.map((r, i) => `  ${String(i + 1).padStart(2, ' ')}) ${r.label}`),
        ]);
        process.stderr.write(`number [1-${rows.length}], or q: `);
        const answer = probe.readAnswer();
        process.stderr.write('\n');
        if (answer !== null && answer !== '' && !/[^0-9]/.test(answer)) {
            const n = Number(answer);
            if (n >= 1 && n <= rows.length) picked = rows[n - 1].id;
        }
    }

    if (picked === '') {
        complain(['drover: no session picked']);
        return 1;
    }
    say([picked]);
    return 0;
}
