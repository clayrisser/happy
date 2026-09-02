/**
 * `drover sessions` — every agent session the drover can see (DROVE-16,
 * DROVE-36, DROVE-56, DROVE-57, DROVE-58, DROVE-66, DROVE-81), in node
 * (DROVE-315).
 *
 * The registry is built two ways: live, from the session hooks (which carry
 * their own TMUX_PANE and DROVER_ACCOUNT, so the binding is measured rather
 * than guessed), and backfilled by scanning ~/.claude/projects. A session
 * whose pane could not be resolved unambiguously is marked `?pane` rather than
 * guessed — a wrong pane means input typed at the wrong window.
 *
 * A straight port of cattle-drover/libexec/drover-sessions and the
 * lib/drover-fixtures.sh + lib/drover-bus.sh it sourced: the same arguments,
 * the same exit codes, the same lines.
 *
 * THE TABLE IS THE PORT'S HARD PART, and the shell's one enormous jq program
 * is its spec. Every column width is computed from the data, so a long account
 * name cannot shift the ones after it. Padding counts CODEPOINTS, never bytes —
 * printf's `%-Ns` counts bytes, so a cwd with any non-ASCII character in it
 * pads short and skews the row; jq's `length` counts codepoints, which is what
 * a terminal draws, and `Array.from` is the node spelling of that. Control
 * characters are REPLACED with the middle dot (codepoint 183) rather than
 * dropped, because this renderer emits finished strings and a title with a real
 * newline in it would otherwise BE a second row. The cwd is elided from the
 * LEFT (the tail identifies the project) and the title from the RIGHT, and the
 * trailing spaces come off with `sub(" +$"; "")` so a row never ends in
 * whitespace. Measured against a session whose cwd was
 * `~/Projects/evil<LF>newline<TAB>dir`: old renderer 6 lines for 3 sessions,
 * one of them 443 columns wide; this one 4 lines, none over the terminal.
 *
 * ONE SESSION IS ONE ROW, at any width, and nothing wraps.
 *
 * WHAT ELSE IS LOAD-BEARING HERE:
 *
 *   `reclaim` is a NOUN-then-VERB, not a flag: it does not read the bus at
 *   all, it reads the shared session store on disk. Dispatched before the flag
 *   loop so the loop keeps refusing everything it does not know (DROVE-66).
 *   The shell `exec`d libexec/drover-reclaim-sessions; this awaits the ported
 *   ./reclaim-sessions in THIS process, so there is still one implementation.
 *
 *   The flag loop is a LOOP, not a single `case "$1"`. The one-shot version
 *   read $1 and dropped everything after it, so `drover sessions --all --json`
 *   printed the table and `drover sessions --json --all` printed 20 rows —
 *   both silently, both wrong in the direction of ignoring what you asked for.
 *
 *   Three bus outcomes, three answers (BASED-110). Emptiness is NOT evidence
 *   of an unreachable bus: a timeout means it is up and slow, a 200 with no
 *   sessions means there are no sessions, and a 200 with an empty BODY is a
 *   bug in the bus rather than a connection problem. Saying "unreachable" for
 *   all three sent Clay to restart a daemon that was already healthy.
 *
 *   Fixture rows are hidden from the table and from `--json` alike (DROVE-81),
 *   filtered once so both and the empty-list sentence see the same rows, and
 *   the count is said out loud on stderr so a session that seems to have
 *   vanished has a sentence explaining where it went.
 *
 * Help answers before anything else — no env read, no bus, no disk — the way
 * the shell answered it inside the flag loop before a single request.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BusError, busGet } from './bus';
import { droverEnv } from './env';
import { flavorOf, ledgerFileOf, ledgerRows, readLedger, refreshRows } from './happyLedger';

const HELP = `drover sessions — what is running, where, and on which account.

USAGE
  drover sessions          The 20 most recently active
  drover sessions --all    Up to 200
  drover sessions --json   /v1/sessions as JSON, subagent tree included;
                           fixture rows hidden like the table (see FIXTURES)
  drover sessions reclaim  The disk the session-store merge parked, and what
                           deleting it would REALLY free. Reports only until
                           you add --apply; see its own --help.
  drover sessions --sweep-fixtures [--apply]
                           The test-harness transcripts already in the store
                           (see FIXTURES), one path per line. Lists only until
                           you add --apply; then it removes exactly what it
                           listed and prints each path as it goes.

COLUMNS
  state   live · idle · ended
  harness which agent this is (claude-code · cursor · opencode · codex · pi). It is HIDDEN
          while every session is the same harness, which is every machine that
          has not started one of the others — a column with one value in it is
          noise, not information.
  flavor  the server's word for the harness (claude · codex · cursor · opencode ·
          gemini · pi), on every row once a session the daemon registered is in
          the table (see HARNESS SESSIONS). It stands in for HARNESS then, since
          it says the same thing at finer grain.
  acct    which account the session is on, worked out from the config dir the
          process is actually using rather than from a wrapper stamp, so a
          session started bare gets a name too (DROVE-31). A \`-\` here now means
          the bus has heard nothing from that session's hooks at all — an idle
          row the scanner found on disk, not a live one
  subs    live subagents under that session
          ?   not counted yet — the registry is built in the background, so a
              bus that has just started reports this for every row
          N+  N shown, more exist than the per-session cap
  pane    the tmux pane input is routed to
          -       no pane. Nothing is lost: a message goes down the session's
                  own messaging socket, which is the better channel anyway
          phone   started from the phone (the daemon spawned it), so there is
                  no terminal of its own to type into
          ?pane   could not be resolved unambiguously — input routing for that
                  session will refuse rather than type into the wrong window
          no-input  nothing can reach this session. Two ways to earn it: a
                  Cursor session with no pane, because cursor-agent binds no
                  messaging socket and the pane is its only way in (DROVE-57);
                  or an OpenCode session whose pane process registered no HTTP
                  port, because that port is its only way in (DROVE-56). A
                  Claude session never says this — a missing pane there is a
                  detail, since the socket is the better channel anyway.

HARNESS SESSIONS (DROVE-389). The bus registry is built from Claude Code's
hooks and its transcripts, so a codex, cursor, opencode, gemini or pi session
was on the phone and nowhere here. Every session that reports itself to the
daemon is in <happy home>/sessions.json, whatever its flavor; the ones the bus
does not carry are read from there and merged in, live while their process is
and ended once it is gone, never a second row for a Claude session the bus
already shows. The happy server is asked, best effort, which of them the phone
has already archived; when it cannot be, one line on stderr says so.
DROVER_HAPPY_TIMEOUT_S caps that ask (default 5).

FIXTURES (DROVE-81). The bats and vitest harnesses used to run a real claude
against the shared session store, so every test run left an idle row here. A
row whose cwd is under /private/tmp/happy-testing-ground-*,
/private/tmp/happy-claude-goal-fixtures*, /private/tmp/drover-trust-test* or
*/environments/data/envs/*/project (a worktree's copy included) is hidden, from
the table and from --json alike, and one line on stderr says how many were.
DROVER_SHOW_FIXTURES=1 shows them. The rule is lib/drover-fixtures.sh, shared
with pick-session so the picker and this table agree.

ONE SESSION IS ONE ROW. Columns are sized from the data, so a long account
name cannot shift the ones after it; the cwd is elided from the LEFT (the tail
identifies the project) and the title from the right, to whatever the terminal
is wide. \`--json\` carries both in full. Override the assumed width with
DROVER_SESSIONS_WIDTH when piping somewhere wider than 120 columns.

See also: drover status (bus health) · drover accounts (headroom)
`;

type Env = Record<string, string | undefined>;

/**
 * The one place this verb asks the machine anything (the shell's `[ -t 1 ]`
 * and `tput cols`). The default asks for real; a test hands in one that
 * answers from a fixture, or one that THROWS, which is how "no terminal was
 * consulted" is proven rather than promised.
 */
export interface SessionsProbe {
    /** `[ -t 1 ]` — is stdout a terminal? */
    stdoutIsTty(): boolean;
    /** `tput cols`, trimmed the way `$(...)` trims it; '' when it fails. */
    tputCols(): string;
}

export const systemProbe: SessionsProbe = {
    stdoutIsTty: () => Boolean(process.stdout.isTTY),
    tputCols: () => {
        // stdin and stderr inherited, as they are under `$(tput cols)`: tput
        // asks the TERMINAL for its size, and a pipe on all three fds leaves it
        // answering from terminfo instead of from the window.
        const r = spawnSync('tput', ['cols'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
        if (r.error || r.status !== 0) return '';
        return (r.stdout ?? '').trim();
    },
};

export interface SessionsOptions {
    /** The environment; process.env unless a test says otherwise. */
    env?: Env;
    /** How the terminal is asked how wide it is. */
    probe?: SessionsProbe;
    /** The clock, in epoch milliseconds — jq's `now * 1000`. */
    now?: () => number;
    /** $HOME, for the `~` elision and the default projects dir. */
    home?: string;
}

// --- lib/drover-fixtures.sh, both spellings ---------------------------------
//
// THREE PATTERNS, one rule, spelled twice — exactly as the shell spells it
// twice, once for `case` and once for jq, because this verb filters inside the
// render and pick-session decides before it reads a directory. Keep them
// identical with pick-session.ts's copy; a row hidden by one verb and shown by
// the other is the confusion this exists to end.
//
//   /private/tmp/happy-testing-ground-*        the fork's plan-mode fixture. It
//                                              is made as /tmp/..., which Claude
//                                              Code resolves to /private/tmp on
//                                              a Mac, so both spellings count.
//   /private/tmp/happy-claude-goal-fixtures*   the fork's goal-status fixture.
//   /private/tmp/drover-trust-test*            tests/trust.bats' scratch cwd.
//   */environments/data/envs/*/project         the fork's integration
//                                              environments, wherever the
//                                              checkout is. A worktree under
//                                              ~/.cache/drover-worktrees/ has
//                                              its own copy at the same
//                                              relative path, so this covers
//                                              those too.
//
// NOT ~/.cache/drover-worktrees/* as a whole. A worktree is where an agent, or
// Clay, starts a real session; hiding the directory would hide that session.
// Only the envs copy inside it is a fixture.

const FIXTURE_PREFIXES = [
    '/private/tmp/happy-testing-ground-',
    '/tmp/happy-testing-ground-',
    '/private/tmp/happy-claude-goal-fixtures',
    '/tmp/happy-claude-goal-fixtures',
    '/private/tmp/drover-trust-test',
    '/tmp/drover-trust-test',
];

const FIXTURE_ENVS = /\/environments\/data\/envs\/[^/]+\/project(\/|$)/;

/**
 * The jq half of the rule (`def fixture($home)`), which is what filters the
 * bus body. `$home` is unused there too, kept so a home-relative pattern can
 * arrive without changing every caller.
 */
export function fixtureCwd(value: unknown): boolean {
    const cwd = jqToString(value ?? '');
    return FIXTURE_PREFIXES.some((p) => cwd.startsWith(p)) || FIXTURE_ENVS.test(cwd);
}

/** `fixtures_shown` — DROVER_SHOW_FIXTURES=1 turns the rule off for a run. */
export function fixturesShown(env: Env): boolean {
    return (env.DROVER_SHOW_FIXTURES ?? '0') === '1';
}

/**
 * The same three on a projects/ directory NAME, which is the cwd with every
 * character outside [A-Za-z0-9-] turned into a dash. Only for a transcript
 * whose head names no cwd; the name loses the difference between `/` and `-`,
 * so the real path is the better witness whenever it can be read.
 *
 * These are `case` globs in the shell, where `*` crosses a `/` happily — hence
 * `[\s\S]*` rather than the jq rule's `[^/]+`.
 */
export function fixtureProjectName(name: string): boolean {
    return /^-private-tmp-happy-testing-ground-/.test(name)
        || /^-tmp-happy-testing-ground-/.test(name)
        || /^-private-tmp-happy-claude-goal-fixtures/.test(name)
        || /^-tmp-happy-claude-goal-fixtures/.test(name)
        || /^-private-tmp-drover-trust-test/.test(name)
        || /^-tmp-drover-trust-test/.test(name)
        || /-environments-data-envs-[\s\S]*-project$/.test(name)
        || /-environments-data-envs-[\s\S]*-project-/.test(name);
}

// --- jq's string and JSON primitives, in node --------------------------------

/** Codepoints, because that is what jq's `length`, `explode` and `.[a:b]` count. */
function cps(s: string): string[] {
    return Array.from(s);
}

/** jq's `length` on a string. */
export function jqLen(s: string): number {
    return cps(s).length;
}

/** jq's `.[a:b]` on a string. */
function jqSlice(s: string, a: number, b?: number): string {
    return cps(s).slice(a, b).join('');
}

/** jq's `tostring`: a string is itself, anything else is its compact JSON. */
export function jqToString(v: unknown): string {
    return typeof v === 'string' ? v : jqJson(v, null, 0);
}

/** jq's `//`: null and false take the alternative, everything else does not. */
function alt<T>(v: unknown, fallback: T): unknown {
    return v === null || v === undefined || v === false ? fallback : v;
}

/** jq's `// ""`, the shape `clean` and `tostring` want. */
function orEmpty(v: unknown): unknown {
    return alt(v, '');
}

/**
 * jq's string escaping, which is JSON's plus one: jq escapes DEL (\\u007f) and
 * JSON.stringify does not. Everything else — the \\b \\f \\n \\r \\t shortcuts,
 * an unescaped `/`, raw UTF-8 for anything printable — is the same, so this is
 * JSON.stringify with that one hole filled.
 */
function jqEscape(s: string): string {
    let out = '"';
    for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0;
        if (ch === '"') out += '\\"';
        else if (ch === '\\') out += '\\\\';
        else if (c === 8) out += '\\b';
        else if (c === 12) out += '\\f';
        else if (c === 10) out += '\\n';
        else if (c === 13) out += '\\r';
        else if (c === 9) out += '\\t';
        else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
        else out += ch;
    }
    return `${out}"`;
}

/**
 * `jq .` and `jq -c .`: two-space indent when `indent` is 2, compact when it is
 * null. Object keys keep their order, as jq's do. Numbers are printed the way
 * node prints them, with `-0` kept negative the way jq keeps it.
 */
export function jqJson(v: unknown, indent: 2 | null, depth = 0): string {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
        if (Object.is(v, -0)) return '-0';
        if (!Number.isFinite(v)) return 'null';
        return String(v);
    }
    if (typeof v === 'string') return jqEscape(v);
    const pad = indent === null ? '' : ' '.repeat((depth + 1) * indent);
    const close = indent === null ? '' : ' '.repeat(depth * indent);
    const nl = indent === null ? '' : '\n';
    const sep = indent === null ? ':' : ': ';
    if (Array.isArray(v)) {
        if (v.length === 0) return '[]';
        return `[${nl}${v.map((x) => pad + jqJson(x, indent, depth + 1)).join(`,${nl}`)}${nl}${close}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return '{}';
    const body = entries.map(([k, x]) => `${pad}${jqEscape(k)}${sep}${jqJson(x, indent, depth + 1)}`).join(`,${nl}`);
    return `{${nl}${body}${nl}${close}}`;
}

/**
 * jq's `length` on any value. Null for the values jq refuses (a boolean has no
 * length), which is what makes the shell's `|| count=` fire and the verb say
 * the body is not the expected JSON.
 */
export function jqLength(v: unknown): number | null {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return null;
    if (typeof v === 'number') return Math.abs(v);
    if (typeof v === 'string') return jqLen(v);
    if (Array.isArray(v)) return v.length;
    return Object.keys(v as object).length;
}

// --- the renderer, def for def ------------------------------------------------

/** `def clean`: control characters become the middle dot, never disappear. */
export function clean(v: unknown): string {
    return cps(jqToString(orEmpty(v)))
        .map((ch) => {
            const c = ch.codePointAt(0) ?? 0;
            return c < 32 || c === 127 ? '·' : ch;
        })
        .join('');
}

/** `def tilde`: $HOME, and only a whole $HOME, becomes `~`. */
export function tilde(s: string, home: string): string {
    if (s.startsWith(`${home}/`)) return `~${jqSlice(s, jqLen(home))}`;
    if (s === home) return '~';
    return s;
}

/** `def pad($n)`: to the right, in codepoints, never shrinking. */
function pad(s: string, n: number): string {
    const gap = n - jqLen(s);
    return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** `def head($n)`: keep the front, mark the cut with a trailing ellipsis. */
function headTo(s: string, n: number): string {
    return jqLen(s) > n ? `${jqSlice(s, 0, n - 1)}…` : s;
}

/** `def tail($n)`: keep the TAIL — the end of a cwd is what names the project. */
function tailTo(s: string, n: number): string {
    const l = jqLen(s);
    return l > n ? `…${jqSlice(s, l - n + 1)}` : s;
}

/** One session, reduced to the strings the table draws. */
export interface TableRow {
    id: string;
    state: string;
    acct: string;
    subs: string;
    harness: string;
    /** The server's word for the harness; drawn only once a row carries one. */
    flavor: string;
    hasFlavor: boolean;
    pane: string;
    mode: string;
    cwd: string;
    title: string;
}

/** DROVE-36's map: the mode names Claude Code uses, cut to the word that tells them apart. */
const MODES: Record<string, string> = {
    bypassPermissions: 'yolo',
    acceptEdits: 'edits',
    plan: 'plan',
    auto: 'auto',
    default: 'manual',
    dontAsk: 'dontask',
};

type Session = Record<string, unknown>;

function arrayOf(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

/** The `[ .sessions[] | { ... } ]` object, field for field. */
export function tableRow(s: Session, home: string): TableRow {
    const subagents = arrayOf(s.subagents ?? []);
    let subs: string;
    if (s.subagentsPending) subs = '?';
    else if (s.subagentsTruncated) subs = `${subagents.length}+`;
    else if (subagents.length === 0) subs = '-';
    else subs = String(subagents.length);

    // A harness whose ONLY way in is the pane, with no pane, cannot be typed
    // into at all — and "-" says the opposite, because for Claude Code it means
    // "no pane, but the socket is better anyway". Two different facts had one
    // spelling (DROVE-57). And a harness whose only way in is its own HTTP API,
    // with no endpoint on record, is equally unreachable (DROVE-56). Same word,
    // because it is the same fact: nothing can type here.
    const channel = alt(s.inputChannel, 'socket');
    let pane: string;
    if (s.paneAmbiguous) pane = '?pane';
    else if (s.pane) pane = clean(s.pane);
    else if (s.origin === 'daemon') pane = 'phone';
    else if (channel === 'pane') pane = 'no-input';
    else if (channel === 'api' && (s.endpoint ?? null) === null) pane = 'no-input';
    else pane = '-';

    // DROVE-36. The mode names Claude Code uses are long and this row already
    // fights for width, so each is cut to the word that tells it apart.
    // `manual` rather than `default` because that is what the pane footer says
    // (manual mode on), and a column that disagrees with the screen is worse
    // than no column. A dash means we could not tell, never a mode.
    const permission = s.permissionMode;
    const mapped = MODES[jqToString(alt(permission, ''))];
    const mode = clean(mapped === undefined ? alt(permission, '-') : mapped);

    return {
        id: jqSlice(jqToString(orEmpty(s.id)), 0, 8),
        state: clean(s.state),
        acct: clean(alt(s.account, '-')),
        subs,
        harness: clean(alt(s.harness, 'claude-code')),
        // A bus row has no flavor of its own; its harness says it (DROVE-389).
        flavor: clean(alt(s.flavor, flavorOf(alt(s.harness, 'claude-code')))),
        hasFlavor: s.flavor !== undefined && s.flavor !== null,
        pane,
        mode,
        cwd: tilde(clean(alt(s.cwd, '-')), home),
        title: clean(alt(s.title, '')),
    };
}

/**
 * The finished table: the header line and one line per session, each with its
 * trailing spaces stripped (`sub(" +$"; "")`), sized to `width`.
 */
export function renderTable(sessions: Session[], width: number, home: string): string[] {
    const rows = sessions.map((s) => tableRow(s, home));
    const widest = (header: string, pick: (r: TableRow) => string): number =>
        Math.max(jqLen(header), ...rows.map((r) => jqLen(pick(r))));
    const wid = widest('ID', (r) => r.id);
    const wst = widest('STATE', (r) => r.state);
    const wac = widest('ACCT', (r) => r.acct);
    const wsu = widest('SUBS', (r) => r.subs);
    const wpa = widest('PANE', (r) => r.pane);
    const wmo = widest('MODE', (r) => r.mode);
    // FLAVOR once any row carries one, which is once the daemon's ledger has
    // put a codex, cursor, opencode, gemini or pi session in the table
    // (DROVE-389). It is the server's word for the same fact HARNESS states,
    // at finer grain, so it stands in for HARNESS rather than sitting beside
    // it: two columns saying one thing cost every row the width of a cwd.
    const flavored = rows.some((r) => r.hasFlavor);
    const wfl = flavored ? widest('FLAVOR', (r) => r.flavor) : 0;
    // HIDDEN while every session is the same harness: a column with one value
    // in it is noise, not information.
    const mixed = new Set(rows.map((r) => r.harness)).size > 1;
    const wha = !flavored && mixed ? widest('HARNESS', (r) => r.harness) : 0;
    const tmax = rows.length === 0 ? 0 : Math.max(...rows.map((r) => jqLen(r.title)));
    const wti = tmax === 0 ? 0 : Math.min(24, Math.max(5, tmax));
    const fixed = wid + wst + wac + wsu + wpa + wmo + 6 + (wha > 0 ? wha + 1 : 0) + (wfl > 0 ? wfl + 1 : 0);
    const wcw = Math.max(16, width - fixed - (wti > 0 ? wti + 1 : 0));

    const strip = (s: string): string => s.replace(/ +$/, '');
    const out: string[] = [];
    out.push(strip(
        `${pad('ID', wid)} ${pad('STATE', wst)} ${pad('ACCT', wac)} `
        + (wfl > 0 ? `${pad('FLAVOR', wfl)} ` : '')
        + (wha > 0 ? `${pad('HARNESS', wha)} ` : '')
        + `${pad('SUBS', wsu)} ${pad('PANE', wpa)} ${pad('MODE', wmo)} `
        + (wti > 0 ? `${pad('CWD', wcw)} TITLE` : 'CWD'),
    ));
    for (const r of rows) {
        out.push(strip(
            `${pad(r.id, wid)} ${pad(r.state, wst)} ${pad(r.acct, wac)} `
            + (wfl > 0 ? `${pad(r.flavor, wfl)} ` : '')
            + (wha > 0 ? `${pad(r.harness, wha)} ` : '')
            + `${pad(r.subs, wsu)} ${pad(r.pane, wpa)} ${pad(r.mode, wmo)} `
            + (wti > 0 ? `${pad(tailTo(r.cwd, wcw), wcw)} ${headTo(r.title, wti)}` : tailTo(r.cwd, wcw)),
        ));
    }
    return out;
}

/**
 * LINEAGE, under the table rather than in it (DROVE-58). A clone is a NEW
 * session seeded with another one's conversation, so the two are separate rows
 * and neither row can say on its own what it is. One session is still one row —
 * adding a column for a relation that is empty on almost every session would
 * cost every row width to say nothing.
 *
 * Folded, never dropped: the full records are in --json, and the ledger behind
 * them is `drover clone --list`.
 */
export function renderClones(sessions: Session[]): string[] {
    const rows = sessions.filter((s) => s.clonedFrom || s.clonedTo);
    if (rows.length === 0) return [];
    const short = (v: unknown): string => jqSlice(jqToString(v), 0, 8);
    const out = ['', 'clones (drover clone --list):'];
    for (const s of rows) {
        const me = short(s.id);
        const from = s.clonedFrom as Session | undefined;
        if (from) {
            out.push(`  ${me} was cloned from ${short(from.session)} (${jqToString(alt(from.harness, '?'))})`);
        }
        for (const raw of arrayOf(s.clonedTo ?? [])) {
            const to = raw as Session;
            const harness = jqToString(alt(to.harness, '?'));
            out.push(
                `  ${me} was cloned into `
                + (to.session ? `${short(to.session)} (${harness})` : `${harness} — that session has not spoken yet`),
            );
        }
    }
    return out;
}

/**
 * The stale note, on stderr. The registry is built in the background, so say
 * how old this answer is when it is not fresh. Silence here would be the same
 * lie in a smaller font.
 */
export function renderStaleNote(body: Session, nowMs: number): string[] {
    if (!body.stale) return [];
    const at = body.scannedAt;
    if (at === null || at === undefined || at === false) return ['note: the session registry is stale (never scanned)'];
    const ago = Math.floor((nowMs - Number(at)) / 1000);
    return [`note: the session registry is stale (last scanned ${ago}s ago)`];
}

/**
 * How wide we are allowed to be. A tty tells us; a pipe does not, so 120 is the
 * assumption there rather than "unbounded" — an unbounded row is the wrap this
 * whole renderer exists to kill, and `less -S` is not a thing anyone remembers.
 */
export function resolveWidth(env: Env, probe: SessionsProbe): number {
    let width = env.DROVER_SESSIONS_WIDTH ?? '';
    if (width === '' && probe.stdoutIsTty()) width = probe.tputCols();
    if (width === '' || /[^0-9]/.test(width)) width = '120';
    const n = Number(width);
    return n >= 60 ? n : 60;
}

// --- --sweep-fixtures: the transcripts the harnesses already left --------------
//
// Disk, not the bus, like `reclaim`: the rows the filter above hides are backed
// by real transcripts in the store, and the registry re-adopts them on every
// scan until the files are gone. Dry run by default, the same contract as
// drover-share-sessions and reclaim: the plan is computed and printed, and
// --apply executes THAT plan, so what you read is what runs.
//
// WHAT DECIDES. The cwd the transcript itself recorded, read from its head, is
// the witness; the munged directory name only stands in when no line names a
// cwd. The name turns `/` and `-` into the same dash, so a real project that
// merely LOOKS like a fixture by name is kept when its transcript says where it
// really ran. Only directories directly under the projects dir are candidates,
// never through a symlink, and nothing outside that dir is touched.

/** The head window `head -c 65536` reads, and no more. Transcripts run to 190 MB. */
const HEAD_BYTES = 65536;

/**
 * The newest transcript's first line that carries a cwd. 64 KB from the front,
 * never the whole file, and a torn last line is skipped rather than fatal
 * (jq's `fromjson?`).
 */
export function transcriptCwd(dir: string): string {
    let newest = '';
    let newestAt = -Infinity;
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return '';
    }
    // `ls -t | head -1`: newest mtime first, ties broken by name ascending.
    for (const name of names.slice().sort()) {
        if (!name.endsWith('.jsonl')) continue;
        const f = join(dir, name);
        let st;
        try {
            st = statSync(f);
        } catch {
            continue;
        }
        if (!st.isFile()) continue;
        if (st.mtimeMs > newestAt) {
            newestAt = st.mtimeMs;
            newest = f;
        }
    }
    if (!newest) return '';
    let head = '';
    try {
        const fd = openSync(newest, 'r');
        try {
            const buf = Buffer.alloc(HEAD_BYTES);
            head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
        } finally {
            closeSync(fd);
        }
    } catch {
        return '';
    }
    for (const line of head.split('\n')) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        // `objects | .cwd // empty`: only an object answers, and only a truthy cwd.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const cwd = (parsed as Session).cwd;
        if (cwd === null || cwd === undefined || cwd === false || cwd === '') continue;
        // `jq -r | head -1`: a raw string, and only its first line.
        return jqToString(cwd).split('\n')[0];
    }
    return '';
}

/** `find "$d" -type f`: fts pre-order, in readdir order, following nothing. */
export function findFiles(dir: string, out: string[] = []): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of names) {
        const p = join(dir, name);
        let st;
        try {
            st = lstatSync(p);
        } catch {
            continue;
        }
        if (st.isDirectory()) findFiles(p, out);
        else if (st.isFile()) out.push(p);
    }
    return out;
}

/**
 * `du -sk "$d"`: the 512-byte blocks the tree really occupies — files AND the
 * directories themselves — with a hard-linked inode counted once, rounded up to
 * kilobytes the way BSD du's `howmany` rounds.
 */
export function duKb(dir: string): number {
    const seen = new Set<string>();
    let blocks = 0;
    const visit = (p: string): void => {
        let st;
        try {
            st = lstatSync(p);
        } catch {
            return;
        }
        if (st.nlink > 1) {
            const key = `${st.dev}:${st.ino}`;
            if (seen.has(key)) return;
            seen.add(key);
        }
        blocks += Number(st.blocks ?? 0);
        if (!st.isDirectory()) return;
        let names: string[];
        try {
            names = readdirSync(p);
        } catch {
            return;
        }
        for (const name of names) visit(join(p, name));
    };
    visit(dir);
    return Math.ceil(blocks / 2);
}

/**
 * Pathname expansion SORTS, and the shell sorts it the LOCALE's way. That is
 * not a detail: under LANG=en_US.UTF-8 the collation ignores the leading dashes
 * these munged project names are made of and `-Users-…` lands after `-tmp-…`,
 * while under LANG unset (the C locale, which is what a spawned verb with a
 * scrubbed environment gets) it is plain byte order and `-Users-…` comes first.
 * `Intl.Collator` on the locale the caller actually has agrees with
 * `for d in "$projects"/*` in both worlds.
 */
export function globOrder(env: Env): (a: string, b: string) => number {
    const bytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const locale = (env.LC_ALL || env.LC_COLLATE || env.LANG || '').split('.')[0];
    if (locale === '' || locale === 'C' || locale === 'POSIX') return bytes;
    try {
        return new Intl.Collator(locale.replace('_', '-')).compare;
    } catch {
        return bytes;
    }
}

export interface SweepDir {
    /** The directory under the projects dir. */
    dir: string;
    /** The line that names it: the recorded cwd, else the munged name. */
    label: string;
    /** Every file inside it, in `find` order. */
    files: string[];
    /** Its `du -sk`. */
    kb: number;
}

/** What --sweep-fixtures would remove, computed before a byte of it is touched. */
export function sweepPlan(projects: string, env: Env = process.env): SweepDir[] {
    let names: string[];
    try {
        names = readdirSync(projects);
    } catch {
        return [];
    }
    const plan: SweepDir[] = [];
    for (const name of names.slice().sort(globOrder(env))) {
        const d = join(projects, name);
        let st;
        try {
            st = lstatSync(d);
        } catch {
            continue;
        }
        // `[ -d "$d" ] || continue` then `[ -L "$d" ] && continue`: a directory,
        // and never through a symlink.
        if (st.isSymbolicLink()) continue;
        if (!st.isDirectory()) continue;
        const cwd = transcriptCwd(d);
        if (cwd) {
            if (!fixtureCwd(cwd)) continue;
        } else if (!fixtureProjectName(name)) continue;
        plan.push({ dir: d, label: cwd || name, files: findFiles(d), kb: duKb(d) });
    }
    return plan;
}

// --- the verb ------------------------------------------------------------------

function say(lines: string[]): void {
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
}

function complain(lines: string[]): void {
    if (lines.length) process.stderr.write(`${lines.join('\n')}\n`);
}

interface Flags {
    asJson: boolean;
    limit: string;
    sweep: boolean;
    sweepApply: boolean;
}

type Parsed = Flags | { help: true } | { code: number; error: string };

/**
 * A LOOP, not a single `case "$1"`. The one-shot version read $1 and dropped
 * everything after it, so `drover sessions --all --json` printed the table and
 * `drover sessions --json --all` printed 20 rows — both silently, both wrong in
 * the direction of ignoring what you asked for.
 */
export function parseArgs(args: string[]): Parsed {
    const flags: Flags = { asJson: false, limit: '', sweep: false, sweepApply: false };
    for (const arg of args) {
        switch (arg) {
            case '--json':
                flags.asJson = true;
                break;
            case '--all':
                flags.limit = '200';
                break;
            case '--sweep-fixtures':
                flags.sweep = true;
                break;
            case '--apply':
                flags.sweepApply = true;
                break;
            case '-h':
            case '--help':
                return { help: true };
            default:
                return {
                    code: 2,
                    error: `drover sessions: unknown argument '${arg}' (try --all, --json, --sweep-fixtures or --help)`,
                };
        }
    }
    return flags;
}

export async function run(args: string[], opts: SessionsOptions = {}): Promise<number> {
    // `drover sessions reclaim` is a NOUN-then-VERB, not a flag: it does not
    // read the bus at all, it reads the shared session store on disk.
    // Dispatched before the flag loop so the loop keeps refusing everything it
    // does not know (DROVE-66). The shell `exec`d libexec/drover-reclaim-sessions;
    // this awaits the ported one in THIS process, so there is one reader still.
    if (args[0] === 'reclaim') {
        const { run: reclaim } = await import('./reclaim-sessions');
        return reclaim(args.slice(1));
    }

    const parsed = parseArgs(args);
    if ('help' in parsed) {
        process.stdout.write(HELP);
        return 0;
    }
    if ('code' in parsed) {
        complain([parsed.error]);
        return parsed.code;
    }

    const env = opts.env ?? process.env;
    const probe = opts.probe ?? systemProbe;
    const home = opts.home ?? env.HOME ?? homedir();
    const nowMs = opts.now ?? ((): number => Date.now());

    if (parsed.sweepApply && !parsed.sweep) {
        complain(['drover sessions: --apply only means something with --sweep-fixtures']);
        return 2;
    }

    if (parsed.sweep) {
        const projects = env.DROVER_PROJECTS_DIR || join(home, '.claude', 'projects');
        let ok = false;
        try {
            ok = statSync(projects).isDirectory();
        } catch {
            ok = false;
        }
        if (!ok) {
            complain([`drover sessions --sweep-fixtures: no projects dir at ${projects}`]);
            return 1;
        }
        const verb = parsed.sweepApply ? 'remove' : 'would remove';
        const out: string[] = [];
        if (!parsed.sweepApply) out.push('DRY RUN: nothing will be removed. Re-run with --apply to remove what is listed.');
        out.push(`store: ${projects}`);
        const plan = sweepPlan(projects, env);
        let dirs = 0;
        let files = 0;
        let kb = 0;
        for (const d of plan) {
            out.push(d.label);
            for (const f of d.files) out.push(`  ${verb} ${f}`);
            if (parsed.sweepApply) rmSync(d.dir, { recursive: true, force: true });
            dirs += 1;
            files += d.files.length;
            kb += d.kb;
        }
        const mb = Math.floor(kb / 1024);
        out.push(parsed.sweepApply
            ? `sweep-fixtures: removed ${files} files in ${dirs} project dirs (${mb} MB) from ${projects}`
            : `sweep-fixtures: would remove ${files} files in ${dirs} project dirs (${mb} MB); re-run with --apply`);
        say(out);
        return 0;
    }

    const denv = droverEnv(env, home);
    const path = `/v1/sessions${parsed.limit ? `?limit=${parsed.limit}` : ''}`;
    const timeoutS = Number(env.DROVER_SESSIONS_TIMEOUT_S || '15');

    // Three outcomes, three answers. Emptiness is NOT evidence of an
    // unreachable bus: a timeout means it is up and slow, and a 200 with no
    // sessions means there are no sessions. Saying "unreachable" for all three
    // sent Clay to restart a daemon that was already healthy.
    let res;
    try {
        res = await busGet(path, timeoutS * 1000, denv.droverUrl);
    } catch (error) {
        if (error instanceof BusError) {
            complain(error.explain('/v1/sessions'));
            return 1;
        }
        throw error;
    }

    if (res.body === '') {
        complain([
            'drover sessions: the bus answered with an empty body — that is a bug in the',
            `  bus, not a connection problem. Check its log: ${denv.stateDir}/logs/bus.log`,
        ]);
        return 1;
    }

    let body: Session | null = null;
    let count: number | null = null;
    try {
        const parsedBody = JSON.parse(res.body) as unknown;
        // `jq '.sessions | length'` reaches `.sessions` on an object only; on
        // anything else jq raises and the shell's `|| count=` fires.
        if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
            body = parsedBody as Session;
            count = jqLength(body.sessions ?? null);
        }
    } catch {
        body = null;
    }
    if (!body || count === null) {
        complain([
            'drover sessions: the bus answered but the body is not the expected JSON:',
            // `printf '  %.200s\n'` — the first 200 BYTES of it, no more.
            `  ${Buffer.from(res.body, 'utf8').subarray(0, 200).toString('utf8')}`,
        ]);
        return 1;
    }

    // FIXTURES OUT, unless asked for (DROVE-81). Filtered here, once, so the
    // table, --json and the empty-list sentence all see the same rows; and said
    // out loud on stderr, so a session that seems to have vanished has a
    // sentence explaining where it went and the switch that brings it back.
    //
    // The shell's `.sessions |= map(...)` raises on a body with no sessions
    // array and `set -e` kills the verb with jq's own words and exit 5. That is
    // the ONE place this port does not reproduce the shell: the same body
    // already reads as "no sessions" under DROVER_SHOW_FIXTURES=1, so the
    // crash is plainly the defect and not the contract.
    let sessions = arrayOf(body.sessions ?? []);

    // HARNESS SESSIONS (DROVE-389). The bus knows what Claude Code's hooks and
    // transcripts tell it; the daemon's ledger knows every session that
    // reported itself, whatever its flavor. The rows the bus does not carry
    // come from the ledger, newest first, capped like the bus's own list, and
    // the server is asked which the phone has already archived. A bus body
    // with nothing to add is rendered exactly as before, byte for byte.
    const ledger = readLedger(ledgerFileOf(env, home), nowMs());
    const known = new Set(sessions.map((s) => (s as Session)?.id));
    let merged = ledgerRows(ledger).filter((r) => !known.has(r.id));
    if (merged.length > 0) {
        const timeoutMs = Number(env.DROVER_HAPPY_TIMEOUT_S || '5') * 1000;
        const refreshed = await refreshRows(merged, ledger, env, home, timeoutMs);
        if (refreshed.note) complain([refreshed.note]);
        merged = refreshed.rows.slice(0, Number(parsed.limit || '20'));
        sessions = [...sessions, ...merged];
        body = { ...body, sessions };
        count = sessions.length;
    }

    if (!fixturesShown(env)) {
        const kept = sessions.filter((s) => !fixtureCwd((s as Session)?.cwd ?? null));
        const hidden = sessions.length - kept.length;
        sessions = kept;
        body = { ...body, sessions: kept };
        count = kept.length;
        if (hidden > 0) {
            complain([`note: ${hidden} fixture row(s) hidden (test-harness cwd); DROVER_SHOW_FIXTURES=1 shows them`]);
        }
    }

    if (parsed.asJson) {
        say([jqJson(body, 2)]);
        return 0;
    }

    if (count === 0) {
        say(['no sessions — the drover sees one once it starts, or once its transcript exists']);
        return 0;
    }

    complain(renderStaleNote(body, nowMs()));
    say(renderTable(sessions as Session[], resolveWidth(env, probe), home));
    say(renderClones(sessions as Session[]));
    return 0;
}
