/**
 * `drover todos` — what a session still needs Clay to DO (DROVE-53), in node
 * (DROVE-315).
 *
 * The terminal half of the needs-you list. `drover needs` raises one; this
 * lists them and closes them. The phone and the wrist show the same records,
 * because there is only one record: a pending bus event of kind `todo`.
 *
 * Two views, deliberately overlapping, the same rule `drover questions`
 * documents: a to-do WITH a session appears both under that session and in
 * the full list, so no surface has to choose which half to render.
 *
 * A straight port of cattle-drover/libexec/drover-todos: the same arguments,
 * the same exit codes, the same lines. The jq program that drew the table is
 * `render` below, line for line, and the expectations in todos.test.ts are
 * that jq program's OUTPUT on the same events, so a person who reads the
 * shell's list reads the same list here. tests/needsyou.bats stays the spec
 * until the shell file leaves.
 */

import { BusError, busGet, busPost } from './bus';

const USAGE = `drover todos — the things a session needs you to do, until you have done them.

USAGE
  drover todos                      Everything still open, grouped by session
  drover todos --session <id>       Only that session's
  drover todos --mine               Only this session's ($CLAUDE_CODE_SESSION_ID)
  drover todos --none               Only the ones no session owns
  drover todos --json               The raw events
  drover todos --done <id>          Mark one done. The session waiting on it
                                    unblocks and every other surface dismisses.
  drover todos --drop <id>          Close it without doing it

An id may be given in full or by its first 8 characters, which is what the
list prints.

Raise one:  drover needs "push the release" --why "the lane is blocked"
Envelope:   docs/hitl.md
`;

/** The bus's timeout for both calls, in seconds, as the shell had it. */
const BUS_TIMEOUT_S = 10;

/**
 * A pending `todo` event as GET /v1/events?state=pending lists it. Only the
 * fields the render reads are named; `--json` prints the event whole, so the
 * rest ride along untyped rather than being re-declared here and drifting.
 */
export interface TodoEvent {
    id: string;
    kind: string;
    title: string;
    reason?: string | null;
    preview?: string | null;
    createdAt: number;
    origin?: { sessionId?: string | null; cwd?: string | null; [extra: string]: unknown } | null;
    [extra: string]: unknown;
}

/** Which of the two overlapping views to draw. Neither set is the full list. */
export interface View {
    /** `--session <id>` / `--mine`: only that session's. Empty is no filter. */
    wantSession?: string | null;
    /** `--none`: only the ones no session owns. */
    onlyNone?: boolean;
}

interface Parsed extends View {
    wantSession: string | null;
    onlyNone: boolean;
    asJson: boolean;
    closeId: string | null;
    closeHow: 'done' | 'drop' | null;
}

/**
 * The argument loop, as the shell wrote it: sequential, last one wins, every
 * refusal exit 2 with the shell's sentence.
 */
function parse(args: string[], env: Record<string, string | undefined> = process.env): Parsed | { error: string } {
    const p: Parsed = { wantSession: null, onlyNone: false, asJson: false, closeId: null, closeHow: null };
    for (let i = 0; i < args.length;) {
        const a = args[i];
        switch (a) {
            case '--session':
                if (args.length - i < 2) return { error: 'drover todos: --session needs an id' };
                p.wantSession = args[i + 1];
                i += 2;
                break;
            case '--mine': {
                // CLAUDE_CODE_SESSION_ID, with the CODE_ in it — see drover-needs.
                const mine = env.CLAUDE_CODE_SESSION_ID ?? '';
                if (!mine) return { error: 'drover todos: --mine needs CLAUDE_CODE_SESSION_ID, which is not set here' };
                p.wantSession = mine;
                i += 1;
                break;
            }
            case '--none':
                p.onlyNone = true;
                i += 1;
                break;
            case '--json':
                p.asJson = true;
                i += 1;
                break;
            case '--done':
            case '--drop':
                // An EMPTY value is refused, not merely a missing one. `--done ""`
                // used to satisfy the arity check, leave the id empty, and fall
                // through to printing the list — so a script closing a to-do by
                // a variable that happened to be unset got a listing and exit 0,
                // which reads exactly like success.
                if (args.length - i < 2 || !args[i + 1]) return { error: `drover todos: ${a} needs an event id` };
                p.closeHow = a.slice(2) as 'done' | 'drop';
                p.closeId = args[i + 1];
                i += 2;
                break;
            case '-h':
            case '--help':
                return { error: '' };
            default:
                return { error: `drover todos: unknown argument '${a}' (try --help)` };
        }
    }
    return p;
}

/**
 * The shell's `[.events[]? | select(.kind == "todo")]`, and `[]` when the
 * body is not JSON or carries no events — its `|| open='[]'`, kept on purpose:
 * `state=pending` is the whole definition of "open", and a body that is not a
 * list of events is a list of no events.
 */
export function openTodos(body: string): TodoEvent[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return [];
    }
    const events = parsed && typeof parsed === 'object' ? (parsed as { events?: unknown }).events : undefined;
    if (!Array.isArray(events)) return [];
    return events.filter((e): e is TodoEvent => !!e && typeof e === 'object' && (e as TodoEvent).kind === 'todo');
}

/** jq's `.origin.sessionId`: null when there is no session, or no origin. */
function sessionOf(e: TodoEvent): string | null {
    const s = e.origin?.sessionId;
    return s == null ? null : s;
}

/** The view's filter, shared by the table and `--json` so they cannot disagree. */
export function select(open: TodoEvent[], view: View = {}): TodoEvent[] {
    const only = view.wantSession ?? '';
    if (only !== '') return open.filter((e) => sessionOf(e) === only);
    if (view.onlyNone) return open.filter((e) => sessionOf(e) === null);
    return open;
}

/**
 * jq's `age($ms)`: whole seconds under 90, whole minutes under 90 of those,
 * whole hours after.
 */
export function age(createdAt: number, now: number = Date.now()): string {
    const s = (now - createdAt) / 1000;
    if (s < 90) return `${Math.floor(s)}s`;
    if (s < 5400) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
}

/** jq's `.s[0:n]`: by codepoint, which is what a uuid or a path never tests. */
function first(s: string, n: number): string {
    return Array.from(s).slice(0, n).join('');
}

/**
 * jq's `row`. Reason and preview each add an indented line under the title;
 * an empty, null or absent one adds nothing, as `(.x // "") == ""` had it.
 */
function row(e: TodoEvent, now: number): string[] {
    const lines = [`  ${first(e.id, 8)}  ${(age(e.createdAt, now) + '    ').slice(0, 5)}  ${e.title}`];
    if (e.reason) lines.push(`            ${e.reason}`);
    if (e.preview) lines.push(`            $ ${e.preview}`);
    return lines;
}

/**
 * jq's `group_by(.origin.sessionId // "")`: groups ordered by key, the
 * session-less group (key "") first, input order kept inside a group. jq
 * orders strings by codepoint, which is UTF-8 byte order.
 */
function groupBySession(events: TodoEvent[]): TodoEvent[][] {
    const groups = new Map<string, TodoEvent[]>();
    for (const e of events) {
        const key = sessionOf(e) ?? '';
        const g = groups.get(key);
        if (g) g.push(e);
        else groups.set(key, [e]);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
        .map(([, g]) => g);
}

const HEADER = '  ID        AGE    WHAT';

/**
 * The table, line for line as the jq program drew it. Rendered whole rather
 * than through a tab-delimited read loop, for the reason the shell gave: a
 * read loop collapses runs of tabs, so one empty field silently shifts every
 * column after it.
 */
export function render(open: TodoEvent[], view: View = {}, now: number = Date.now()): string[] {
    const shown = select(open, view);
    if (shown.length === 0) return ['nothing is waiting on you'];
    const out = [HEADER];
    for (const group of groupBySession(shown)) {
        const lead = group[0];
        const sid = sessionOf(lead);
        if (sid === null) {
            out.push('', `no session (${group.length})`);
        } else {
            const cwd = lead.origin?.cwd;
            out.push('', `session ${first(sid, 8)} (${group.length})${cwd == null ? '' : `  ${cwd}`}`);
        }
        for (const e of group) out.push(...row(e, now));
    }
    out.push('', `  ${shown.length} open · mark one done: drover todos --done <id>`);
    return out;
}

/**
 * The list prints eight characters, so eight characters have to be enough to
 * close one. A prefix matching more than one is refused rather than resolved
 * against whichever came back first: closing the wrong to-do silently is how
 * a session unblocks on work nobody did.
 */
export function matchId(open: TodoEvent[], prefix: string): { id: string } | { error: string } {
    const hits = open.filter((e) => e.id === prefix || e.id.startsWith(prefix));
    if (hits.length === 1) return { id: hits[0].id };
    if (hits.length === 0) return { error: `drover todos: no open to-do starts with '${prefix}'` };
    return { error: `drover todos: '${prefix}' matches ${hits.length} open to-dos — give more of the id` };
}

function say(lines: string[]): void {
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

function complain(lines: string[]): void {
    process.stderr.write(lines.join('\n') + '\n');
}

export async function run(args: string[]): Promise<number> {
    const parsed = parse(args);
    if ('error' in parsed) {
        if (parsed.error === '') {
            process.stdout.write(USAGE);
            return 0;
        }
        complain([parsed.error]);
        return 2;
    }

    // One fetch serves both the list and the id-prefix lookup below.
    // `state=pending` is the whole definition of "open" — there is no second
    // flag to fall out of step with the event's own state.
    let res;
    try {
        res = await busGet('/v1/events?state=pending', BUS_TIMEOUT_S * 1000);
    } catch (error) {
        if (error instanceof BusError) {
            complain(error.explain('the events list'));
            return 1;
        }
        throw error;
    }
    const open = openTodos(res.body);

    if (parsed.closeId) {
        const match = matchId(open, parsed.closeId);
        if ('error' in match) {
            complain([match.error]);
            return 1;
        }
        // `option`, not a bare ack: the injected done/drop pair is what every
        // other surface answers with, and the bus normalizes both to one verb.
        // Sending the same shape from here keeps the terminal from being the
        // one surface with its own vocabulary.
        const body = { action: 'option', optionId: parsed.closeHow, by: 'drover-todos', channel: 'visual' };
        let answered;
        try {
            answered = await busPost(`/v1/events/${match.id}/resolve`, body, BUS_TIMEOUT_S * 1000);
        } catch (error) {
            if (error instanceof BusError) {
                complain(error.explain('the resolve endpoint'));
                return 1;
            }
            throw error;
        }
        let answer: { error?: string; title?: string; resolution?: { action?: string } | null } | null;
        try {
            answer = JSON.parse(answered.body);
        } catch {
            complain([`drover todos: the bus answered ${answered.status} with something that is not JSON`]);
            return 1;
        }
        if (answer?.error) {
            complain([`drover todos: ${answer.error}`]);
            return 1;
        }
        say([`${answer?.resolution?.action === 'ack' ? 'done' : 'dropped'}: ${answer?.title}`]);
        return 0;
    }

    if (parsed.asJson) {
        // `jq`: two-space indent, one trailing newline, the events untouched.
        say([JSON.stringify(select(open, parsed), null, 2)]);
        return 0;
    }
    say(render(open, parsed));
    return 0;
}
