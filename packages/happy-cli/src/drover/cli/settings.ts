/**
 * `drover settings` — how THIS session behaves when it runs out (BASED-117),
 * in node (DROVE-315 wave 4).
 *
 * Clay: "running out of tokens should not silently auto-flip. It should be a
 * per-session CHOICE." This is where the choice is made from a terminal; the
 * phone makes the same choice over the same endpoints (BASED-118).
 *
 * A straight port of cattle-drover/libexec/drover-settings: the same arguments,
 * the same exit codes, the same sentences, and the same lines out of the same
 * jq programs. cattle-drover/tests/settings.bats stays the spec until the shell
 * file leaves, and settings.test.ts runs both files over one fixture bus and
 * compares stdout, stderr, the exit code and the BYTES each put on the wire.
 *
 * EVERY PATH IS A BUS CALL. The store is engine/settings.js and it stays in the
 * cattle-drover checkout: this verb is a CLIENT, and settingsStore.ts is the
 * client half of lib/drover-settings.sh. Nothing here reads
 * session-settings.json, nothing here knows a default, and when the bus is down
 * every path FAILS — exit 1 with bus_explain's sentences — rather than falling
 * back to the file. Two writers to one file is a lost-update race between the
 * phone and the terminal, and the loser's change vanishes with nothing logged.
 *
 * HOW THE EMPTY-PATCH BUG BECOMES UNREPRESENTABLE. The shell's comment on
 * `typed_patch` explains why every caller ASSIGNED it to a variable rather than
 * inlining it: an `exit 2` inside a command substitution kills only the
 * SUBSHELL, so `settings_patch "$s" "$(typed_patch ttl abc)" cli` printed the
 * complaint on stderr and then posted an EMPTY body — which the bus reads as
 * {}, accepts, and answers 200 to. A rejected setting that answers 200 is
 * exactly the silent toggle the store refuses unknown keys to prevent.
 *
 * Here `typedPatch` returns `{ patch }` OR `{ error }` and there is no third
 * thing. A refused value produces no patch at all, so there is nothing to send;
 * the caller cannot reach `.patch` without narrowing the union first, and tsc
 * refuses the program that tries. The bug is not guarded against — it cannot be
 * written down.
 *
 * jq, MATCHED RATHER THAN APPROXIMATED. `//` falls through on false as well as
 * null; `has` on null is false (jq 1.7); `keys` SORTS while `to_entries` keeps
 * insertion order; `+` treats null as the identity, so `"audio (" + null` is
 * `"audio ("`; `tostring` on an object is compact JSON; `(k + <20 spaces>)[0:20]`
 * pads AND truncates; `strflocaltime` is the machine's local zone, not UTC.
 * Each of those has a helper below with the jq spelling in its comment.
 *
 * TWO DELIBERATE DIVERGENCES, both in corners the bus cannot produce:
 *
 *  - A body that is not JSON at all. jq dies with a parse error and, under
 *    `set -e`, the shell exits 5; here it renders as the null document. Every
 *    /v1/settings route answers JSON, including its 400s and its 500.
 *  - `onLimitPromptTtlMs 0090000`. The shell's `*[!0-9]*` guard passes it and
 *    then `jq --argjson 0090000` dies on the invalid numeric literal; node
 *    reads 90000. Leading zeros in a millisecond count are not a thing anyone
 *    types, and neither answer is the useful one.
 */

import { BusError, type BusResponse } from './bus';
import { droverEnv } from './env';
import {
    settingsAll,
    settingsDefaults,
    settingsDelete,
    settingsPatch,
    settingsPatchDefaults,
    settingsRefused,
    settingsShow,
} from './settingsStore';

type Env = Record<string, string | undefined>;

const USAGE = `drover settings — the per-session flip policy: auto-flip, or ask first.

USAGE
  drover settings [show]              This session: what it will do, and why
  drover settings --json              ... as JSON (the shape BASED-118 drives)
  drover settings set <key> <value>   Set one key for this session
  drover settings unset <key>         Put one key back on the default
  drover settings clear               Drop every override for this session
  drover settings list                Every session that has an override
  drover settings defaults            The machine defaults
  drover settings defaults set <k> <v>   Move a default (affects every session
                                         that has not overridden that key)
  drover settings fallback <family> <f2,f3|none>
                                      Edit the model fallback chain
  drover settings mode                The machine's mode, and every saved one
  drover settings mode <name|none>    Switch the MACHINE onto a saved mode
                                      (--session <id> switches one session)
  drover settings mode save <name> <json>
                                      Save a combination as a mode, e.g.
                                      '{"announceVisual":false,"announceHaptic":true,
                                        "announceAudio":false,"answerAudio":"off"}'

  --session <id>   act on a session other than this one. Without it the id
                   comes from $CLAUDE_CODE_SESSION_ID, so inside a session you
                   never type it.

KEYS
  onLimit              prompt | auto
      prompt  a limit raises a question on the bus (phone, watch, tmux) listing
              the accounts ordered by headroom, and the session moves only to
              the one chosen. THE DEFAULT.
      auto    a limit moves the session straight to the account with the most
              headroom and says so in the transcript.

  onLimitTimeout       auto | stop
      What happens when nobody answers that question inside its TTL. \`auto\`
      keeps an unattended session working; \`stop\` parks it instead.

  onLimitPromptTtlMs   how long that question stands (default 600000)

  onFamilyExhausted    flip-then-downgrade | flip-only | downgrade-only | nothing
      Nothing has the model you asked for.
      stop      halt and say so, rather than quietly answering an Opus
                question on Sonnet. THE DEFAULT.
      fallback  move to the next family in the chain and record the swap.

  familyFallback       the chain, per family. Default: fable -> opus, sonnet.

DELIVERY CHANNELS (DROVE-72). Which channels ANNOUNCE a prompt to you, and
whether audio may ANSWER one. The bus stamps them on every event as
\`delivery\`; surfaces read that and never these keys. Haptic is announce-only,
and visual can always answer, so all three announce toggles off still leaves
the terminal popup, the inbox card and the watch wall reachable.

  announceVisual       true | false   app card + push, gum client, watch wall
  announceHaptic       true | false   wrist buzz, phone taptic
  announceAudio        true | false   title and options spoken aloud
  answerAudio          off | click | speech | both
                       set by a mode, not a toggle: headphone click, dictation
  mode                 a saved combination's name, or null when set by hand.
                       Setting any of the four keys clears it.
  modes                name -> {the four keys}. Shipped: direct, silent-haptic,
                       eyes-free-audio, hands-free-voice. A fifth is one row.

SCOPES, most specific first: this session > the machine defaults > built-in.
The same cascade the flip prompt already uses.

Over the bus, so the phone can drive it:
  GET    /v1/settings                      the whole store
  GET    /v1/settings/defaults
  PATCH  /v1/settings/defaults             merge; null clears a key
  GET    /v1/settings/sessions             every session with an override
  GET    /v1/settings/sessions/<id>        effective + overrides + defaults
  PATCH  /v1/settings/sessions/<id>        merge; null clears a key
  PUT    /v1/settings/sessions/<id>        replace
  DELETE /v1/settings/sessions/<id>        drop every override

See also: drover flip-policy (what those settings decide), docs/flip-policy.md
`;

// --- jq, in the small --------------------------------------------------------
//
// print_show, the list program and the mode table are jq, and jq's answers to
// null and to a missing key are not JavaScript's. Each helper below is one jq
// operator, named after it, so a reader can check the port against the program.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A JSON object, or null for anything else — jq's idea of "has keys". */
function object(v: unknown): Record<string, Json> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : null;
}

/** `.[k]`. jq answers null for a key an object lacks, and for null itself. */
function field(v: unknown, k: string): Json {
    const o = object(v);
    if (!o) return null;
    const got = o[k];
    return got === undefined ? null : got;
}

/** `has(k)`. In jq 1.7 `null | has("x")` is false rather than an error. */
function has(v: unknown, k: string): boolean {
    const o = object(v);
    return o !== null && Object.prototype.hasOwnProperty.call(o, k);
}

/** `a // b` — falls through on false as well as null. */
function alt(v: Json, fallback: Json): Json {
    return v === null || v === false ? fallback : v;
}

/** `tostring`: a string stays itself, everything else becomes compact JSON. */
function tostring(v: Json): string {
    if (typeof v === 'string') return v;
    return JSON.stringify(v) ?? 'null';
}

/** `+` on strings, where null is the identity: `"a" + null` is `"a"`. */
function cat(...parts: (string | null)[]): string {
    return parts.map((p) => p ?? '').join('');
}

/** `join(sep)` over an array: a null element joins as the empty string. */
function join(v: Json, sep: string): string {
    if (!Array.isArray(v)) return '';
    return v.map((e) => (e === null ? '' : typeof e === 'string' ? e : tostring(e))).join(sep);
}

/** `($k + "                    ")[0:20]` — pads to 20, and truncates at 20. */
function pad(k: string): string {
    return (k + ' '.repeat(20)).slice(0, 20);
}

/** `strflocaltime("%Y-%m-%d %H:%M")` — the MACHINE's zone, never UTC. */
function strflocaltime(epochMs: number): string {
    const d = new Date(epochMs);
    const two = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** What `$(curl ...)` leaves in bus_body: command substitution eats trailing newlines. */
function substituted(body: string): string {
    return body.replace(/\n+$/, '');
}

/** The document, or null when the body is not JSON (see the header). */
function parsed(body: string): Json {
    try {
        return JSON.parse(body) as Json;
    } catch {
        return null;
    }
}

// --- the argument rotate ------------------------------------------------------

export interface Rotated {
    /** Only what `--session` said. The env fallback is need_session's, later. */
    session: string;
    asJson: boolean;
    /** What is left, in its original order, minus what was consumed. */
    rest: string[];
}

/**
 * `--session` and `--json` ANYWHERE in the args, the same rotate bin/drover
 * uses for `--account`: shift off the front, append to the back, and after
 * argc turns the list is in its original order minus what was consumed.
 *
 * The shell needed it because POSIX sh has no arrays and `"$@"` cannot be
 * edited in the middle. Node has arrays, and the loop is kept anyway, because
 * the loop is the SPEC: `[ "$i" -lt "$argc" ]` is what tells "the value
 * follows" from "the flag was last", and by then `$1` may be an argument
 * already rotated to the back. `drover settings show --session` is an error,
 * not a request for a session called `show`.
 */
export function rotate(args: string[]): Rotated | { error: string[]; code: number } {
    const queue = [...args];
    const argc = args.length;
    let i = 0;
    let session = '';
    let asJson = false;
    while (i < argc) {
        const arg = queue.shift() as string;
        i += 1;
        if (arg.startsWith('--session=')) {
            session = arg.slice('--session='.length);
            continue;
        }
        if (arg === '--session') {
            if (!(i < argc)) return { error: ['drover settings: --session needs an id'], code: 2 };
            session = queue.shift() ?? '';
            i += 1;
            continue;
        }
        if (arg === '--json') {
            asJson = true;
            continue;
        }
        queue.push(arg);
    }
    return { session, asJson, rest: queue };
}

/**
 * The session this acts on. Without `--session` it is $CLAUDE_CODE_SESSION_ID,
 * so inside a session you never type it; with neither it is a three-line
 * complaint and exit 2, because acting on the wrong session is worse.
 */
export function needSession(session: string, env: Env): { session: string } | { error: string[] } {
    const id = session || env.CLAUDE_CODE_SESSION_ID || '';
    if (id) return { session: id };
    return {
        error: [
            'drover settings: no session id. Run this inside a drover session,',
            '  or name one: drover settings --session <id>',
            '  (drover sessions lists them)',
        ],
    };
}

// --- typed_patch --------------------------------------------------------------

export type TypedPatch = { patch: Record<string, Json> } | { error: string[] };

/**
 * The value for a key, TYPED, before the bus is called.
 *
 * onLimitPromptTtlMs is a NUMBER: the bus refuses a string there on purpose,
 * because `jq --arg` always emits one and this is the same trap that made an
 * event's ttlMs of "2000" store as 600000. The three announce toggles are real
 * BOOLEANS on the wire (DROVE-72) — the bus refuses the string "false"
 * deliberately, because a toggle stored as a string is truthy to every reader.
 *
 * Returns the patch or the complaint, never both and never neither. See the
 * module header for why that shape is the whole point.
 */
export function typedPatch(key: string, value: string): TypedPatch {
    switch (key) {
        case 'onLimitPromptTtlMs': {
            // `case '' | *[!0-9]*` — empty, or anything with a non-digit in it.
            if (value === '' || /[^0-9]/.test(value)) {
                return { error: [`drover settings: ${key} must be a whole number of milliseconds`] };
            }
            return { patch: { [key]: Number(value) } };
        }
        case 'familyFallback': {
            const doc = parseStrict(value);
            // `jq -e .` exits 1 on false and on null as well as on bad JSON.
            if (!doc.ok || doc.value === null || doc.value === false) {
                return {
                    error: [
                        'drover settings: familyFallback takes JSON — or use:',
                        '  drover settings fallback <family> <f2,f3|none>',
                    ],
                };
            }
            return { patch: { [key]: doc.value } };
        }
        case 'announceVisual':
        case 'announceHaptic':
        case 'announceAudio': {
            if (value === 'true' || value === 'on' || value === 'yes' || value === '1') {
                return { patch: { [key]: true } };
            }
            if (value === 'false' || value === 'off' || value === 'no' || value === '0') {
                return { patch: { [key]: false } };
            }
            return { error: [`drover settings: ${key} takes true or false`] };
        }
        case 'mode': {
            if (value === 'none' || value === 'null') return { patch: { mode: null } };
            return { patch: { mode: value } };
        }
        case 'modes': {
            const doc = parseStrict(value);
            if (!doc.ok || object(doc.value) === null) {
                return {
                    error: [
                        'drover settings: modes takes a JSON object of name -> row — or use:',
                        '  drover settings mode save <name> <json>',
                    ],
                };
            }
            return { patch: { modes: doc.value } };
        }
        default:
            return { patch: { [key]: value } };
    }
}

function parseStrict(text: string): { ok: true; value: Json } | { ok: false } {
    try {
        return { ok: true, value: JSON.parse(text) as Json };
    } catch {
        return { ok: false };
    }
}

// --- print_show ---------------------------------------------------------------

/**
 * The human-readable view. It prints the EFFECTIVE value and, beside it, where
 * that value came from — a settings table that does not say which layer won is
 * a table you have to guess at, and the whole point of a per-session override
 * is knowing which sessions have one.
 */
export function printShow(doc: Json, session: string): string[] {
    const effective = field(doc, 'effective');
    const src = (k: string): string => {
        if (has(field(doc, 'overrides'), k)) return 'session';
        if (has(alt(field(doc, 'machine'), {}), k)) return 'machine default';
        return 'built-in';
    };
    const row = (k: string): string => cat('  ', pad(k), ' ', tostring(field(effective, k)), '   (', src(k), ')');

    const chains = object(alt(field(effective, 'familyFallback'), {})) ?? {};
    const announced = [
        field(effective, 'announceVisual') === true ? 'visual' : null,
        field(effective, 'announceHaptic') === true ? 'haptic' : null,
        field(effective, 'announceAudio') === true ? 'audio' : null,
    ].filter((s): s is string => s !== null);
    const answerAudio = field(effective, 'answerAudio');
    const modes = object(alt(field(effective, 'modes'), {})) ?? {};

    const lines = [
        cat('session ', session),
        '',
        ...['onLimit', 'onLimitTimeout', 'onLimitPromptTtlMs', 'onFamilyExhausted'].map(row),
        cat(
            '  ',
            pad('familyFallback'),
            ' ',
            Object.entries(chains).map(([f, c]) => cat(f, ' -> ', join(c, ', '))).join('; '),
            '   (',
            src('familyFallback'),
            ')',
        ),
        '',
        // The delivery channels (DROVE-72), printed as the bus will stamp them
        // on the next event this session raises, then key by key with the layer.
        cat(
            '  delivery: announce ',
            announced.length === 0 ? 'none (terminal only)' : announced.join(','),
            ' · answer visual',
            alt(answerAudio, 'off') !== 'off' ? cat(',audio (', typeof answerAudio === 'string' ? answerAudio : null, ')') : '',
        ),
        ...['announceVisual', 'announceHaptic', 'announceAudio', 'answerAudio', 'mode'].map(row),
        cat('  ', pad('modes'), ' ', Object.keys(modes).sort().join(', ')),
    ];
    const updatedAt = field(doc, 'updatedAt');
    if (updatedAt !== null) {
        lines.push('', cat('  last changed ', strflocaltime(Number(updatedAt)), ' by ', tostring(alt(field(doc, 'updatedBy'), 'unknown'))));
    }
    return lines;
}

/** `drover settings list`, the non-JSON half of its jq program. */
export function printList(doc: Json): string[] {
    const sessions = object(field(doc, 'sessions')) ?? {};
    const names = Object.keys(sessions);
    if (names.length === 0) return ['no session has an override; every session is on the defaults'];
    return names.map((name) => {
        const own = object(sessions[name]) ?? {};
        const pairs = Object.entries(own)
            .filter(([k]) => k !== 'updatedAt' && k !== 'updatedBy')
            .map(([k, v]) => cat(k, '=', tostring(v)));
        return cat('  ', name, '  ', pairs.join(' '));
    });
}

/** `drover settings mode`, the machine's mode and every saved one. */
export function printModes(doc: Json): string[] {
    const d = field(doc, 'defaults');
    const rows = object(field(d, 'modes')) ?? {};
    return [
        cat('machine mode: ', tostring(alt(field(d, 'mode'), 'none (set by hand)'))),
        '',
        ...Object.entries(rows).map(([name, r]) => {
            // `select($r.announceVisual)` is TRUTHY here, where print_show's is
            // `== true`. Kept apart because the shell keeps them apart.
            const on = [
                field(r, 'announceVisual') ? 'visual' : null,
                field(r, 'announceHaptic') ? 'haptic' : null,
                field(r, 'announceAudio') ? 'audio' : null,
            ].filter((s): s is string => s !== null);
            const answerAudio = field(r, 'answerAudio');
            return cat(
                '  ',
                pad(name),
                ' announce ',
                on.length === 0 ? 'none' : on.join(','),
                ' · answer visual',
                answerAudio !== 'off' ? cat(',audio (', typeof answerAudio === 'string' ? answerAudio : null, ')') : '',
            );
        }),
    ];
}

/**
 * The chain for one family, merged onto the EFFECTIVE map rather than onto the
 * session's own overrides: familyFallback is ONE key, so a session that edits
 * one family would otherwise silently lose every family it inherited from the
 * defaults — and a Mythos session would stop having anywhere to fall back to
 * because Clay once edited the Fable row.
 */
export function mergedChains(doc: Json, family: string, chain: string): Record<string, Json> {
    const map = { ...(object(alt(field(field(doc, 'effective'), 'familyFallback'), {})) ?? {}) };
    if (chain === 'none') {
        delete map[family];
        return map;
    }
    map[family] = chain.split(',').map((f) => f.trim()).filter((f) => f.length > 0);
    return map;
}

/** `"familyFallback = " + ...` — the sentence a fallback edit answers with. */
export function printChains(doc: Json): string {
    const chains = object(alt(field(field(doc, 'effective'), 'familyFallback'), {})) ?? {};
    return cat('familyFallback = ', Object.entries(chains).map(([f, c]) => cat(f, ' -> ', join(c, ', '))).join('; '));
}

// --- the verb -----------------------------------------------------------------

function say(lines: string[]): void {
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

function complain(lines: string[]): void {
    if (lines.length) process.stderr.write(lines.join('\n') + '\n');
}

/**
 * One bus call. Every write and every read goes through here so the "bus is
 * down" sentence is written once and says the same thing the other verbs say —
 * bus_explain's, with the settings endpoint named for the timeout case.
 */
async function askBus(call: () => Promise<BusResponse>): Promise<{ body: string } | { error: string[] }> {
    try {
        return { body: substituted((await call()).body) };
    } catch (e) {
        if (e instanceof BusError) return { error: e.explain('the settings endpoint') };
        throw e;
    }
}

/**
 * The bus answered, but with an `.error`. An unknown key is REFUSED rather
 * than swallowed; that is what makes a typo in a settings UI loud instead of a
 * toggle that silently does nothing.
 */
function refused(body: string): string[] | null {
    const err = settingsRefused(body);
    return err === null ? null : [`drover settings: ${err}`];
}

export async function run(args: string[], opts: { env?: Env } = {}): Promise<number> {
    const env = opts.env ?? process.env;
    const flags = rotate(args);
    if ('error' in flags) {
        complain(flags.error);
        return flags.code;
    }
    const { session: named, asJson, rest } = flags;

    // `verb=${1:-show}`: an absent FIRST argument, and an empty one, are both
    // `show`. The shell's `show | ''` arm is therefore unreachable, and so is
    // its node twin; the default lives here instead.
    const verb = rest[0] || 'show';
    if (verb === '-h' || verb === '--help' || verb === 'help') {
        process.stdout.write(USAGE);
        return 0;
    }

    // Every path below is a bus call, so DROVER_URL is read here and nowhere
    // else in this file — after help, which answers before any env is read.
    const base = droverEnv(env).droverUrl;

    switch (verb) {
        case 'show': {
            const who = needSession(named, env);
            if ('error' in who) {
                complain(who.error);
                return 2;
            }
            const got = await askBus(() => settingsShow(who.session, base));
            if ('error' in got) {
                complain(got.error);
                return 1;
            }
            if (asJson) {
                say([got.body]);
                return 0;
            }
            say(printShow(parsed(got.body), who.session));
            return 0;
        }

        case 'set': {
            if (rest.length < 3) {
                complain(['drover settings: set needs a key and a value (try --help)']);
                return 2;
            }
            const who = needSession(named, env);
            if ('error' in who) {
                complain(who.error);
                return 2;
            }
            const key = rest[1] as string;
            const typed = typedPatch(key, rest[2] as string);
            if ('error' in typed) {
                complain(typed.error);
                return 2;
            }
            const got = await askBus(() => settingsPatch(who.session, JSON.stringify(typed.patch), 'cli', base));
            if ('error' in got) {
                complain(got.error);
                return 1;
            }
            const no = refused(got.body);
            if (no) {
                complain(no);
                return 1;
            }
            say([cat(key, ' = ', tostring(field(field(parsed(got.body), 'effective'), key)), ' for this session')]);
            return 0;
        }

        case 'unset': {
            if (rest.length < 2) {
                complain(['drover settings: unset needs a key']);
                return 2;
            }
            const who = needSession(named, env);
            if ('error' in who) {
                complain(who.error);
                return 2;
            }
            const key = rest[1] as string;
            const got = await askBus(() => settingsPatch(who.session, JSON.stringify({ [key]: null }), 'cli', base));
            if ('error' in got) {
                complain(got.error);
                return 1;
            }
            const no = refused(got.body);
            if (no) {
                complain(no);
                return 1;
            }
            say([cat(key, ' is back on the default (', tostring(field(field(parsed(got.body), 'effective'), key)), ')')]);
            return 0;
        }

        case 'clear': {
            const who = needSession(named, env);
            if ('error' in who) {
                complain(who.error);
                return 2;
            }
            const got = await askBus(() => settingsDelete(who.session, base));
            if ('error' in got) {
                complain(got.error);
                return 1;
            }
            const no = refused(got.body);
            if (no) {
                complain(no);
                return 1;
            }
            say([`every override dropped for ${who.session}`]);
            return 0;
        }

        case 'list': {
            const got = await askBus(() => settingsAll(base));
            if ('error' in got) {
                complain(got.error);
                return 1;
            }
            if (asJson) {
                say([got.body]);
                return 0;
            }
            say(printList(parsed(got.body)));
            return 0;
        }

        case 'defaults':
            return await runDefaults(rest, asJson, base);

        // A mode is a MACRO on the bus (DROVE-72): PATCH {mode: name} expands
        // the saved row into the four channel keys in the same write and keeps
        // the label. The MACHINE is the default target, because Clay described
        // the toggles as global; `--session <id>` narrows it to one session,
        // which the store already supports. Note that this branch reads the
        // FLAG only — it never calls need_session, so a bare `drover settings
        // mode direct` inside a session still moves the machine.
        case 'mode':
            return await runMode(rest, named, asJson, base);

        case 'fallback':
            return await runFallback(rest, named, env, base);

        default:
            complain([`drover settings: unknown verb '${verb}' (try --help)`]);
            return 2;
    }
}

async function runDefaults(rest: string[], asJson: boolean, base: string): Promise<number> {
    const sub = rest[1] || 'show';
    if (sub === 'show') {
        const got = await askBus(() => settingsDefaults(base));
        if ('error' in got) {
            complain(got.error);
            return 1;
        }
        if (asJson) {
            say([got.body]);
            return 0;
        }
        const defaults = object(field(parsed(got.body), 'defaults')) ?? {};
        say(Object.entries(defaults).map(([k, v]) => `  ${k} = ${tostring(v)}`));
        return 0;
    }
    if (sub === 'set') {
        if (rest.length < 4) {
            complain(['drover settings: defaults set needs a key and a value']);
            return 2;
        }
        const key = rest[2] as string;
        const typed = typedPatch(key, rest[3] as string);
        if ('error' in typed) {
            complain(typed.error);
            return 2;
        }
        const got = await askBus(() => settingsPatchDefaults(JSON.stringify(typed.patch), 'cli', base));
        if ('error' in got) {
            complain(got.error);
            return 1;
        }
        const no = refused(got.body);
        if (no) {
            complain(no);
            return 1;
        }
        say([cat('default ', key, ' = ', tostring(field(field(parsed(got.body), 'defaults'), key)))]);
        return 0;
    }
    complain(['drover settings: defaults takes show or set (try --help)']);
    return 2;
}

async function runMode(rest: string[], named: string, asJson: boolean, base: string): Promise<number> {
    const sub = rest[1] ?? '';
    if (sub === '') {
        const got = await askBus(() => settingsDefaults(base));
        if ('error' in got) {
            complain(got.error);
            return 1;
        }
        const doc = parsed(got.body);
        if (asJson) {
            const d = field(doc, 'defaults');
            say([JSON.stringify({ mode: field(d, 'mode'), modes: field(d, 'modes') })]);
            return 0;
        }
        say(printModes(doc));
        return 0;
    }
    if (sub === 'save') {
        if (rest.length < 4) {
            complain([
                'drover settings: mode save needs a name and a JSON row',
                '  drover settings mode save driving \'{"announceVisual":false,"announceHaptic":true,"announceAudio":true,"answerAudio":"click"}\'',
            ]);
            return 2;
        }
        const name = rest[2] as string;
        const row = parseStrict(rest[3] as string);
        if (!row.ok || object(row.value) === null) {
            complain(['drover settings: the row must be a JSON object of the four channel keys']);
            return 2;
        }
        const got = await askBus(() => settingsPatchDefaults(JSON.stringify({ modes: { [name]: row.value } }), 'cli', base));
        if ('error' in got) {
            complain(got.error);
            return 1;
        }
        const no = refused(got.body);
        if (no) {
            complain(no);
            return 1;
        }
        say([`mode ${name} saved on this machine`]);
        return 0;
    }
    const typed = typedPatch('mode', sub);
    if ('error' in typed) {
        complain(typed.error);
        return 2;
    }
    const body = JSON.stringify(typed.patch);
    if (named) {
        const got = await askBus(() => settingsPatch(named, body, 'cli', base));
        if ('error' in got) {
            complain(got.error);
            return 1;
        }
        const no = refused(got.body);
        if (no) {
            complain(no);
            return 1;
        }
        say([cat('session mode = ', tostring(alt(field(field(parsed(got.body), 'effective'), 'mode'), 'none')))]);
        return 0;
    }
    const got = await askBus(() => settingsPatchDefaults(body, 'cli', base));
    if ('error' in got) {
        complain(got.error);
        return 1;
    }
    const no = refused(got.body);
    if (no) {
        complain(no);
        return 1;
    }
    say([cat('machine mode = ', tostring(alt(field(field(parsed(got.body), 'defaults'), 'mode'), 'none')))]);
    return 0;
}

async function runFallback(rest: string[], named: string, env: Env, base: string): Promise<number> {
    if (rest.length < 3) {
        complain([
            'drover settings: fallback needs a family and a chain',
            '  drover settings fallback fable opus,sonnet',
            '  drover settings fallback fable none',
        ]);
        return 2;
    }
    const who = needSession(named, env);
    if ('error' in who) {
        complain(who.error);
        return 2;
    }
    const current = await askBus(() => settingsShow(who.session, base));
    if ('error' in current) {
        complain(current.error);
        return 1;
    }
    const chains = mergedChains(parsed(current.body), rest[1] as string, rest[2] as string);
    const got = await askBus(() => settingsPatch(who.session, JSON.stringify({ familyFallback: chains }), 'cli', base));
    if ('error' in got) {
        complain(got.error);
        return 1;
    }
    const no = refused(got.body);
    if (no) {
        complain(no);
        return 1;
    }
    say([printChains(parsed(got.body))]);
    return 0;
}
