/**
 * `drover flip-policy` — what a session does when it runs out (BASED-117),
 * ported from libexec/drover-flip-policy (DROVE-315 wave 2b).
 *
 * Three verbs, one decision:
 *
 *   rank    the accounts ordered by HEADROOM, most to least, with the ordering
 *           key on every row. The picker and the prompt both render this.
 *   decide  read this session's settings and say what should happen. Pure: it
 *           reads, it prints JSON, it changes nothing.
 *   apply   do it. Auto-flip, or raise the question and block on the answer, or
 *           stop and say why.
 *
 * THE RANKING AND THE DECISION ARE NOT HERE. They are in
 * src/drover/flip/rank.ts, which `pickTarget` also calls — that is the whole
 * point of the port. The shell file this replaces held the only copy of the
 * policy and nothing on the real limit path ever called it (DROVE-4); now there
 * is one ranking, and this verb is a renderer for it.
 *
 * Every sentence and every exit code below is the shell's, kept word for word,
 * because a caller reads the words and a script reads the number.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { droverEnv } from './env';
import { busGet, busPost, BusError } from './bus';
import {
    decide,
    isBackdoorRow,
    rankAccounts,
    type DecideSettings,
    type Decision,
    type RankedAccount,
} from '../flip/rank';
import { registryPath } from '../flip/accounts';

const usage = `drover flip-policy — the per-session answer to "you have run out".

USAGE
  drover flip-policy rank [--family <f>] [--exclude <account>] [--json]
        Every account ordered by headroom, most to least, with the ordering
        key on each row. This is the order the picker and the limit prompt use.

  drover flip-policy decide [--session <id>] [--family <f>] [--account <cur>] [--json]
        What WOULD happen, given this session's settings. Reads only.
        Prints one of: auto / prompt / fallback / stop, and why.

  drover flip-policy apply [--session <id>] [--family <f>] [--account <cur>]
                           [--reason "..."] [--pane <p>] [--cwd <dir>] [--dry-run]
        Do it. auto and fallback POST the flip; prompt raises the question on
        the bus and BLOCKS until it is answered; stop halts and says why.

        exit 0  flipped (or fell back)
        exit 3  stopped: nothing has the model and the session says stop
        exit 4  parked: the prompt was answered "stay here"
        exit 5  nothing done: this session is on the BACK DOOR account
        exit 1  the bus could not be reached, or refused

THE BACK DOOR — main, and every row on the same login
  main is the row on the ambient config dir (~/.claude), and it is Clay's way
  back in when everything else is stuck: switch to it by hand, log in from
  there. Two rules keep it that way, and neither of them touches an explicit
  flip.

    ON it       auto-flip is OFF. decide answers \`backdoor\` and apply exits 5
                without flipping, downgrading or parking. It says so once;
                there is no park, so there are no parked beats either.
    THROUGH it  it is not an auto-flip candidate at all — not for the family,
                not for any rung of the fallback chain — until every other
                account has come back empty for all of them. Only then may a
                flip land there, and the decision carries backdoorLastResort
                and says it in words.

  \`drover flip main\`, \`drover --account main\` and Switch on the phone are
  unaffected: they never came through here, and picking main out of the tmux
  picker or the limit prompt is a choice, not an auto-flip.

  --family    the model family the session is running (fable, opus, sonnet, …).
              Omitted means UNKNOWN, and unknown is conservative: every limit
              counts, exactly as the fork's pickTarget treats it.
  --account   the account the session is on now, so it is not offered itself.
              Defaults to $DROVER_ACCOUNT, then whereabouts.json.

SETTINGS  (drover settings — this reads them, that writes them)
  onLimit            prompt (default) | auto
  onLimitTimeout     auto (default) | stop
  onFamilyExhausted  flip-then-downgrade (default) | flip-only | downgrade-only | nothing
  familyFallback     fable -> opus, sonnet …

THE ORDERING KEY, spelled out on every row:
  "62% left"            eligible, and that is the room on its fullest limit
  "headroom unmeasured" eligible, but Claude Code has cached no usage for it —
                        sorted after every measured account, because guessing
                        either end of the scale is how a table starts lying
  "0% · back Thu 21:00" blocked, and when it comes back
  "no login"            a flip cannot land here at all
  "never run"           logged in, but the config dir has never been through
                        Claude Code's one-time first run, so a session there
                        opens on a theme picker. Equally dead; different fix
                        (drover trust, not drover account add)

See also: drover settings, drover accounts, docs/flip-policy.md
`;

interface Args {
    verb: string;
    family: string;
    session: string;
    current: string;
    exclude: string;
    reason: string;
    pane: string;
    cwd: string;
    asJson: boolean;
    dryRun: boolean;
}

/** Thrown for the two-line "say what went wrong and stop" paths. */
class Refused extends Error {
    constructor(readonly lines: string[], readonly code: number) {
        super(lines[0] ?? '');
    }
}

/**
 * `shift 2` with one argument left is an error, and under `set -e` it aborts
 * with no message at all — the trap drover-flip-menu documents. Every
 * two-argument flag names its missing value instead.
 */
function needVal(flag: string, rest: number): void {
    if (rest < 1) throw new Refused([`drover flip-policy: ${flag} needs a value`], 2);
}

function parse(argv: string[]): Args | { help: true } {
    const a: Args = {
        verb: argv[0] ?? '',
        family: '', session: '', current: '', exclude: '', reason: '', pane: '', cwd: '',
        asJson: false, dryRun: false,
    };
    const args = argv.slice(1);
    let i = 0;
    while (i < args.length) {
        const arg = args[i]!;
        const rest = args.length - i - 1;
        const valued = (flag: string): string => { needVal(flag, rest); i += 2; return args[i - 1]!; };
        if (arg === '--family') a.family = valued(arg);
        else if (arg.startsWith('--family=')) { a.family = arg.slice('--family='.length); i += 1; }
        else if (arg === '--session') a.session = valued(arg);
        else if (arg.startsWith('--session=')) { a.session = arg.slice('--session='.length); i += 1; }
        else if (arg === '--account') a.current = valued(arg);
        else if (arg.startsWith('--account=')) { a.current = arg.slice('--account='.length); i += 1; }
        else if (arg === '--exclude') a.exclude = valued(arg);
        else if (arg === '--reason') a.reason = valued(arg);
        else if (arg === '--pane') a.pane = valued(arg);
        else if (arg === '--cwd') a.cwd = valued(arg);
        else if (arg === '--json') { a.asJson = true; i += 1; }
        else if (arg === '--dry-run') { a.dryRun = true; i += 1; }
        else if (arg === '-h' || arg === '--help') return { help: true };
        else throw new Refused([`drover flip-policy: unknown argument '${arg}' (try --help)`], 2);
    }
    // Family names are normalized to lower case in one place, because the
    // ledger writes them lower and a human types them however. An empty family
    // stays empty: unknown is a real state, not a missing value to be filled in.
    a.family = a.family.toLowerCase();
    return a;
}

/**
 * Where the session is, when nothing said. DROVER_ACCOUNT is the stamp the
 * wrapper exports; whereabouts.json is what the fork wrote down last time this
 * session moved. Neither is required — with no current account nothing is
 * excluded, which is only ever too permissive by one row.
 */
function resolveCurrent(a: Args): void {
    if (!a.current) a.current = process.env.DROVER_ACCOUNT ?? '';
    if (!a.current && a.session) {
        const file = join(droverEnv().stateDir, 'whereabouts.json');
        try {
            if (existsSync(file)) {
                const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { account?: unknown }>;
                const seen = raw?.[a.session]?.account;
                if (typeof seen === 'string') a.current = seen;
            }
        } catch { /* an unreadable memory is not a reason to refuse a flip */ }
    }
    if (!a.exclude) a.exclude = a.current;
}

/** The ranking, or the shell's one refusal when there is no registry to read. */
function ranked(a: Args, family = a.family, exclude = a.exclude): RankedAccount[] {
    const path = registryPath();
    if (!existsSync(path)) {
        throw new Refused([`drover flip-policy: could not read the account registry (${path})`], 1);
    }
    return rankAccounts({ family, exclude });
}

// --- settings ----------------------------------------------------------------

interface Settings extends DecideSettings {
    onLimitTimeout: string;
    promptTtlMs: number;
}

/**
 * Read ONCE, up front, so a decision is made against one snapshot. Reading them
 * per branch would let a toggle from the phone land halfway through and produce
 * a decision that matches neither setting.
 */
async function loadSettings(a: Args, warn: (line: string) => void): Promise<Settings> {
    const s: Settings = {
        onLimit: 'prompt',
        onLimitTimeout: 'auto',
        // The shell's own pre-bus default, and it is `stop` rather than one of
        // the four documented values: with no session there is nothing to read,
        // and `stop` was this key's original spelling. Kept as it stands so the
        // no-session path answers exactly as the shell answered.
        onFamilyExhausted: 'stop',
        promptTtlMs: 600000,
        chain: [],
    };
    if (!a.session) return s;
    let body: string;
    try {
        const res = await busGet(`/v1/settings/sessions/${a.session}`, 10);
        body = res.body;
    } catch {
        // A settings read that fails must never abort a flip: the whole point is
        // to keep a session working when it runs out. The built-in defaults are
        // what an unreadable store means, and the sentence says so.
        warn('drover flip-policy: could not read settings from the bus — using the built-in defaults');
        return s;
    }
    let effective: Record<string, unknown>;
    try {
        effective = ((JSON.parse(body) as { effective?: Record<string, unknown> })?.effective ?? {});
    } catch {
        warn('drover flip-policy: could not read settings from the bus — using the built-in defaults');
        return s;
    }
    if (typeof effective.onLimit === 'string') s.onLimit = effective.onLimit === 'auto' ? 'auto' : 'prompt';
    if (typeof effective.onLimitTimeout === 'string') s.onLimitTimeout = effective.onLimitTimeout;
    // DROVE-187 gave this key four values. The two it shipped with are still
    // accepted by the store, so a settings file written before that ticket keeps
    // working: `fallback` always meant "swap the model when you have to" and
    // `stop` always meant "never swap it". Anything unrecognised reads as the
    // default rather than as "do nothing" — a newer client's value must not be
    // the reason a session sits dead.
    const raw = typeof effective.onFamilyExhausted === 'string' ? effective.onFamilyExhausted : 'flip-then-downgrade';
    s.onFamilyExhausted =
        raw === 'flip-then-downgrade' || raw === 'flip-only' || raw === 'downgrade-only' || raw === 'nothing' ? raw
            : raw === 'fallback' ? 'flip-then-downgrade'
                : raw === 'stop' ? 'flip-only'
                    : 'flip-then-downgrade';
    const ttl = effective.onLimitPromptTtlMs;
    s.promptTtlMs = typeof ttl === 'number' && Number.isFinite(ttl) ? ttl : 600000;
    if (a.family) {
        const map = effective.familyFallback;
        const chain = map && typeof map === 'object' ? (map as Record<string, unknown>)[a.family] : undefined;
        s.chain = Array.isArray(chain) ? chain.filter((f): f is string => typeof f === 'string') : [];
    }
    return s;
}

// --- the log ------------------------------------------------------------------

/**
 * One line per decision, so a substitution Clay did not watch happen is still
 * findable afterwards. The transcript says it too (the flip prompt carries the
 * sentence), but a transcript is inside the session that moved and this file is
 * not — and "which account did it put me on last night" is asked from outside.
 */
function note(a: Args, what: string, detail: string): void {
    const file = join(droverEnv().stateDir, 'flip-policy.log');
    try {
        mkdirSync(dirname(file), { recursive: true });
        const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        appendFileSync(file, `${stamp}\t${a.session || '-'}\t${what}\t${detail}\n`);
    } catch { /* a log that cannot be written must never stop a flip */ }
}

// --- doing it -----------------------------------------------------------------

/**
 * What the resumed session is told. The flip frame's `prompt` overrides every
 * other scope in the fork's resolver, so this sentence is what lands in the
 * transcript — which is the acceptance criterion: the session SAYS which
 * account it moved to and why, rather than silently continuing somewhere else.
 */
function flipPrompt(to: string, key: string, why: string, sub: string): string {
    let out = `Cattle Drover moved this session to the ${to} account: ${why}. Headroom there: ${key}.`;
    if (sub) out += ` MODEL SUBSTITUTED: ${sub}.`;
    return out + ' Carry on from where the conversation left off.\n';
}

interface Out {
    say: (line: string) => void;
    warn: (line: string) => void;
}

/**
 * The same POST `drover flip` makes, addressed the most specific way we can. A
 * flip frame nobody matches vanishes silently, so the target is the session id
 * when we have one.
 *
 * Returns the exit code to STOP with, or null to carry on.
 */
async function postFlip(a: Args, account: string, prompt: string, out: Out): Promise<number | null> {
    const target = a.session ? { sessionId: a.session }
        : a.pane ? { pane: a.pane }
            : a.cwd ? { cwd: a.cwd } : null;
    if (!target) {
        out.warn('drover flip-policy: no target — pass --session, --pane or --cwd');
        return 2;
    }
    const body = { account, prompt, by: 'policy', reason: a.reason || 'usage limit', ...target };
    // A dry run must not go on to print "flipped to X" — a rehearsal that reads
    // like the real thing is worse than no rehearsal. Stop here, from the whole
    // verb, rather than returning into the success line.
    if (a.dryRun) {
        out.say(`would POST /v1/flip ${JSON.stringify(body)}`);
        return 0;
    }
    let res;
    try {
        res = await busPost('/v1/flip', body, 10);
    } catch (err) {
        for (const line of (err as BusError).explain('the flip endpoint')) out.warn(line);
        return 1;
    }
    if (res.body.includes('"error"')) {
        out.warn(`drover flip-policy: the bus refused the flip: ${res.body}`);
        return 1;
    }
    return null;
}

/**
 * The prompt on the bus, and the block on its answer. This is the whole of
 * `onLimit: prompt`.
 *
 * It is a `question`, not a `permission`: a permission is answered yes or no and
 * this is a choice between accounts. The options ARE the ranked list, in order,
 * with the headroom key in every label — so the ordering is visible on the
 * phone, the watch and the tmux popup without any of them re-deriving it.
 */
async function askWhichAccount(a: Args, s: Settings, ranked: RankedAccount[], out: Out): Promise<string> {
    const options = ranked.filter((r) => r.eligible).map((r) => ({
        id: r.name,
        // The back door stays IN this list: answering the prompt is Clay
        // choosing, which is exactly the manual path the rule preserves. It is
        // labelled so the choice is an informed one (DROVE-333).
        label: `${r.name} — ${r.key}${r.backdoor ? ' · back door' : ''}`,
        description: `rank ${r.rank}${r.backdoor ? ' · manual flips only' : ''}${r.reason ? ` · ${r.reason}` : ''}`,
    }));
    // Staying put is always an option, and it is last. Without it the only way
    // out of the card is the TTL, and a prompt whose only exit is a timeout is
    // the stranded card this whole broker exists to kill.
    options.push({
        id: '__stay',
        label: 'Stay here and park',
        description: 'do not flip; wait for this account to come back',
    });
    const surface = a.pane || process.env.TMUX_PANE || '';
    const payload = {
        kind: 'question',
        title: 'Out of headroom — which account?',
        reason: a.reason || 'Claude reported a usage limit',
        preview: ranked.map((r) => `  ${r.rank}. ${r.name} — ${r.key}`).join('\n'),
        options,
        ttlMs: s.promptTtlMs,
        channel: 'hook-wait',
        origin: {
            harness: 'claude-code',
            gate: 'flip-policy',
            sessionId: a.session || null,
            cwd: (a.cwd || process.cwd()) || null,
            account: a.current || null,
            surface: surface || null,
        },
    };
    let res;
    try {
        res = await busPost('/v1/events', payload, 10);
    } catch (err) {
        for (const line of (err as BusError).explain('the events endpoint')) out.warn(line);
        throw new Refused([], 1);
    }
    let id = '';
    try {
        const parsed = JSON.parse(res.body) as { id?: unknown };
        if (typeof parsed.id === 'string') id = parsed.id;
    } catch { /* handled by the empty-id refusal below */ }
    if (!id) {
        out.warn(`drover flip-policy: the bus refused the prompt: ${res.body}`);
        throw new Refused([], 1);
    }
    note(a, 'prompt', id);
    out.warn(`drover flip-policy: asking which account (${id}) — answer on the phone, the watch or in tmux`);
    // +10s so the long poll outlives the TTL rather than racing it: a poll that
    // gives up first turns an expired prompt into a timeout with no record of
    // which it was.
    const waitMs = s.promptTtlMs + 10_000;
    let answer;
    try {
        answer = await busGet(`/v1/events/${id}/wait?timeout_ms=${s.promptTtlMs}`, waitMs);
    } catch (err) {
        for (const line of (err as BusError).explain('the answer')) out.warn(line);
        throw new Refused([], 1);
    }
    try {
        const parsed = JSON.parse(answer.body) as { resolution?: { optionId?: unknown }; state?: unknown };
        const chosen = parsed?.resolution?.optionId;
        if (typeof chosen === 'string' && chosen) return chosen;
        if (typeof parsed?.state === 'string' && parsed.state) return parsed.state;
    } catch { /* an unparseable answer is a timeout, which is a real branch */ }
    return 'timeout';
}

// --- the verbs ----------------------------------------------------------------

function renderRank(rows: RankedAccount[]): string[] {
    const out = ['  #  ACCOUNT              HEADROOM'];
    for (const r of rows) {
        // The back door is marked on the row, because a table that ranks it
        // first and never explains why an auto-flip skipped it is a table that
        // contradicts the picker (DROVE-333).
        out.push(`  ${r.rank}  ${(r.name + '                    ').slice(0, 20)} ${r.key}` +
            (r.excluded ? '   (this session is here)' : r.eligible ? '' : '   —') +
            (r.backdoor ? '   (back door — manual flips only)' : ''));
    }
    return out;
}

async function apply(a: Args, s: Settings, d: Decision, out: Out): Promise<number> {
    const account = d.account ?? '';
    const key = d.key ?? 'unknown';

    if (d.action === 'backdoor') {
        // ON THE BACK DOOR (DROVE-333). One sentence, then nothing: no POST, no
        // prompt, no park and therefore none of the "still parked — 40m to go"
        // beats a park would print. Said once because there is nothing to wait for.
        note(a, 'backdoor', a.current);
        out.warn(`drover flip-policy: ${d.why}`);
        return 5;
    }
    if (d.action === 'auto') {
        note(a, 'auto', `${account} (${key})`);
        const stop = await postFlip(a, account, flipPrompt(account, key, d.why, ''), out);
        if (stop !== null) return stop;
        out.say(`flipped to ${account} — ${d.why}`);
        return 0;
    }
    if (d.action === 'fallback') {
        const sub = `${d.fromFamily} is exhausted, so this session now runs ${d.family}`;
        note(a, 'fallback', `${account} (${key}) ${d.fromFamily} -> ${d.family}`);
        const stop = await postFlip(a, account, flipPrompt(account, key, d.why, sub), out);
        if (stop !== null) return stop;
        out.say(`fell back to ${account} — ${d.why}`);
        return 0;
    }
    if (d.action === 'stop') {
        note(a, 'stop', d.why);
        out.warn(`drover flip-policy: STOPPED. ${d.why}`);
        out.warn('  This session is set to stop rather than substitute a model.');
        out.warn('  Change it:  drover settings set onFamilyExhausted downgrade-only');
        out.warn('  Or move by hand:  drover --account <name>   (an explicit account overrules the ledger)');
        return 3;
    }

    // onLimit: prompt. Raise the question, block, act on the answer.
    const chosen = await askWhichAccount(a, s, d.ranked, out);
    if (chosen === '__stay') {
        note(a, 'parked', 'answered: stay here');
        out.say(`parked on ${a.current || 'this account'} — you chose to stay`);
        return 4;
    }
    if (chosen === 'expired' || chosen === 'timeout' || chosen === 'canceled' || chosen === '') {
        // NOBODY ANSWERED. This is the one branch where the policy has to decide
        // without Clay, and which way it falls is itself a setting: `auto` keeps
        // an unattended session working, `stop` refuses to move a session nobody
        // steered. Either way it is written down, because a flip that happened
        // because a question timed out must not look like a flip somebody chose.
        if (s.onLimitTimeout === 'stop') {
            note(a, 'timeout-stop', 'nobody answered the account prompt');
            out.warn('drover flip-policy: nobody answered which account to move to, and this');
            out.warn('  session is set to stop on that. Move it by hand: drover --account <name>');
            return 3;
        }
        // NOBODY ANSWERED IS AN AUTOMATIC CHOICE, so the back door is off the
        // table here too (DROVE-333) — a prompt that times out must not be the
        // way a session drifts onto main. Only when there is no other eligible
        // row at all does it read the back door, and then it says which it took.
        let row = d.ranked.find((r) => r.eligible && !r.backdoor);
        let last = '';
        if (!row) {
            row = d.ranked.find((r) => r.eligible);
            if (row) last = ' It is the BACK DOOR account, taken only because nothing else had headroom';
        }
        if (!row) {
            out.warn('drover flip-policy: nobody answered and nothing has headroom now either');
            return 3;
        }
        note(a, 'timeout-auto', `${row.name} (${row.key})${last ? ' [backdoor last resort]' : ''}`);
        const stop = await postFlip(a, row.name, flipPrompt(row.name, row.key,
            `nobody answered the account prompt inside ${s.promptTtlMs}ms, so the session took the account with the most headroom.${last}`,
            ''), out);
        if (stop !== null) return stop;
        out.say(`nobody answered — flipped to ${row.name} (${row.key})`);
        return 0;
    }

    const chosenKey = d.ranked.find((r) => r.name === chosen)?.key ?? 'unknown';
    note(a, 'chose', `${chosen} (${chosenKey})`);
    const stop = await postFlip(a, chosen, flipPrompt(chosen, chosenKey, 'you picked it from the limit prompt', ''), out);
    if (stop !== null) return stop;
    out.say(`flipped to ${chosen} — ${chosenKey}`);
    return 0;
}

export async function run(argv: string[]): Promise<number> {
    const out: Out = {
        say: (line) => process.stdout.write(line + '\n'),
        warn: (line) => process.stderr.write(line + '\n'),
    };
    try {
        const parsed = parse(argv);
        if ('help' in parsed) { out.say(usage.trimEnd()); return 0; }
        const a = parsed;
        if (a.verb === '' || a.verb === 'help' || a.verb === '-h' || a.verb === '--help') {
            out.say(usage.trimEnd());
            return 0;
        }
        if (a.verb !== 'rank' && a.verb !== 'decide' && a.verb !== 'apply') {
            out.warn(`drover flip-policy: unknown verb '${a.verb}' (try --help)`);
            return 2;
        }
        resolveCurrent(a);

        if (a.verb === 'rank') {
            const rows = ranked(a);
            if (a.asJson) { out.say(JSON.stringify(rows, null, 2)); return 0; }
            for (const line of renderRank(rows)) out.say(line);
            return 0;
        }

        const settings = await loadSettings(a, out.warn);
        // The one refusal decide() cannot make for itself: with no registry
        // there is nothing to rank and nothing to decide.
        ranked(a);
        const d = decide({ family: a.family, exclude: a.exclude, settings });

        if (a.verb === 'decide') {
            if (a.asJson) { out.say(JSON.stringify(d, null, 2)); return 0; }
            out.say(`${d.action}: ${d.why}`);
            return 0;
        }
        return await apply(a, settings, d, out);
    } catch (err) {
        if (err instanceof Refused) {
            for (const line of err.lines) out.warn(line);
            return err.code;
        }
        throw err;
    }
}

/** Re-exported for the tests, which assert the table exactly as tmux renders it. */
export { renderRank, isBackdoorRow };
