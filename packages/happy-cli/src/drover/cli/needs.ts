/**
 * `drover needs` — Claude asking Clay to DO something (DROVE-53), in node
 * (DROVE-315).
 *
 * The other half of `drover ask`. Ask wants an ANSWER and the turn waits on it;
 * this wants an ACTION — "push this by 10", "run this on the box", "log in to
 * X", "plug the phone in" — and the turn usually does not have to wait at all.
 *
 *     drover needs "push the release" --why "the lane is blocked on it" \
 *                  --do "git push origin lane/DROVE-53" --by 10:00
 *
 * It publishes ONE bus event of kind `todo` and returns. That kind is not a
 * second store: pending IS open and resolved IS closed, so the request gets the
 * crash journal, the SSE snapshot, mutual dismissal across surfaces, ?session=
 * and /v1/inbox for free, and it lands on gum, the phone card, the wrist and a
 * push exactly the way a gate does. A separate to-do list beside the bus would
 * have been two things to keep in step and only one of them with surfaces.
 *
 * NOT project management. Huly is that and stays that. This is only for the
 * things that block a session right now.
 *
 * With --wait it blocks until the to-do is marked done from ANY surface, which
 * is the case where Clay genuinely has to act before the session can carry on.
 * Without it the to-do simply persists and the session keeps working; `drover
 * todos` lists what is still open and `drover status` counts it.
 *
 * NO WITHDRAWAL TRAP, unlike drover-ask, and this is the difference that
 * matters most in the port. A prompt a script is blocked on must not outlive
 * the script; a to-do is the opposite — the whole point is that it survives the
 * turn that raised it and stays on the list until Clay has done it. Killing the
 * session must not quietly clear his list, so nothing here registers a signal
 * handler, a process exit hook or an abort that would cancel the event.
 *
 * A straight port of cattle-drover/libexec/drover-needs: the same arguments,
 * the same exit codes, the same lines, and the same wire payload — `payload()`
 * below is that file's `jq -n` program, key for key, in the order jq emitted
 * them. tests/needsyou.bats stays the spec until the shell file leaves; the
 * `drover todos` half of that file is ported in todos.ts and is not re-tested
 * here.
 *
 * One thing is deliberately gone: `command -v jq`. The shell needed jq to build
 * that payload and to read a field back, and exited 5 saying so; node has JSON
 * built in, so the check has nothing to guard and no run can reach its code.
 */

import { BusError, busGet, busPost } from './bus';

const USAGE = `drover needs — ask the human to DO something, and keep it on a list until it is.

USAGE
  drover needs "push the release"
  drover needs "log in to the box" --why "the deploy step needs your session" \\
               --do "ssh box && kinit" --by "10:00"
  drover needs "plug the phone in" --wait

OPTIONS
  --why <text>       why it blocks; shown under the title on every surface
  --do <command>     the command to run, if there is one. Shown as the preview.
  --by <when>        a deadline, in your own words. Folded into the why line.
  --wait             block until it is marked done anywhere. Without this the
                     to-do persists and the session carries on.
  --timeout <secs>   with --wait, give up after this long (default 0 = forever)
  --session <id>     attach it to a session, so it shows there AND in the all
                     view. Defaults to $CLAUDE_CODE_SESSION_ID, which Claude
                     Code sets in every session, so a to-do raised from one
                     lands on that session's list without being told.
  --cwd <dir>        default: $PWD
  --harness <name>   default: claude-code
  --json             print the created event instead of the id

EXIT
  0  raised (or, with --wait, marked done)
  1  --wait and it was dropped instead of done
  3  --wait and the timeout passed with it still open
  5  the bus is unreachable or refused it
  2  bad arguments

The to-do stays open until somebody closes it, from the phone, the watch, a
gum popup or \`drover todos --done <id>\`. It never expires on its own: a to-do
that timed out is a to-do nobody did, which is when you most want it on the
list.

List them:  drover todos          Close one:  drover todos --done <id>
`;

type Env = Record<string, string | undefined>;

/** The bus's timeout for the POST, in seconds, as the shell had it. */
const POST_TIMEOUT_S = 10;

/**
 * The long poll, re-armed. The bus caps timeout_ms at 30 minutes and a to-do
 * never expires, so one request can never be the whole wait.
 */
export const POLL_MS = 600000;

export interface Parsed {
    title: string;
    why: string;
    docmd: string;
    by: string;
    wait: boolean;
    timeoutS: number;
    session: string;
    cwd: string;
    harness: string;
    asJson: boolean;
}

/** A refusal, with the line to print and the code to exit with. */
export interface Refusal {
    error: string[];
    code: number;
}

/**
 * The argument loop, as the shell wrote it: sequential, last one wins.
 *
 * Every value-taking option is guarded, because `shift 2` with one argument
 * left is an error and under `set -e` that aborted with no message at all —
 * the trap drover-flip-menu documents. Each option owns its own sentence so
 * the refusal names the flag that was short.
 */
export function parse(args: string[], env: Env = process.env): { help: true } | Refusal | Parsed {
    const p: Parsed = {
        title: '',
        why: '',
        docmd: '',
        by: '',
        wait: false,
        timeoutS: 0,
        // CLAUDE_CODE_SESSION_ID, with the CODE_ in it. Claude Code sets that
        // one; there is no CLAUDE_SESSION_ID in a session's environment, and
        // reading the shorter name meant every to-do a session raised was filed
        // under no session at all — `drover todos --mine` empty, the session's
        // own list empty, and the to-do only ever visible in the all view.
        // libexec/drover-settings and libexec/drover-flip-request both already
        // read the long name.
        session: env.CLAUDE_CODE_SESSION_ID ?? '',
        cwd: env.PWD ?? process.cwd(),
        harness: 'claude-code',
        asJson: false,
    };
    let positional = false;
    let timeoutRaw = '0';

    for (let i = 0; i < args.length;) {
        const a = args[i];
        /** The shell's `need_val`: a value must actually be there. */
        const value = (): string | null => (args.length - i >= 2 ? args[i + 1] : null);
        switch (a) {
            case '--why':
            case '--reason': {
                const v = value();
                if (v === null) return { code: 2, error: [`drover needs: ${a} needs a value`] };
                p.why = v;
                i += 2;
                break;
            }
            case '--do':
            case '--command': {
                const v = value();
                if (v === null) return { code: 2, error: [`drover needs: ${a} needs a value`] };
                p.docmd = v;
                i += 2;
                break;
            }
            case '--by':
            case '--deadline': {
                const v = value();
                if (v === null) return { code: 2, error: [`drover needs: ${a} needs a value`] };
                p.by = v;
                i += 2;
                break;
            }
            case '--wait':
                p.wait = true;
                i += 1;
                break;
            case '--timeout': {
                const v = value();
                if (v === null) return { code: 2, error: [`drover needs: ${a} needs a value`] };
                timeoutRaw = v;
                i += 2;
                break;
            }
            case '--session': {
                const v = value();
                if (v === null) return { code: 2, error: [`drover needs: ${a} needs a value`] };
                p.session = v;
                i += 2;
                break;
            }
            case '--cwd': {
                const v = value();
                if (v === null) return { code: 2, error: [`drover needs: ${a} needs a value`] };
                p.cwd = v;
                i += 2;
                break;
            }
            case '--harness': {
                const v = value();
                if (v === null) return { code: 2, error: [`drover needs: ${a} needs a value`] };
                p.harness = v;
                i += 2;
                break;
            }
            case '--json':
                p.asJson = true;
                i += 1;
                break;
            case '-h':
            case '--help':
                return { help: true };
            default:
                if (a.startsWith('-')) {
                    return { code: 2, error: [`drover needs: unknown option '${a}' (try --help)`] };
                }
                if (!positional) {
                    p.title = a;
                    positional = true;
                } else {
                    return { code: 2, error: [`drover needs: one title, quoted (got an extra argument '${a}')`] };
                }
                i += 1;
                break;
        }
    }

    if (!p.title) return { code: 2, error: ['drover needs: say what you need done (try --help)'] };
    // `case "$timeout_s" in '' | *[!0-9]*)`: whole digits only.
    if (timeoutRaw === '' || !/^[0-9]+$/.test(timeoutRaw)) {
        return { code: 2, error: ['drover needs: --timeout takes whole seconds'] };
    }
    p.timeoutS = Number(timeoutRaw);
    return p;
}

/**
 * The deadline rides in the reason rather than in a field of its own. Every
 * envelope field has to cross the bus, the schema, the bridge and the watch's
 * Codable before a surface can show it, and one line of text is honest until
 * something actually wants to SORT by the deadline.
 *
 * `${reason:+$reason }(by $by)`: a why that is empty contributes no space.
 */
export function foldDeadline(why: string, by: string): string {
    if (!by) return why;
    return `${why ? `${why} ` : ''}(by ${by})`;
}

/**
 * The `jq -n` payload, key for key and in jq's own emission order — a jq object
 * construction keeps the order it was written in, so the wire bytes are the
 * shell's bytes.
 *
 * channel "external": nothing in a harness is blocked on this. Even with
 * --wait it is this process waiting, not a hook holding a tool call open, so
 * nobody-answered must never fall through to a deny. See engine/inbox.js.
 *
 * ttlMs 0: never expire. A to-do that timed out is a to-do nobody did, which is
 * when you most want it on the list.
 *
 * The `if $x == "" then null else $x end` on sessionId, cwd and account is the
 * shell's, and it matters: an origin carrying an empty string is an origin a
 * surface groups under a session named "".
 */
export function payload(p: Parsed, account: string): Record<string, unknown> {
    return {
        kind: 'todo',
        title: p.title,
        reason: foldDeadline(p.why, p.by),
        preview: p.docmd,
        ttlMs: 0,
        channel: 'external',
        origin: {
            harness: p.harness,
            gate: 'needs-you',
            sessionId: p.session === '' ? null : p.session,
            cwd: p.cwd === '' ? null : p.cwd,
            account: account === '' ? null : account,
            surface: null,
        },
    };
}

/** A body jq could index, or undefined — which is what a jq failure printed. */
function object(body: unknown): Record<string, unknown> | undefined {
    if (typeof body === 'string') {
        try {
            return object(JSON.parse(body));
        } catch {
            return undefined;
        }
    }
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/** `jq -r`: a string raw, anything else stringified, null/false/absent nothing. */
function raw(v: unknown): string {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined || v === false) return '';
    return String(v);
}

function say(lines: string[]): void {
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

function complain(lines: string[]): void {
    if (lines.length) process.stderr.write(lines.join('\n') + '\n');
}

export interface NeedsOptions {
    env?: Env;
    /** `date +%s`, in whole seconds. Injected so a --wait deadline is testable. */
    now?: () => number;
}

export async function run(args: string[], opts: NeedsOptions = {}): Promise<number> {
    const env = opts.env ?? process.env;
    const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    const parsed = parse(args, env);
    if ('help' in parsed) {
        process.stdout.write(USAGE);
        return 0;
    }
    if ('error' in parsed) {
        complain(parsed.error);
        return parsed.code;
    }

    let posted;
    try {
        posted = await busPost('/v1/events', payload(parsed, env.DROVER_ACCOUNT ?? ''), POST_TIMEOUT_S * 1000);
    } catch (error) {
        if (error instanceof BusError) {
            complain(error.explain('the events endpoint'));
            return 5;
        }
        throw error;
    }
    const id = raw(object(posted.body)?.id);
    if (!id) {
        complain([`drover needs: the bus refused it: ${posted.body}`]);
        return 5;
    }

    if (parsed.asJson) {
        // `jq .`: two-space indent, one trailing newline, the event untouched.
        say([JSON.stringify(JSON.parse(posted.body), null, 2)]);
    } else if (!parsed.wait) {
        say([id]);
    }

    if (!parsed.wait) return 0;

    const deadline = parsed.timeoutS > 0 ? now() + parsed.timeoutS : 0;
    let event: Record<string, unknown> | undefined;
    for (;;) {
        let body: string;
        try {
            body = (await busGet(`/v1/events/${id}/wait?timeout_ms=${POLL_MS}`, (POLL_MS / 1000 + 10) * 1000)).body;
        } catch (error) {
            if (error instanceof BusError) {
                // Not bus_explain: the shell used a bare curl here and said the
                // one thing that is true of every way a long poll can end
                // badly — the wait is over and the to-do is still on the list.
                complain([`drover needs: lost the connection while waiting on ${id}`]);
                return 5;
            }
            throw error;
        }
        const answered = object(body);
        const state = raw(answered?.state);
        if (state && state !== 'pending') {
            event = answered;
            break;
        }
        if (deadline !== 0 && now() >= deadline) break;
    }

    if (!event) {
        complain([`drover needs: still open after ${parsed.timeoutS}s — it is on the list as ${id}`]);
        return 3;
    }

    const resolution = object(event.resolution);
    const action = raw(resolution?.action);
    const byWho = raw(resolution?.by) || 'somebody';
    if (action === 'ack') {
        complain([`done, by ${byWho}`]);
        return 0;
    }
    if (action === 'deny') {
        complain([`dropped, by ${byWho}`]);
        return 1;
    }
    complain([`drover needs: ${id} ended ${raw(event.state)}`]);
    return 1;
}
