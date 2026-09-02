/**
 * `drover read` — the terminal as a REMOTE CONTROL for the phone's voice
 * (DROVE-298), in node (DROVE-315).
 *
 * Clay: "I want to be able to control what's read from the CLI as well. NOT
 * that the CLI reads it, but that the CLI controls what the phone is reading —
 * what session the phone is reading."
 *
 * THE MAC NEVER SPEAKS. There is no `say`, no synthesiser and no audio device
 * anywhere in this file or under it. Every verb here is an ASK carried to the
 * phone; the phone applies its own rule and reports back, and what you read
 * below is its answer rather than this module's opinion.
 *
 * THE PHONE IS THE SOURCE OF TRUTH, which is what makes two terminals safe.
 * Neither of them decides anything — they both ask the one device that owns the
 * speaker — so a race between two panes cannot desync the voice. It also means
 * every verb can FAIL: a phone that is closed answers nothing, and this says so
 * rather than queueing a command that would start talking in his pocket twenty
 * minutes later.
 *
 * THE SHAPE IS `drover account`'s, for DROVE-152's reason: a first argument
 * that is a VALUE can never also be a verb. `drover account --help` used to
 * answer "no account '--help' in accounts.json", and `drover read pause` would
 * have the same problem the day a session is called `pause`. So the resolution
 * order is fixed and written down:
 *
 *   1. help flags   — --help, -h, help. Always help.
 *   2. an exact VERB — status, here, on, off, pause, resume.
 *   3. a SESSION     — anything else, resolved against `drover sessions`.
 *   4. otherwise     — an error that says which of the two it tried to be.
 *
 * `on` is the unambiguous form (`drover read on <session>`), the way `use` is
 * for accounts, and `--session <id>` is the form a script should use.
 *
 * ONE RULE, TWO ENTRY POINTS. The take-the-voice policy — an enabled session
 * takes the voice and pauses whoever had it, a disabled one changes nothing —
 * is DROVE-297's and lives in the app. Nothing here re-implements it; a thumb
 * and a terminal reach the same code on the phone.
 *
 * WHAT THIS PORT PRINTS, AND WHAT IT NEVER PRINTS (DROVE-283/318). The only
 * text it puts on a terminal is what the PHONE reported over the bus through
 * the fields libexec/drover-read already read — the reading state, the session
 * rows, and the one `sentence` line. It opens no log, no transcript and no
 * session file, so there is nothing here for a credential to leak out of. The
 * extraction boundary is the shell's, to the field: not one byte more.
 *
 * A straight port of cattle-drover/libexec/drover-read: the same arguments, the
 * same resolution order, the same exit codes, the same lines. `print_state` and
 * `ago` are that file's shell functions and its jq program, line for line; the
 * expectations in read.test.ts are what the shell printed on the same answer.
 * tests/reading.bats stays the spec until the shell file leaves.
 *
 * One thing is deliberately gone: `command -v jq`. The shell needed jq to read
 * a field out of a bus answer and exited 1 saying so; node parses JSON itself,
 * so the check has nothing to guard and no run can reach its exit code.
 */

import { BusError, busGet, busPost } from './bus';

const USAGE = `drover read — steer what the PHONE reads aloud. The Mac never speaks.

USAGE
  drover read                     What the phone is reading now: which session,
                                  which sentence, playing or paused, and every
                                  session it knows with its reading state.
  drover read status              The same, said explicitly.
  drover read here                Give the voice to the session in THIS pane.
  drover read <session>           Give the voice to that session.
  drover read on <session|here>   The same, unambiguously. Use this in scripts.
  drover read pause               Hold the phone's reading at its place.
  drover read resume              Carry on from exactly where it stopped.
  drover read off [<session>|here]
                                  Turn reading off for that session. With no
                                  argument, this pane's session.

  --session <id>   name the session as a value rather than a word, so a
                   session called \`pause\` is still addressable
  --json           the phone's answer, unformatted
  --timeout <secs> how long to wait for the phone (default 8, max 60)

A session may be named by its full id or by the first 8 characters, which is
what \`drover sessions\` prints.

WHAT THE TABLE SAYS  (DROVE-297's four states, in the phone's own words)
  reading   this session has the voice and is using it
  paused    it has the voice and YOU are holding it; only you lift that
  yielded   its reading is on, and another session took the voice. It keeps
            its place and carries on there when it gets the voice back
  off       not listed. Almost every session is off almost all the time, and
            a line saying so for each of them says nothing

WHAT EACH VERB ASKS FOR
  Giving a session the voice is DROVE-297's rule, applied on the phone: the
  session that had the voice PAUSES at its sentence and keeps its place, and
  the new one resumes from its own. Nothing jumps ahead and nothing is lost.
  \`pause\` is that same pause, asked for from here; \`off\` is not a pause — it
  turns that session's reader off and drops its held place.

WHAT IT WILL NOT DO
  Turn the phone's read-aloud on. That switch is the phone's, and starting
  audio on a device in a pocket from a terminal is a surprise. With reading
  off, every verb here REPORTS that and changes nothing. Turn it on in the
  app: Settings > Voice > Read replies aloud.

WHEN IT CANNOT ASK
  A phone that is closed, asleep or offline answers nothing. That is reported
  in as many words and NOTHING is changed or queued — a command nobody
  collected expires on the bus in fifteen seconds rather than waiting to
  surprise you. \`drover read\` still shows what the phone last reported, with
  how long ago that was.

EXIT
  0  the phone applied it, or reported its state
  2  this command was typed wrong
  3  no such session (refused by name, before anything was asked)
  4  the phone refused — it says why
  5  the phone did not answer, or the bus is down. Nothing changed.

Over the bus, so every surface drives the same thing:
  GET  /v1/reading                      what the phone last reported
  PUT  /v1/reading                      the phone publishing it
  POST /v1/reading/commands             ask for a change
  GET  /v1/reading/commands/<id>/wait   the phone's verdict
  POST /v1/reading/commands/<id>        the phone answering

See also: drover sessions (the ids) · drover settings (the channels)
`;

type Env = Record<string, string | undefined>;

/** DROVE-298's five verbs, as engine/reading.js froze them. */
export type Verb = 'status' | 'on' | 'off' | 'pause' | 'resume';

export interface Parsed {
    verb: Verb;
    /** The session as typed: an id, a prefix, or `here`. Empty is none. */
    session: string;
    asJson: boolean;
    /** Whole seconds, clamped to 1..60 the way the shell clamped it. */
    timeout: number;
    /** Was a target named at all? `pause --session x` is refused because of this. */
    sawTarget: boolean;
}

/** A refusal, with the lines to print and the code to exit with. */
export interface Refusal {
    error: string[];
    code: number;
}

/**
 * The argument scan, as the shell wrote it.
 *
 * --session, --json and --timeout may appear ANYWHERE, which the shell did with
 * a rotate: shift off the front, append to the back, and after argc turns the
 * list is in its original order minus what was consumed. That rotate is exactly
 * a left-to-right scan keeping the leftovers in order, with one wrinkle worth
 * keeping: a flag in the LAST position has no value to take, because by then
 * `$1` is an argument already rotated to the back. `i < argc` is what told the
 * two apart in the shell and `i + 1 < args.length` is what tells them apart
 * here.
 */
export function parse(args: string[]): { help: true } | Refusal | Parsed {
    // Help before ANYTHING else: rule 1 of the resolution order, and the reason
    // `drover account --help` was a bug.
    const head = args[0];
    if (head === '-h' || head === '--help' || head === 'help') return { help: true };

    let session = '';
    let asJson = false;
    let timeoutRaw = '8';
    let sawTarget = false;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--session=')) {
            session = arg.slice('--session='.length);
            sawTarget = true;
            continue;
        }
        if (arg === '--session') {
            if (i + 1 >= args.length) return { code: 2, error: ['drover read: --session needs an id'] };
            session = args[++i];
            sawTarget = true;
            continue;
        }
        if (arg.startsWith('--timeout=')) {
            timeoutRaw = arg.slice('--timeout='.length);
            continue;
        }
        if (arg === '--timeout') {
            if (i + 1 >= args.length) return { code: 2, error: ['drover read: --timeout needs seconds'] };
            timeoutRaw = args[++i];
            continue;
        }
        if (arg === '--json') {
            asJson = true;
            continue;
        }
        rest.push(arg);
    }

    // `case "$timeout" in '' | *[!0-9]*)`: whole digits only, sign and dot
    // included in what is refused.
    if (timeoutRaw === '' || !/^[0-9]+$/.test(timeoutRaw)) {
        return { code: 2, error: [`drover read: --timeout takes whole seconds, not '${timeoutRaw}'`] };
    }
    let timeout = Number(timeoutRaw);
    if (!(timeout >= 1)) timeout = 1;
    if (!(timeout <= 60)) timeout = 60;

    // Rule 2 then rule 3. A verb WINS over a session of the same name, which is
    // why `on` exists at all: it is the spelling that cannot be mistaken.
    let verb: Verb | '' = '';
    let used = 0;
    if (rest.length > 0) {
        const first = rest[0];
        if (first === 'status' || first === 'pause' || first === 'resume') {
            verb = first;
            used = 1;
        } else if (first === 'here') {
            verb = 'on';
            session = 'here';
            sawTarget = true;
            used = 1;
        } else if (first === 'on' || first === 'off') {
            verb = first;
            used = 1;
            if (rest.length > 1) {
                session = rest[1];
                sawTarget = true;
                used = 2;
            }
        } else if (first.startsWith('-')) {
            return { code: 2, error: [`drover read: unknown option '${first}' (try: drover read --help)`] };
        } else {
            // Rule 3: not a verb, so it is a session. This is the shorthand the
            // ticket asks for — `drover read <session>` gives it the voice.
            verb = 'on';
            session = first;
            sawTarget = true;
            used = 1;
        }
    }
    if (used < rest.length) {
        return { code: 2, error: [`drover read: too many arguments, starting at '${rest[used]}' (try: drover read --help)`] };
    }
    if (!verb) verb = 'status';

    if (sawTarget && verb !== 'on' && verb !== 'off') {
        // `drover read pause --session x` reads as "pause that one" and the
        // phone has exactly ONE voice. Silently pausing whatever happened to be
        // speaking would answer a question nobody asked.
        return {
            code: 2,
            error: [`drover read: \`${verb}\` acts on the voice, not on a session — the phone has one speaker`],
        };
    }
    return { verb, session, asJson, timeout, sawTarget };
}

// --- reading a bus answer the way jq read it ---------------------------------

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

/** jq's `a // b // c`: only null and false fall through, an empty string does not. */
function alt(...vals: unknown[]): unknown {
    for (const v of vals) if (v !== null && v !== undefined && v !== false) return v;
    return undefined;
}

/** `jq -r`: a string raw, anything else stringified, null/false/absent nothing. */
function raw(v: unknown): string {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined || v === false) return '';
    return String(v);
}

/** jq's `.s[0:n]`: by codepoint, which is what a uuid never tests. */
function first(s: string, n: number): string {
    return Array.from(s).slice(0, n).join('');
}

/**
 * `ago <ms-old>` — how stale an answer is, in words rather than a stamp. A
 * reader who has to subtract two epochs to know whether the phone is awake
 * will not.
 */
export function ago(ms: number): string {
    const s = Math.trunc((Number.isFinite(ms) ? ms : 0) / 1000);
    if (s < 2) return 'just now';
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.trunc(s / 60)}m ago`;
    return `${Math.trunc(s / 3600)}h ago`;
}

/**
 * `print_state <json-with-.reported>` — the picture, in four lines at most,
 * plus the table. The shell's function and the jq program inside it, in order.
 *
 * The table is the visible half of DROVE-297's rule. `yielded` is
 * enabled-but-silent because another session took the voice, and it has to be
 * tellable from `off` or the behaviour is mysterious rather than legible.
 */
export function printState(input: unknown): string[] {
    const state = object(input);
    const reported = object(state?.reported);
    if (!state || state.reported == null || !reported) return ['reading   the phone has not reported yet'];

    const lines: string[] = [];
    const ageMs = typeof state.ageMs === 'number' ? state.ageMs : 0;
    if (raw(reported.global) === 'off') {
        lines.push(`reading   OFF on the phone (${ago(ageMs)}) — turn it on in Settings > Voice`);
    } else {
        const playing = reported.playing ? 'playing' : 'paused';
        const name = raw(alt(reported.title, reported.sessionId, 'nothing'));
        lines.push(`reading   ${playing} · ${name} (${ago(ageMs)})`);
        const sentence = raw(alt(reported.sentence));
        if (sentence) lines.push(`sentence  ${sentence}`);
    }

    const rows = Array.isArray(reported.sessions) ? reported.sessions : [];
    if (rows.length > 0) {
        lines.push('', '  session   state      what it means');
        for (const entry of rows) {
            const row = object(entry) ?? {};
            const st = raw(row.state);
            const meaning = st === 'reading'
                ? 'has the voice'
                : st === 'paused'
                    ? 'you are holding it'
                    : st === 'yielded'
                        ? 'on, waiting its turn'
                        : 'reading off';
            const title = row.title ? ` · ${raw(row.title)}` : '';
            lines.push(`  ${first(raw(row.sessionId), 8)}  ${(st + '         ').slice(0, 9)}  ${meaning}${title}`);
        }
    }
    if (state.stale === true) {
        lines.push('', 'That is the last thing the phone said. It has not reported since.');
    }
    return lines;
}

// --- naming a session --------------------------------------------------------

/** The bus's timeout for the session list, in seconds, as the shell had it. */
const SESSIONS_TIMEOUT_S = 10;

/**
 * REFUSED BY NAME, before anything is asked of the phone. A command carrying a
 * session that ended is a command the phone can only shrug at, and a shrug from
 * a device you cannot see reads exactly like a phone that is switched off. The
 * two failures have different fixes, so they get different messages and
 * different exit codes.
 *
 * `here` is the common terminal case and costs no typing: the pane is stamped
 * on every session by the hook adapters, the same fact `drover flip` targets.
 */
export async function resolveSession(want: string, env: Env): Promise<{ id: string } | Refusal> {
    const pane = env.TMUX_PANE ?? '';
    if (want === 'here' && !pane) {
        return {
            code: 2,
            error: [
                'drover read: `here` means this tmux pane and there is no pane here.',
                '  Name the session instead: drover read on <session>  (drover sessions lists them)',
            ],
        };
    }
    let body: string;
    try {
        body = (await busGet('/v1/sessions?limit=200', SESSIONS_TIMEOUT_S * 1000)).body;
    } catch (error) {
        if (error instanceof BusError) return { code: 5, error: error.explain('the session list') };
        throw error;
    }
    const listed = object(body)?.sessions;
    const sessions = (Array.isArray(listed) ? listed : [])
        .map((s) => object(s))
        .filter((s): s is Record<string, unknown> => !!s);

    if (want === 'here') {
        const hit = sessions.find((s) => raw(s.state) !== 'ended' && s.pane === pane);
        const id = hit ? raw(hit.id) : '';
        if (!id) {
            return {
                code: 3,
                error: [
                    `drover read: no live session on this pane (${pane}).`,
                    '  A session started with plain `claude` is not on the bus; start it with `drover`.',
                ],
            };
        }
        return { id };
    }

    // Full id, then the 8-character prefix `drover sessions` prints. An
    // ambiguous prefix is refused rather than guessed: picking one of two
    // sessions for him is how the voice lands on the wrong conversation.
    const hits = sessions.filter((s) => typeof s.id === 'string' && (s.id === want || s.id.startsWith(want)));
    if (hits.length === 0) {
        return {
            code: 3,
            error: [`drover read: no session '${want}'.`, '  Try: drover sessions   (an id, or its first 8 characters)'],
        };
    }
    if (hits.length > 1) {
        return {
            code: 3,
            error: [
                `drover read: '${want}' names ${hits.length} sessions. Give more of the id:`,
                ...hits.map((s) => `    ${raw(s.id)}`),
            ],
        };
    }
    if (raw(hits[0].state) === 'ended') {
        return { code: 3, error: [`drover read: session ${raw(hits[0].id)} has ended — nothing there to read.`] };
    }
    return { id: raw(hits[0].id) };
}

// --- what the phone said -----------------------------------------------------

/** The bus's timeout for posting a command, in seconds, as the shell had it. */
const POST_TIMEOUT_S = 10;

/**
 * stdout, one line per array entry. Named `print` and not `say` on purpose:
 * reading.bats greps this file for a `say` call, because one careless
 * `say "$sentence"` is how the Mac starts talking over him, and a helper
 * wearing that name would make the guard fire on the port instead of on a
 * synthesiser.
 */
function print(lines: string[]): void {
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

function complain(lines: string[]): void {
    if (lines.length) process.stderr.write(lines.join('\n') + '\n');
}

/** What `applied` says for each verb. `status` asked for nothing but the answer. */
const APPLIED: Record<Verb, string> = {
    status: '',
    pause: 'paused on the phone, holding its place.',
    resume: 'reading again on the phone, from where it stopped.',
    on: '',
    off: '',
};

export async function run(args: string[], opts: { env?: Env } = {}): Promise<number> {
    const env = opts.env ?? process.env;
    const parsed = parse(args);
    if ('help' in parsed) {
        process.stdout.write(USAGE);
        return 0;
    }
    if ('error' in parsed) {
        complain(parsed.error);
        return parsed.code;
    }

    let target = '';
    if (parsed.verb === 'on') {
        if (!parsed.session) {
            complain(['drover read: `on` needs a session (or `here` for this pane)']);
            return 2;
        }
        const found = await resolveSession(parsed.session, env);
        if ('error' in found) {
            complain(found.error);
            return found.code;
        }
        target = found.id;
    } else if (parsed.verb === 'off') {
        // No argument means this pane, which is what `off` typed inside a
        // session obviously means. It is spelled out rather than assumed, so a
        // run outside tmux says what to do instead of turning off somebody
        // else's voice.
        const found = await resolveSession(parsed.session || 'here', env);
        if ('error' in found) {
            complain(found.error);
            return found.code;
        }
        target = found.id;
    }

    // THE COMMAND DIES WHEN THIS TERMINAL STOPS CARING. Its life is the
    // caller's own patience, to the millisecond, so there is no window at all
    // in which a phone that woke up late could still collect it. That window is
    // the surprise: a command with a life of its own outliving the person who
    // typed it is how audio starts in a pocket, and the fix is not to make the
    // window small but to make it the same window.
    const ttl = parsed.timeout * 1000;
    const by = env.DROVER_READ_BY || 'cli';
    // The shell built this JSON by hand and escaped a quote and a backslash on
    // the way in; JSON.stringify escapes the control characters that spelling
    // could not. Same keys, same order, same bytes for every value either one
    // could carry. `status` is still a COMMAND, not a plain read of the last
    // report: a snapshot with no round trip cannot tell a phone that is awake
    // and quiet from one that has been shut for a week, and telling those two
    // apart is most of what this verb is for.
    const body: Record<string, unknown> = parsed.verb === 'status'
        ? { verb: 'status', ttlMs: ttl, by }
        : { verb: parsed.verb, ttlMs: ttl, by };
    if (parsed.verb !== 'status' && target) body.sessionId = target;

    let posted;
    try {
        posted = await busPost('/v1/reading/commands', body, POST_TIMEOUT_S * 1000);
    } catch (error) {
        if (error instanceof BusError) {
            complain(error.explain('the reading command'));
            return 5;
        }
        throw error;
    }
    const cmdId = raw(alt(object(posted.body)?.id));
    if (!cmdId) {
        const why = raw(alt(object(posted.body)?.error));
        complain([`drover read: the bus refused this command${why ? `: ${why}` : ''}`]);
        return 2;
    }

    // The long poll. Its budget is the caller's, and the bus caps its own wait
    // at the command's remaining life — so this returns when the phone answers,
    // when the command expires, or when the human's patience runs out, and
    // never later.
    let answer: string;
    try {
        answer = (await busGet(
            `/v1/reading/commands/${cmdId}/wait?timeout_ms=${parsed.timeout * 1000}`,
            (parsed.timeout + 5) * 1000,
        )).body;
    } catch (error) {
        if (error instanceof BusError) {
            complain(error.explain("the phone's answer"));
            return 5;
        }
        throw error;
    }

    if (parsed.asJson) print([answer]);

    const verdict = object(answer);
    const state = verdict ? raw(alt(verdict.state, 'pending')) : '';
    const reason = verdict ? raw(alt(verdict.reason)) : '';
    // `if .snapshot then {reported: .snapshot, ageMs: 0, stale: false}`: the
    // verdict carries the state it left behind, so nothing has to go back and
    // ask a second time and get an answer that already disagrees.
    const snap = verdict && verdict.snapshot ? { reported: verdict.snapshot, ageMs: 0, stale: false } : null;

    switch (state) {
        case 'applied': {
            if (!parsed.asJson) {
                const line = parsed.verb === 'on'
                    ? `the voice is on ${target} now; whatever had it is paused at its sentence.`
                    : parsed.verb === 'off'
                        ? `reading is off for ${target}.`
                        : APPLIED[parsed.verb];
                if (line) print([line]);
                if (snap) print(printState(snap));
            }
            return 0;
        }
        case 'refused': {
            // A REFUSAL IS AN ANSWER, and it is the phone's. Reading off
            // globally, or a session the app does not know, are both reasons
            // rather than errors, and the whole point of DROVE-298's third edge
            // case is that they are SAID rather than worked around by turning
            // something on for him.
            complain([`drover read: the phone refused — ${reason || 'no reason given'}`]);
            if (!parsed.asJson && snap) complain(printState(snap));
            return 4;
        }
        case 'expired':
        case 'pending': {
            // NOTHING CHANGED AND NOTHING IS QUEUED. The command dies on the
            // bus rather than waiting for an app that may open in an hour — a
            // phone that starts talking in his pocket long after he gave up is
            // the exact surprise this ticket refuses.
            complain([
                `drover read: the phone did not answer in ${parsed.timeout}s. Nothing was changed.`,
                '  The app may be closed, asleep or offline. Check the path: drover status',
            ]);
            if (!parsed.asJson) {
                try {
                    const last = object((await busGet('/v1/reading', 5000)).body);
                    if (last && last.reported != null) complain(['', ...printState(last)]);
                } catch {
                    // The shell's `bus_get ... && { ... }`: a bus that cannot
                    // answer this adds nothing to what was already said.
                }
            }
            return 5;
        }
        default:
            complain([`drover read: the bus answered '${state}', which is not a verdict`]);
            return 5;
    }
}
