/**
 * `drover questions` — every open prompt on this machine, in one place
 * (BASED-115), in node (DROVE-315).
 *
 * The home a session-less prompt never had. server.js stores origin.sessionId
 * as null when the poster does not supply one, and before this nothing grouped
 * it: a prompt raised by a cron job, a deploy script or a bare curl was
 * reachable only by the id its producer happened to print, and if that
 * scrolled past you it was gone until the TTL took it.
 *
 * Clay's own framing: "have a place to see all questions and it would show
 * there, while questions associated with a session show in the all and the
 * specific session." So the two views OVERLAP by construction — a prompt with
 * a session is in both, never in one — and that rule lives in engine/inbox.js
 * behind GET /v1/inbox, where a surface cannot re-derive it differently. This
 * verb renders the body the bus hands it and derives nothing.
 *
 * A straight port of cattle-drover/libexec/drover-questions: the same
 * arguments, the same exit codes, the same lines. The jq program that drew the
 * table is the render below, line for line, so a person who reads the shell's
 * output reads the same output here.
 */

import { BusError, busGet, busPost } from './bus';

const USAGE = `drover questions — every prompt still waiting for an answer.

USAGE
  drover questions                  All of them, grouped by session
  drover questions --json           The /v1/inbox body
  drover questions --session <id>   Only that session's
  drover questions --none           Only the ones that belong to no session
                                    (a script, a cron job, a deploy)
  drover questions --answer <id> <option>
                                    Answer one from here

A prompt WITH a session appears both under that session and in the full list. A
prompt without one appears in the full list and under "no session" — those are
the ones nothing else will ever surface, because there is no session view for
them to hang off.

SOURCE, the third column:
  script   channel "external" — no harness is waiting on it. It sits until a
           human answers, so it is listed first.
  gate     a permission gate fired (origin.gate names which)
  session  a harness raised it inside a session

Raise one from a script:  drover ask "Roll the stack?" --confirm
Endpoints and envelope:   docs/hitl.md
`;

/** The bus's timeout for both calls, in seconds, as the shell had it. */
const BUS_TIMEOUT_S = 10;

/** One pending prompt as GET /v1/inbox lists it (engine/inbox.js `row`). */
export interface InboxRow {
    id: string;
    kind: string;
    title: string;
    createdAt: number;
    source: string;
    sessionId: string | null;
    cwd: string | null;
}

export interface InboxBody {
    counts: { pending: number; unassigned: number; sessions: number };
    pending: InboxRow[];
    unassigned: InboxRow[];
    bySession: { sessionId: string; cwd: string | null; events: InboxRow[] }[];
}

interface Parsed {
    wantSession: string | null;
    onlyNone: boolean;
    asJson: boolean;
    answerId: string | null;
    answerOpt: string | null;
}

/**
 * The argument loop, as the shell wrote it. Every refusal is exit 2 with the
 * shell's sentence; `shift 2` with one argument left aborted silently under
 * set -e, which is the trap the explicit arity checks close.
 */
function parse(args: string[]): Parsed | { error: string } {
    const p: Parsed = { wantSession: null, onlyNone: false, asJson: false, answerId: null, answerOpt: null };
    for (let i = 0; i < args.length;) {
        const a = args[i];
        switch (a) {
            case '--session':
                if (args.length - i < 2) return { error: 'drover questions: --session needs an id' };
                p.wantSession = args[i + 1];
                i += 2;
                break;
            case '--none':
                p.onlyNone = true;
                i += 1;
                break;
            case '--json':
                p.asJson = true;
                i += 1;
                break;
            case '--answer':
                if (args.length - i < 3) return { error: 'drover questions: --answer needs an event id and an option' };
                p.answerId = args[i + 1];
                p.answerOpt = args[i + 2];
                i += 3;
                break;
            case '-h':
            case '--help':
                return { error: '' };
            default:
                return { error: `drover questions: unknown argument '${a}' (try --help)` };
        }
    }
    return p;
}

/** jq's `age($ms)`: seconds under 90, whole minutes after. */
export function age(createdAt: number, now: number = Date.now()): string {
    const s = (now - createdAt) / 1000;
    return s < 90 ? `${Math.floor(s)}s` : `${Math.floor(s / 60)}m`;
}

/** jq's `(.x + "       ")[0:n]`: pad right with spaces, then cut. */
function fit(s: string, n: number): string {
    return (s + ' '.repeat(n)).slice(0, n);
}

function row(r: InboxRow, now: number): string {
    return `  ${r.id.slice(0, 8)}  ${fit(r.source, 7)}  ${fit(r.kind, 10)}  ${age(r.createdAt, now)}  ${r.title}`;
}

const HEADER = '  ID        SOURCE   KIND        AGE  TITLE';

/**
 * The table, line for line as the jq program drew it. Session-less first:
 * they are the ones nothing else surfaces — a prompt inside a session is also
 * visible where that session is, a prompt from a cron job is visible only
 * here.
 */
export function render(body: InboxBody, opts: { wantSession?: string | null; onlyNone?: boolean } = {}, now: number = Date.now()): string[] {
    const out: string[] = [];
    if (opts.wantSession) {
        for (const s of body.bySession) {
            if (s.sessionId !== opts.wantSession) continue;
            for (const e of s.events) out.push(row(e, now));
        }
        return out;
    }
    if (opts.onlyNone) {
        if (body.unassigned.length === 0) return ['no prompt is waiting outside a session'];
        out.push(HEADER);
        for (const e of body.unassigned) out.push(row(e, now));
        return out;
    }
    if (body.counts.pending === 0) return ['nothing is waiting'];
    out.push(HEADER);
    if (body.unassigned.length) {
        out.push('', `no session (${body.unassigned.length})`);
        for (const e of body.unassigned) out.push(row(e, now));
    }
    for (const s of body.bySession) {
        out.push('', `session ${s.sessionId.slice(0, 8)} (${s.events.length})${s.cwd == null ? '' : `  ${s.cwd}`}`);
        for (const e of s.events) out.push(row(e, now));
    }
    out.push(
        '',
        `  ${body.counts.pending} waiting · ${body.counts.unassigned} with no session · answer one: drover questions --answer <id> <option>`,
    );
    return out;
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

    if (parsed.answerId) {
        // `option` is the verb for a question and the bus normalizes allow/deny
        // on a permission answered by its injected buttons, so one shape
        // answers both.
        const body = { action: 'option', optionId: parsed.answerOpt, by: 'drover-questions', channel: 'visual' };
        let res;
        try {
            res = await busPost(`/v1/events/${parsed.answerId}/resolve`, body, BUS_TIMEOUT_S * 1000);
        } catch (error) {
            if (error instanceof BusError) {
                complain(error.explain('the resolve endpoint'));
                return 1;
            }
            throw error;
        }
        let answer: { id?: string; error?: string; resolution?: { action?: string; optionId?: string } } = {};
        try {
            answer = JSON.parse(res.body);
        } catch {
            // The shell's jq read an empty error off an unparseable body and
            // then failed rendering the line; here that is a plain failure.
            complain([`drover questions: the bus answered ${res.status} with something that is not JSON`]);
            return 1;
        }
        if (answer.error) {
            complain([`drover questions: ${answer.error}`]);
            return 1;
        }
        const r = answer.resolution ?? {};
        say([`answered ${answer.id}: ${r.action ?? ''}${r.optionId ? `/${r.optionId}` : ''}`]);
        return 0;
    }

    let res;
    try {
        res = await busGet('/v1/inbox', BUS_TIMEOUT_S * 1000);
    } catch (error) {
        if (error instanceof BusError) {
            complain(error.explain('the inbox'));
            return 1;
        }
        throw error;
    }
    let inbox: InboxBody;
    try {
        inbox = JSON.parse(res.body);
    } catch {
        complain([`drover questions: the bus answered ${res.status} with something that is not JSON`]);
        return 1;
    }
    if (parsed.asJson) {
        // `jq .`: two-space indent, one trailing newline.
        say([JSON.stringify(inbox, null, 2)]);
        return 0;
    }
    say(render(inbox, { wantSession: parsed.wantSession, onlyNone: parsed.onlyNone }));
    return 0;
}
