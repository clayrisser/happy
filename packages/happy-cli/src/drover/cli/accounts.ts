/**
 * `drover accounts` — the account registry and the cooldown ledger, together
 * (DROVE-315 wave 2a, ported from libexec/drover-accounts).
 *
 * Two files answer one question ("where can work go right now?"), so they are
 * read as one. The registry is accounts.json; the ledger is cooldowns.json in
 * the state dir, written by the flip controller whenever Claude reports a
 * usage limit. Registry ORDER is preference order — it is a list Clay wrote,
 * not a set — so the first `ready` row is where a bare `drover flip` sends the
 * session.
 *
 * WHAT THE PORT HAD TO KEEP, VERBATIM. The shell's answer is one jq program,
 * and every clause in it is a bug somebody already paid for: which limit is
 * blamed when two clear 252 microseconds apart, why a Fable-only limit prints
 * as "Fable cooling" and not a bare "cooling", why a twin's rows are read as
 * this row's own, why a cursor row is never the ambient account. The prose
 * that justified each one travels with it here, because the reasoning is what
 * stops the next edit undoing it.
 *
 * ONE READER, TWO SURFACES. `--json` is what the phone, the bridge and
 * libexec/drover-flip-policy read, so it is byte-identical to the shell's on
 * the same fixture — same key order, same nulls, same two-space jq indent.
 * The table is derived from the same rows, so the two cannot drift into
 * saying different things.
 *
 * NOTHING HERE IS A FORK. The shell spent 108 jq on eleven accounts (4.4s
 * best, 30.7s worst at load 22, against 0.01s of actual file reading —
 * DROVE-280). This spends none: the config documents are read once and every
 * question is asked of the parsed object.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    type AccountRow,
    type ConfigDoc,
    type LedgerEntry,
    accountConfigFile,
    accountDataDir,
    accountOrphans,
    cursorAuthRead,
    cursorAuthStore,
    cursorTokenDaysLeft,
    cursorTokenState,
    expandHome,
    home as homeOf,
    jqJson,
    readConfigs,
} from './account-store';
import { droverEnv } from './env';

const help = `drover accounts — list subscriptions, and which are out of headroom.

USAGE
  drover accounts            Table: current account (*), state, config dir
  drover accounts --json     The registry merged with the cooldown ledger
                             (\`family\` names the model when only one is out)
  drover accounts --orphans  Only the orphan report: config dirs holding a
                             login no registry row points at. Combines with
                             --json. \`drover doctor\` prints it too.

STATES
  ready      has headroom AND can start a session; a flip can land here
  cooling    out of headroom; the reason and the reset are shown
  no login   the row exists but nothing has ever logged in there
  never run  logged in, but Claude Code's one-time first-run wizard has never
             been settled for that config dir, so a session there opens on a
             theme picker instead of a prompt. A flip cannot answer it, which
             is why the row is not flippable. Fix: drover trust

  ready · unmeasured
             a CURSOR account. Cursor publishes no quota anywhere, so there is
             no headroom to report and the row says so rather than showing a
             healthy-looking 100%. Work can go there; nobody knows how much.
  renew in Nd
             a CURSOR account whose token still works but runs out in under a
             week. It cannot be refreshed — the repair is a browser login — so
             this is said while there is still time to act on it, not after.
             Work still goes there; a flip is unaffected.
  login expired
             a cursor token past its own expiry. A cursor token CANNOT be
             renewed — cursor-agent has no refresh flow for it — so the fix is
             another login:
               drover account login --harness cursor <name>
  signed out
             a cursor account something signed out. What is stored is the
             marker cursor-agent leaves behind, not a token. Same fix, but it
             is not a lapse and not a clock problem.

  A state with a MODEL in front of it — "Fable cooling" — means only that
  model ran out there. Every other model still runs on that account, and a
  session on one will be sent there. This used to print as a bare "cooling",
  which reads as a lockout: Clay saw "main cooling - back Thu 21:00 (5d 17h)"
  above a reason line that said Fable, on an Opus session the picker would
  have handed main that minute. A table that contradicts the picker is worse
  than no table.

  Two things can say "cooling", and the later reset wins. The ledger is what a
  drover session WATCHED happen — Claude reported a limit and the flip wrote it
  down. Claude Code's own \`cachedUsageUtilization\`, in each account's
  .claude.json, is what it last MEASURED, and it is the only one that knows
  about an account emptied somewhere else. Neither is read as proof of
  headroom: only a limit already at 100% ever marks an account cooling, so a
  stale cache can never park a session that could have worked.

  A reset more than a day out prints its WEEKDAY. "back 21:00" for a weekly
  limit that clears on Wednesday reads as tonight, and a five-day park looks
  like a five-hour one.

  "same login as X" under a row means two names for ONE claude.ai login —
  the same address in both .claude.json files. A quota belongs to the login,
  so the two rows share one state and the flip never moves between them.
  The registry is not edited; the duplicate is only marked.

LOGIN
  An account that has never been logged in is marked \`no login\`. Log it in:
    drover account add <name>

  A CREDENTIAL IS NOT ENOUGH, and reading it as though it were is DROVE-246.
  A config dir that has never run interactively opens Claude Code's first-run
  wizard — the theme picker — whatever its login says, and a wrapped session
  cannot answer that any more than it can answer a permission prompt. Such a
  row is marked \`never run\` and is skipped by auto-flip exactly like \`no
  login\`, because in both cases a flip there goes nowhere. Settle it with:
    drover trust

  --json carries all three: \`loggedIn\` (there is a credential), \`onboarded\`
  (the wizard is settled) and \`verified\`, which is both and is the one field a
  caller deciding "can a flip land here" should read.

  configDir "default" (or no configDir at all) means the account you are
  ALREADY logged into: Claude Code reads its global config from
  CLAUDE_CONFIG_DIR or, when that is unset, ~/.claude.json. Pointing the
  variable at ~/.claude is NOT the same thing — it moves the global config to
  ~/.claude/.claude.json, an empty file, so that account is brand new.

Registry order breaks ties BETWEEN accounts that have headroom: a bare
\`drover flip\` takes the first row still marked ready. Naming one explicitly
overrides the ledger.

Add an account (this logs it in too):
  drover account add <name>
  drover account login --harness cursor [name]   a Cursor subscription

CURSOR ACCOUNTS
  A cursor row carries a TOKEN rather than a config dir, so sessions on two
  cursor accounts run side by side with no flip and no swap. A flip moves
  Claude accounts only, and cursor rows never appear in its ranking.
  See docs/cursor-accounts.md, and start one with: drover cursor --account <name>

ORPHANS
  A config dir under ~/.claude-accounts holding a real login that NO registry
  row points at. Every refused or repeated login mints a fresh account-N and
  the abandoned directory stays on disk with its credential, so they pile up
  where nothing can see them — the table lists ROWS, and an orphan has none.

  The report names the ADDRESS each one is logged in as, because that is what
  decides the answer:

    duplicate: <name> is registered at <dir>
              another, REGISTERED account is this same claude.ai login. The
              orphan is the copy a retry minted; purging it loses nothing.
    no registry row holds this address
              the LOGIN is fine and the REGISTRY lost its row. Adopt it. A
              purge here throws the account away.

  Nothing here deletes anything, ever. Adopt one, or remove it deliberately:
    drover account add <name> --config-dir <dir>
    drover account rm <name> --purge
`;

// --- jq semantics, kept honest ------------------------------------------------
//
// The shell's answer is a jq program, so the port has to agree with jq about
// what a value MEANS, not only about what it is. Three of jq's rules show up
// in this program and each of them changes a row:
//
//   `a // b` yields b when a is null OR FALSE. `.scope.surface // null` turns
//   a literal `false` into null, so a surface of false is account-wide.
//   `>=` compares ACROSS types by jq's total order (null < false < true <
//   numbers < strings < arrays < objects), so a percent recorded as a string
//   is greater than 100 and its row counts as maxed out.
//   `%` truncates both operands to integers before dividing.

/** jq's `//`: the alternative when the left side is null, undefined or false. */
function alt<T>(value: unknown, fallback: T): T | Exclude<unknown, null> {
    if (value === null || value === undefined || value === false) return fallback;
    return value as T;
}

/** jq's type order, as a rank. Only the cases this program can meet. */
function jqRank(v: unknown): number {
    if (v === null || v === undefined) return 0;
    if (v === false) return 1;
    if (v === true) return 2;
    if (typeof v === 'number') return 3;
    if (typeof v === 'string') return 4;
    if (Array.isArray(v)) return 5;
    return 6;
}

/** jq's `a >= b` where b is a number. */
function jqGte(a: unknown, b: number): boolean {
    const ra = jqRank(a);
    if (ra !== 3) return ra > 3;
    return (a as number) >= b;
}

const families = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

/**
 * The usage cache's scope, reduced to a model family. Same vocabulary as the
 * CLI's limits.ts familyOfDisplayName, and it has to stay the same: these two
 * surfaces answering differently about what a limit covers IS the bug.
 *
 * Narrow on purpose — a shape nobody has seen reduces to null, and null means
 * "this stops every model", which is what everything here did before families
 * existed.
 */
export function familyOfDisplay(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const first = (value.split(/\s+/).filter((t) => t.length > 0)[0] ?? '').toLowerCase();
    return families.includes(first) ? first : null;
}

/**
 * A ledger entry's reason, reduced the same way. This exists because a
 * cooldown's reason is the harness's notice verbatim, so an entry recorded
 * before the ledger had a `family` field still names its model in plain
 * English. Three such entries are why `drover accounts` called main dead for
 * five days.
 */
export function familyOfText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const m = value.match(/\byou(?:'ve| have) reached your ([\w.+\- ]{1,30}) limit\b/i);
    if (!m) return null;
    return familyOfDisplay(m[1]);
}

/** Which model a ledger entry blames, by its own field or by its sentence. */
export function ledgerFamily(entry: LedgerEntry | null): string | null {
    if (entry === null) return null;
    if (typeof entry.family === 'string' && entry.family.length > 0) return entry.family;
    return familyOfText(entry.reason);
}

/**
 * resets_at as epoch milliseconds, or null.
 *
 * "2026-08-29T18:59:59.859969+00:00" is what Claude Code writes, and
 * fromdateiso8601 will not parse it: it wants whole seconds and a literal Z.
 * So the fraction goes, `+00:00` becomes `Z`, and anything still not in that
 * exact shape is null rather than a guess.
 */
export function epochMs(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const s = value.replace(/\.[0-9]+/, '').replace(/\+00:00$/, 'Z');
    const m = s.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/);
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    return Number.isNaN(ms) ? null : ms;
}

/** The window a limit covers, said the way a human reads it. */
function windowOf(kind: unknown): string {
    const k = String(kind);
    if (k === 'session') return '5-hour';
    if (k.startsWith('weekly')) return 'weekly';
    return k.replace(/_/g, ' ');
}

/**
 * Which model a usage row covers, or null for "this stops every model".
 *
 * A surface scope has never been observed and a display name that reduces to
 * no family is a shape nobody has shipped, so both count as account-wide: an
 * unreadable scope must never make a dead account look alive, and must never
 * sort one to the top of the picker.
 */
function limitFamily(row: Record<string, unknown>): string | null {
    const scope = (row.scope ?? null) as Record<string, unknown> | null;
    const surface = alt(scope === null ? null : scope.surface, null);
    if (surface !== null) return null;
    const model = alt(scope === null ? null : scope.model, null);
    if (model === null) return null;
    return familyOfDisplay((model as Record<string, unknown>).display_name);
}

function limitRows(doc: ConfigDoc): Record<string, unknown>[] {
    if (doc === null) return [];
    const cached = doc.cachedUsageUtilization as Record<string, unknown> | undefined;
    const util = cached === undefined || cached === null ? null : cached.utilization as Record<string, unknown> | null;
    const rows = util === null || util === undefined ? null : util.limits;
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object');
}

export interface LimitRow {
    percent: number;
    until: number | null;
    kind: string;
    family: string | null;
}

/**
 * HOW FULL, not just whether it is blocked (BASED-117).
 *
 * accountUsage below answers one question — is this account out? — and answers
 * it with a hard percent >= 100 cut, because that is the only reading that can
 * never park a session which would have worked. That is the right rule for
 * BLOCKING and it throws away the number, so the picker could only ever order
 * accounts by registry position. Clay wants the list ordered by HEADROOM, most
 * to least, which needs the percentages the cut discards.
 *
 * Two passes over the same rows rather than one wider one, deliberately: the
 * blame logic in accountUsage (which limit is quoted, which family is named) is
 * delicate and correct, and widening it to also carry a gradient is how a fix
 * to one answer silently changes the other.
 *
 * Every row is emitted, maxed or not, because family-aware headroom is for the
 * CALLER to work out: a session running Opus does not care that Fable is at
 * 100%, and only that session knows which family it is asking about.
 */
export function accountLimits(doc: ConfigDoc): LimitRow[] {
    const out: LimitRow[] = [];
    for (const row of limitRows(doc)) {
        if (alt(row.percent, null) === null) continue;
        out.push({
            percent: typeof row.percent === 'number' ? row.percent : 0,
            until: row.resets_at === null || row.resets_at === undefined ? null : epochMs(row.resets_at),
            kind: String(alt(row.kind, 'usage')),
            family: limitFamily(row),
        });
    }
    return out;
}

export interface UsageBlock {
    until: number;
    reason: string;
    family: string | null;
}

/**
 * Is this account out, according to Claude Code's OWN usage cache?
 *
 * The ledger is REACTIVE — it knows only about accounts that ran out while a
 * drover session was watching. An account emptied anywhere else (a plain
 * `claude` in another terminal, the web app, yesterday) is a blank to it, and
 * a blank used to print as "ready". That is how this table told Clay an
 * exhausted account had headroom while the flip walked straight onto it.
 *
 * Read one way only, the same as the flip controller does it: a limit at 100%
 * whose reset is still ahead rules an account OUT, and nothing here ever rules
 * one IN. A stale cache can then only be conservative.
 */
export function accountUsage(doc: ConfigDoc, nowMs: number): UsageBlock | null {
    const rows: UsageBlock[] = [];
    for (const row of limitRows(doc)) {
        if (!jqGte(alt(row.percent, 0), 100)) continue;
        if (row.resets_at === null || row.resets_at === undefined) continue;
        const until = epochMs(row.resets_at);
        const display = alt(
            (alt(row.scope, null) as Record<string, unknown> | null)?.model === undefined
                ? null
                : ((alt(row.scope, null) as Record<string, unknown>).model as Record<string, unknown> | null)?.display_name,
            '',
        );
        const head = `${String(display)} ${windowOf(alt(row.kind, 'usage'))}`;
        // ltrimstr strips the prefix ONCE, so an empty display name leaves the
        // window alone rather than eating its leading letter.
        const reason = `${head.startsWith(' ') ? head.slice(1) : head} limit at 100% (Claude Code's own usage cache)`;
        if (until === null || !(until > nowMs)) continue;
        rows.push({ until, reason, family: limitFamily(row) });
    }
    if (rows.length === 0) return null;
    // Blocked until the LAST maxed-out limit clears, so `last` here, and the
    // latest of the two sources wins again in the merge below.
    const late = stableSortByUntil(rows)[rows.length - 1];
    // The REASON prefers an account-wide row, matching readUsageExhaustion.
    // jamrizzi cleared weekly_all at 18:59:59.859969Z and its Fable row 252
    // MICROSECONDS later, so "the latest" blamed Fable when the blocker was the
    // whole week. Right verdict, wrong explanation — and the explanation is
    // what decides whether Clay switches model or waits.
    const wide = stableSortByUntil(rows.filter((r) => r.family === null));
    const widest = wide.length === 0 ? null : wide[wide.length - 1];
    return {
        until: late.until,
        reason: widest === null ? late.reason : widest.reason,
        family: rows.some((r) => r.family === null) ? null : soleFamily(rows),
    };
}

/** jq's sort_by is stable, and the tie-break below depends on it. */
function stableSortByUntil<T extends { until: number }>(rows: T[]): T[] {
    return rows.map((r, i) => ({ r, i }))
        .sort((a, b) => (a.r.until - b.r.until) || (a.i - b.i))
        .map((x) => x.r);
}

/** The one family every row names, or null when they disagree. */
function soleFamily(rows: { family: string | null }[]): string | null {
    const uniq = Array.from(new Set(rows.map((r) => r.family)));
    return uniq.length === 1 ? uniq[0] : null;
}

// --- the merge ----------------------------------------------------------------

/** One row of `drover accounts --json`, in the shell's key order. */
export interface AccountReport {
    name: unknown;
    harness: string;
    configDir: string | null;
    ambient: boolean;
    loggedIn: boolean;
    onboarded: boolean;
    verified: boolean;
    login: string | null;
    sameLoginAs: string | null;
    headroom: number | null;
    limits: LimitRow[];
    ledger: { until: number; reason: string; family: string | null } | null;
    current: boolean;
    state: string;
    until: number | null;
    family: string | null;
    reason: string | null;
    /** Cursor rows only, and appended last exactly as jq's `+` appends it. */
    expiresInDays?: number | null;
}

export interface OrphanReport {
    dir: string;
    email: string | null;
    sameLoginAs: string | null;
    sameLoginDir: string | null;
}

interface Maps {
    usg: Map<string, UsageBlock>;
    lim: Map<string, LimitRow[]>;
    lgn: Map<string, boolean>;
    onb: Map<string, boolean>;
    eml: Map<string, string>;
    ceml: Map<string, string>;
    curtok: Map<string, string>;
    curdays: Map<string, number>;
}

export interface AccountsInput {
    registry: AccountRow[];
    ledger: Record<string, LedgerEntry>;
    home: string;
    stateDir: string;
    nowMs: number;
    env: NodeJS.ProcessEnv;
}

/**
 * HOW EVERY ACCOUNT IS READ: ONCE (DROVE-280).
 *
 * A CURSOR ROW IS NOT ASKED ANY OF THE CLAUDE QUESTIONS (DROVE-256), because
 * none of them has an answer: there is no config dir, so no .claude.json to
 * read a login, an onboarding stamp or a usage cache out of. Its own two facts
 * — how its token is doing, and which address it belongs to — come from the
 * token store, never from the shared Keychain.
 *
 * EVERY LOOKUP IS GUARDED, because the shape this replaces degraded PER
 * ACCOUNT: a .claude.json that is not an object cost that one account its
 * answer and left the others alone. One program has to say that explicitly or
 * a single malformed file would take the whole table with it.
 */
function readAccounts(input: AccountsInput): Maps {
    const { registry, home, stateDir, nowMs, env } = input;
    const store = cursorAuthStore(stateDir, env);
    const nowSec = Math.floor(nowMs / 1000);

    const files: string[] = [];
    const claude: { name: string; cfg: string; cred: boolean }[] = [];
    const curtok = new Map<string, string>();
    const curdays = new Map<string, number>();
    const ceml = new Map<string, string>();

    for (const row of registry) {
        const name = row?.name === undefined || row?.name === null ? '' : String(row.name);
        if (name === '') continue;
        const harness = String(alt(row?.harness, 'claude'));
        if (harness === 'cursor') {
            const entry = cursorAuthRead(store, name);
            const token = typeof entry?.token === 'string' && entry.token !== '' ? entry.token : '';
            if (token !== '') {
                curtok.set(name, cursorTokenState(token, nowSec, env));
                const days = cursorTokenDaysLeft(token, nowSec);
                if (days !== undefined) curdays.set(name, days);
                const mail = entry?.email;
                if (typeof mail === 'string' && mail !== '') ceml.set(name, mail.toLowerCase());
            } else {
                curtok.set(name, 'missing');
            }
            continue;
        }
        const dir = String(alt(row?.configDir, 'default'));
        let cfg = accountConfigFile(dir, home);
        const cred = existsSync(`${accountDataDir(dir, home)}/.credentials.json`);
        if (existsSync(cfg)) files.push(cfg);
        else cfg = '';
        claude.push({ name, cfg, cred });
    }

    // Every .claude.json the registry points at, read once. Two rows pointing
    // at one directory name the same file twice; the map keys on the path, so
    // the second reading simply lands on the same key.
    const docs = readConfigs(files);

    const usg = new Map<string, UsageBlock>();
    const lim = new Map<string, LimitRow[]>();
    const lgn = new Map<string, boolean>();
    const onb = new Map<string, boolean>();
    const eml = new Map<string, string>();
    for (const a of claude) {
        const doc: ConfigDoc = a.cfg === '' ? null : (docs[a.cfg] ?? null);
        let usage: UsageBlock | null = null;
        try {
            usage = accountUsage(doc, nowMs);
        } catch {
            usage = null;
        }
        if (usage !== null) usg.set(a.name, usage);
        let limits: LimitRow[] = [];
        try {
            limits = accountLimits(doc);
        } catch {
            limits = [];
        }
        if (limits.length > 0) lim.set(a.name, limits);
        // loggedIn is a .credentials.json OR an oauthAccount key, by PRESENCE,
        // never by value. onboarded is hasCompletedOnboarding === true, and a
        // credentials file does not imply it.
        if (a.cred || (doc !== null && Object.prototype.hasOwnProperty.call(doc, 'oauthAccount'))) lgn.set(a.name, true);
        if (doc !== null && doc.hasCompletedOnboarding === true) onb.set(a.name, true);
        // TWO ADDRESS MAPS, NOT ONE (DROVE-338): a Claude account and a cursor
        // account may share a name, and one merged map keyed by name would hand
        // the Claude row the cursor address or the other way round — which is
        // how the cursor row clayrisser@gmail.com read as "same login as" a
        // Claude account.
        let mail = '';
        if (doc !== null) {
            const oauth = doc.oauthAccount;
            if (oauth !== null && typeof oauth === 'object') {
                const v = (oauth as Record<string, unknown>).emailAddress;
                if (v !== undefined && v !== null) mail = String(v).toLowerCase();
            }
        }
        if (mail !== '') eml.set(a.name, mail);
    }
    return { usg, lim, lgn, onb, eml, ceml, curtok, curdays };
}

/** The merge: one report row per registry row, in registry order. */
export function buildReport(input: AccountsInput): AccountReport[] {
    const { registry, ledger, home, nowMs, env } = input;
    const m = readAccounts(input);
    const t = nowMs;

    // CLAUDE_CONFIG_DIR is read RAW — empty when unset. It used to be defaulted
    // to $HOME/.claude, which made the ambient test unreachable: with the
    // variable unset (the normal case, and the one that MEANS "you are on your
    // main account") nothing was marked current, so the `*` column never
    // appeared at all.
    const cfgRaw = env.CLAUDE_CONFIG_DIR ?? '';
    const cfgn = cfgRaw.replace(/^~\//, `${home}/`).replace(/\/$/, '');
    const cfgAmbient = ['', 'default', 'ambient', '~'].includes(cfgn.toLowerCase()) || cfgn === `${home}/.claude`;
    const cur = env.DROVER_ACCOUNT ?? '';
    const curh = env.DROVER_HARNESS || 'claude';

    const out: AccountReport[] = [];
    for (const row of registry) {
        const me = row?.name === undefined || row?.name === null ? '' : String(row.name);
        const harness = String(alt(row?.harness, 'claude'));
        const raw = String(alt(row?.configDir, 'default'));
        const spelling = raw.toLowerCase();
        // A CURSOR ROW IS NEVER THE AMBIENT ACCOUNT (DROVE-256). It carries no
        // configDir at all, and the `.configDir // "default"` idiom every
        // reader here uses would otherwise resolve it to ~/.claude — so a
        // cursor account would read as Clay's main Claude login. The harness is
        // what keeps the two apart, and it is tested before the spelling.
        const ambient = harness === 'claude'
            && (['default', 'ambient', '~', ''].includes(spelling) || raw === '~/.claude' || raw === `${home}/.claude`);
        const dir = harness !== 'claude' ? null : (ambient ? `${home}/.claude` : raw.replace(/^~\//, `${home}/`));
        const tok = m.curtok.get(me) ?? 'missing';
        const tokdays = m.curdays.has(me) ? m.curdays.get(me)! : null;

        // TWINS (DROVE-21): every other row logged in as the same address. The
        // first of a login in registry order is the name the others are said to
        // duplicate, so risserproperties is "same login as main" and never the
        // reverse. A quota is the login's, not the name's, so a twin's usage
        // rows and ledger entry are read as this row's own below.
        //
        // WITHIN ONE HARNESS (DROVE-338). A Claude login and a Cursor login
        // under the same address are two subscriptions with two quotas, not
        // twins: the address is the identity inside a harness, and only there.
        const addr = (n: string): string | undefined => (harness === 'cursor' ? m.ceml.get(n) : m.eml.get(n));
        const mail = addr(me) ?? null;
        const kin = registry
            .filter((r) => String(alt(r?.harness, 'claude')) === harness)
            .map((r) => (r?.name === undefined || r?.name === null ? '' : String(r.name)));
        const twins = mail === null ? [] : kin.filter((n) => n !== me && (addr(n) ?? null) === mail);
        const firstOfLogin = mail === null ? null : (kin.find((n) => (addr(n) ?? null) === mail) ?? null);
        const sameAs = firstOfLogin === null || firstOfLogin === me ? null : firstOfLogin;

        const c = ledger[me] ?? null;
        const cool = c !== null && typeof c.until === 'number' && c.until > t ? c : null;
        const u = m.usg.get(me) ?? null;

        // The two sources, reduced to the same three fields so the merge can
        // treat them alike. USAGE FIRST and the ledger second, because the sort
        // is stable and `last` therefore keeps the old tie-break: with both
        // sources naming the same instant, the ledger is the one quoted. A
        // twin's sources follow, each saying which name saw it.
        const srcs: UsageBlock[] = [];
        if (u !== null) srcs.push({ until: u.until, reason: u.reason, family: u.family });
        if (cool !== null) {
            srcs.push({ until: cool.until as number, reason: String(alt(cool.reason, '')), family: ledgerFamily(cool) });
        }
        for (const tw of twins) {
            const via = ` (seen on ${tw}, the same login)`;
            const tu = m.usg.get(tw) ?? null;
            const tc = ledger[tw] ?? null;
            const tcool = tc !== null && typeof tc.until === 'number' && tc.until > t ? tc : null;
            if (tu !== null) srcs.push({ until: tu.until, reason: tu.reason + via, family: tu.family });
            if (tcool !== null) {
                srcs.push({
                    until: tcool.until as number,
                    reason: String(alt(tcool.reason, '')) + via,
                    family: ledgerFamily(tcool),
                });
            }
        }
        const until = srcs.length === 0 ? 0 : Math.max(...srcs.map((s) => s.until));
        // Blame an ACCOUNT-WIDE source when there is one, and only then fall
        // back to the latest. Same preference readUsageExhaustion makes between
        // rows, now made between sources too: a scoped reason under a state
        // that says everything is out is the contradiction this whole change is
        // about. One sentence says switch models, the other says wait.
        const wideSrcs = stableSortByUntil(srcs.filter((s) => s.family === null));
        const allSrcs = stableSortByUntil(srcs);
        const blame = wideSrcs.length > 0
            ? wideSrcs[wideSrcs.length - 1]
            : (allSrcs.length > 0 ? allSrcs[allSrcs.length - 1] : null);
        const why = blame === null ? '' : blame.reason;
        // WHICH model is out, or null for "all of them". Both sources have to
        // agree on one family before this names it: a source blocking
        // everything, or two of them naming different families, leaves it null
        // and the row says plain "cooling" — the same conservative default the
        // picker uses when it does not know what model the session is running.
        const family = srcs.length === 0 || srcs.some((s) => s.family === null) ? null : soleFamily(srcs);
        // A twin's rows are this account's rows: the fresher of two caches for
        // one quota is the one that knows, and taking both is how the fullest
        // limit wins here exactly as it does for the state above.
        const lrows = [...(m.lim.get(me) ?? []), ...twins.flatMap((tw) => m.lim.get(tw) ?? [])];

        const loggedIn = m.lgn.get(me) ?? false;
        const onboarded = m.onb.get(me) ?? false;
        const report: AccountReport = {
            name: row?.name,
            // WHICH HARNESS THIS ACCOUNT IS FOR (DROVE-256). Absent means
            // claude, so every registry Clay already has keeps reading as it did.
            harness,
            configDir: dir,
            ambient,
            loggedIn,
            // ONBOARDED and VERIFIED (DROVE-246). `loggedIn` was being read all
            // over as "a flip can land here" and it never meant that: it is the
            // presence of a credential and nothing more. Kept as three fields
            // rather than collapsed to one, because the two failures need
            // different sentences — "no login" is fixed by logging in, "never
            // run" by `drover trust`.
            onboarded,
            verified: loggedIn && onboarded,
            // The address this row is logged in as, and the row it duplicates
            // when another row holds the same address (DROVE-21).
            login: mail,
            sameLoginAs: sameAs,
            // ORDER, not just verdict (BASED-117). NULL when the cache says
            // nothing at all: null is not zero and it is not a hundred, and an
            // account nobody has measured has no place in a ranking by measured
            // headroom. drover-flip-policy sorts nulls after every known number.
            headroom: lrows.length === 0
                ? null
                : Math.min(100, Math.max(0, 100 - Math.max(...lrows.map((r) => r.percent)))),
            // Every limit row, so a caller that knows which MODEL it wants can
            // work out family-aware headroom.
            limits: lrows,
            // The LEDGER entry, raw, beside the coarse fields it feeds. `state`
            // and `family` above are deliberately lossy; a caller that HAS a
            // model in hand works out its own verdict from these.
            ledger: cool === null
                ? null
                : { until: cool.until as number, reason: String(alt(cool.reason, '')), family: ledgerFamily(cool) },
            // DROVER_ACCOUNT WINS OUTRIGHT when it is set, rather than being
            // OR-ed with the config-dir guess. It was an `or`, and in the normal
            // wrapped case — DROVER_ACCOUNT set, CLAUDE_CONFIG_DIR unset because
            // the ambient account needs it unset — BOTH came back current, so
            // the table showed two stars and neither meant anything.
            //
            // AND THE HARNESS HAS TO AGREE (DROVE-338), or a name two rows share
            // would star both.
            current: cur !== ''
                ? (row?.name === cur && harness === curh)
                : (ambient ? cfgAmbient : (!cfgAmbient && dir === cfgn)),
            // `state` stays the COARSE field, and stays conservative: a
            // Fable-only limit is still "cooling" here, because a consumer with
            // no model in hand must keep treating it as blocking. What is out is
            // in `family`, and the STATE column says it out loud.
            state: until > t ? 'cooling' : 'ready',
            until: until > t ? until : null,
            family: until > t ? family : null,
            reason: until > t ? why : null,
        };

        // THE CURSOR OVERRIDE (DROVE-256), applied after the fact rather than
        // threaded through every field above, so the Claude path reads exactly
        // as it did and there is one place to look for what a cursor row means.
        //
        // UNMEASURED, NEVER A HEALTHY 100%. Cursor publishes no quota anywhere,
        // so headroom is null and limits is empty — the same "nobody has
        // measured this" an unread Claude account already produces. The reason
        // line says so out loud so the dash is explained rather than looking
        // like a bug.
        //
        // ONBOARDED is true because there is no wizard to settle: the first-run
        // theme picker is a Claude Code thing and cursor-agent has no
        // equivalent. Saying false would make every cursor row advise `drover
        // trust`, which would do nothing at all.
        //
        // VERIFIED is the token being usable. An unreadable token counts as
        // usable on purpose: cursor could change its token format, and refusing
        // every session over a parse failure would be a worse outage than
        // trying and being told no.
        if (harness === 'cursor') {
            report.loggedIn = tok !== 'missing';
            report.onboarded = true;
            report.verified = tok === 'live' || tok === 'renew' || tok === 'unreadable';
            report.headroom = null;
            report.limits = [];
            report.ledger = null;
            report.until = null;
            report.family = null;
            // `renew` IS READY. The token works; it simply has a deadline, and
            // the deadline needs a human at a browser because there is no
            // refresh flow. Reporting it as anything but ready would park work
            // that can run perfectly well today.
            report.state = tok === 'missing'
                ? 'no login'
                : tok === 'tombstone'
                    ? 'signed out'
                    : (tok === 'expired' || tok === 'expiring')
                        ? 'expired'
                        : tok === 'renew' ? 'renew' : 'ready';
            report.reason = tok === 'missing'
                ? `no cursor token stored. Fix: drover account login --harness cursor ${me}`
                // A TOMBSTONE IS NOT A LAPSE. What is stored is the stub
                // cursor-agent leaves when an account is signed out, so
                // "expired" would blame the calendar for something that
                // happened to the account.
                : tok === 'tombstone'
                    ? `signed out of Cursor — what is stored is a signed-out marker, not a token. Fix: drover account login --harness cursor ${me}`
                    : (tok === 'expired' || tok === 'expiring')
                        ? `the cursor login has expired and cannot be renewed. Fix: drover account login --harness cursor ${me}`
                        // SAID WHILE IT STILL WORKS, which is the only useful
                        // time to say it: a cursor token cannot be refreshed, so
                        // the repair needs Clay at a browser and a warning that
                        // arrives after it dies has arrived too late.
                        : tok === 'renew'
                            ? `this cursor login expires in ${String(tokdays ?? 0)} day(s) and cannot be renewed automatically. Fix before it dies: drover account login --harness cursor ${me}`
                            : 'cursor publishes no quota, so headroom is unmeasured';
            // jq's `+` appends a key the left object does not have, so this one
            // lands LAST. Key order is part of the `--json` contract.
            report.expiresInDays = tokdays;
        }
        out.push(report);
    }
    return out;
}

/**
 * ORPHANS — config dirs holding a login no registry row points at (DROVE-251).
 *
 * COMPUTED ABOVE BOTH OUTPUT PATHS, because it used to be computed at the very
 * bottom and only for the table. `--json` carried no orphans at all, so the
 * phone, the bridge and the flip policy could not see what the terminal could
 * — and an orphan visible on exactly one surface is most of the way back to
 * being invisible, which is the actual bug. The disk space never was.
 */
export function buildOrphans(input: AccountsInput): OrphanReport[] {
    const { registry, home } = input;
    const m = readAccounts(input);
    const out: OrphanReport[] = [];
    for (const cand of accountOrphans(registry, home)) {
        const mail = cand.email.toLowerCase();
        // Resolved against the CLAUDE address map, so it names the REGISTERED
        // row this orphan shares a login with. Present means the dir is a
        // duplicate a retried login minted. Absent means no row holds that
        // address at all, so the login is good and the registry is what lost
        // the row. Those two want opposite answers.
        let row: string | null = null;
        if (mail !== '') {
            for (const [name, value] of m.eml) {
                if (value === mail) {
                    row = name;
                    break;
                }
            }
        }
        // The registered row is NAMED for its address, so "same login as
        // tekpioneer.us@gmail.com" alone reads as a tautology beside an orphan
        // showing that same address. The DIR is the half that differs and the
        // half Clay compares, so it is carried too.
        //
        // Tilde-spelled whatever the registry holds: a row written by a
        // nameless add carries "~/.claude-accounts/account-5" and one added by
        // hand carries the absolute path, and showing both spellings in one
        // report reads as two different places.
        let sameLoginDir: string | null = null;
        if (row !== null) {
            const hit = registry.find((r) => r?.name === row && String(alt(r?.harness, 'claude')) === 'claude');
            const spelled = String(alt(hit?.configDir, 'default'));
            sameLoginDir = spelled.startsWith(`${home}/`) ? `~/${spelled.slice(home.length + 1)}` : spelled;
        }
        out.push({
            dir: cand.spelled,
            email: mail === '' ? null : mail,
            sameLoginAs: row,
            sameLoginDir,
        });
    }
    return out;
}

/**
 * One rendering, used by `--orphans`, by `drover doctor` through it, and by
 * the table footer — so the three cannot drift into saying different things
 * about the same directory.
 */
export function orphanLines(o: OrphanReport): string[] {
    const lines = [`  ${`${o.dir}                              `.slice(0, 36)}${o.email ?? '(no address on file)'}`];
    if (o.sameLoginAs === null) {
        lines.push('      no registry row holds this address — the registry lost the row,');
        lines.push('      not the login. Adopt it rather than purging it.');
    } else {
        lines.push(`      duplicate: ${o.sameLoginAs} is registered at ${o.sameLoginDir}`);
        lines.push('      and is the same login, so nothing is lost by purging this one.');
    }
    return lines;
}

// --- the table ----------------------------------------------------------------

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function two(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/**
 * A reset more than a day out gets its weekday. "back 21:00 (8394m)" for a
 * weekly limit clearing on Wednesday reads as tonight — Clay saw exactly that
 * and had no way to tell a 5-hour park from a 6-day one.
 *
 * strflocaltime, so LOCAL time, and jq's `%` truncates its operands, which is
 * why the hour and minute remainders are taken on the whole-second value.
 */
export function clock(ms: number, nowMs: number): string {
    const s = ms / 1000;
    const d = s - nowMs / 1000;
    const when = new Date(ms);
    const at = d >= 86400
        ? `${weekdays[when.getDay()]} ${two(when.getHours())}:${two(when.getMinutes())}`
        : `${two(when.getHours())}:${two(when.getMinutes())}`;
    const di = Math.trunc(d);
    const left = d >= 86400
        ? `${Math.floor(d / 86400)}d ${Math.floor((di % 86400) / 3600)}h`
        : d >= 3600
            ? `${Math.floor(d / 3600)}h ${Math.floor((di % 3600) / 60)}m`
            : `${Math.floor(d / 60)}m`;
    return `cooling · back ${at} (${left})`;
}

/** jq counts codepoints, and `…` is one. */
function len(s: string): number {
    return Array.from(s).length;
}

function pad(s: string, n: number): string {
    const gap = n - len(s);
    return gap > 0 ? s + ' '.repeat(gap) : s;
}

function tail(s: string, n: number): string {
    const cp = Array.from(s);
    return cp.length > n ? `…${cp.slice(cp.length - n + 1).join('')}` : s;
}

function cap(s: string): string {
    return s.length === 0 ? s : s.slice(0, 1).toUpperCase() + s.slice(1);
}

/**
 * The table, whole lines at a time.
 *
 * The row this replaces was `printf '%s %-10s %-26s %s'` fed through a
 * tab-delimited `read` loop, and it broke twice over. `risserproperties` is 16
 * characters in a 10-wide column and `bitspur.com` is 11, so both shoved the
 * state and config-dir columns right and the table stopped being a table. And
 * `read` with IFS=tab collapses RUNS of tabs, so the empty-reason case needed a
 * "-" placeholder to stop the config dir being printed as the limit message.
 *
 * The continuation lines are indented to the start of the STATE column,
 * computed rather than the hardcoded 13 spaces that stopped lining up the
 * moment an account name went over 10 characters.
 */
export function renderTable(rows: AccountReport[], width: number, home: string, nowMs: number): string[] {
    const drawn = rows.map((r) => {
        const mark = r.current ? '*' : ' ';
        // "ready" stays in the string for a never-logged-in account rather than
        // being replaced: it IS ready in the ledger sense, and the JSON `state`
        // field says so too. What it is not is somewhere a flip can land, and
        // that has to be on the row, not only in a footnote.
        //
        // A model in front of "cooling" is the whole second half of this fix.
        // "main cooling · back Thu 21:00 (5d 17h)" over a reason line naming
        // Fable read as a five-day lockout, on a machine where the picker would
        // have handed main an Opus session that minute.
        const label = r.harness === 'cursor'
            // A cursor row has no cooldown and no quota, so the only three
            // things its STATE can say are: there is no token, the token is
            // dead, or work can go here. "unmeasured" is on the ready row
            // deliberately — it is the honest reading of an account with no
            // published headroom, and the reason line under it says why.
            ? (r.state === 'no login'
                ? 'no login'
                : r.state === 'signed out'
                    ? 'signed out'
                    : r.state === 'expired'
                        ? 'login expired'
                        // The COUNT is the whole point. "renew soon" is a shrug;
                        // "renew in 3d" is a thing he can put in a day.
                        : r.state === 'renew'
                            ? `renew in ${String(r.expiresInDays ?? 0)}d`
                            : 'ready · unmeasured')
            : r.state === 'cooling'
                ? `${r.family !== null ? `${cap(r.family)} ` : ''}${clock(r.until as number, nowMs)}`
                : !r.loggedIn
                    ? 'ready · no login'
                    // A logged-in account that has never been through the first
                    // run reads as ready everywhere and is not. Its own word,
                    // not folded into "no login": the login is fine and the fix
                    // is a different command (DROVE-246).
                    : !r.onboarded ? 'ready · never run' : 'ready';
        // Short on purpose. The old spelling was "default (~/.claude,
        // CLAUDE_CONFIG_DIR unset)", which is 43 characters and gets
        // left-truncated to "…, CLAUDE_CONFIG_DIR unset)" on an 80-column
        // terminal — losing the half that says WHERE.
        const dir = r.harness === 'cursor'
            ? 'cursor (token, no config dir)'
            : r.ambient
                ? '~/.claude (default)'
                : (r.configDir !== null && r.configDir === home
                    ? '~'
                    : r.configDir !== null && r.configDir.startsWith(`${home}/`)
                        ? `~${r.configDir.slice(home.length)}`
                        : String(r.configDir));
        return { r, mark, label, dir };
    });

    const wn = Math.max(len('ACCOUNT'), ...drawn.map((d) => len(String(d.r.name))));
    const ws = Math.max(len('STATE'), ...drawn.map((d) => len(d.label)));
    const wd = Math.max(20, width - 2 - wn - 1 - ws - 1);
    const indent = 2 + wn + 1;
    const sp = (n: number): string => (n > 0 ? ' '.repeat(n) : '');

    const out: string[] = [`  ${pad('ACCOUNT', wn)} ${pad('STATE', ws)} CONFIG DIR`];
    for (const d of drawn) {
        out.push(`${d.mark} ${pad(String(d.r.name), wn)} ${pad(d.label, ws)} ${tail(d.dir, wd)}`.replace(/ +$/, ''));
        if ((d.r.reason ?? '') !== '') out.push(sp(indent) + d.r.reason);
        if ((d.r.sameLoginAs ?? '') !== '') {
            out.push(`${sp(indent)}same login as ${d.r.sameLoginAs} — one quota, shared with it`);
        }
        if (!(d.r.loggedIn || d.r.harness === 'cursor')) {
            out.push(`${sp(indent)}no login — a flip cannot land here. Fix: drover account add ${String(d.r.name)}`);
        }
        if (d.r.loggedIn && !d.r.onboarded && d.r.harness !== 'cursor') {
            out.push(`${sp(indent)}logged in, but never run — a session here opens the first-run`);
            out.push(`${sp(indent)}wizard, which a flip cannot answer. Fix: drover trust`);
        }
    }
    if (drawn.some((d) => d.r.family !== null)) {
        out.push('');
        out.push('  a model in STATE means only THAT model is out; the account still runs the rest');
    }
    return out;
}

// --- the verb -----------------------------------------------------------------

/**
 * $STATE_DIR, the way etc/drover.env computes it.
 *
 * NOT droverEnv().stateDir, which still reads XDG_STATE_HOME — the env file
 * stopped consulting XDG at DROVE-309 ("it should all be in .drover") and
 * resolves through drover_home_path instead: the new path when it is there,
 * else the legacy one when THAT is there, else the new path. A machine is
 * never sent to an empty directory while its state sits in the other one. The
 * ledger this verb reads lives under it, so it has to agree with the shell.
 */
export function stateDir(env: NodeJS.ProcessEnv, h: string): string {
    if (env.STATE_DIR) return env.STATE_DIR;
    const droverHome = env.DROVER_HOME || `${h}/.drover`;
    const fresh = `${droverHome}/state`;
    if (existsSync(fresh)) return fresh;
    const legacy = `${h}/.local/state/cattle-drover`;
    if (existsSync(legacy)) return legacy;
    return fresh;
}

/** How wide we may be: a tty knows, a pipe does not, and 120 beats unbounded. */
function terminalWidth(env: NodeJS.ProcessEnv): number {
    let raw = env.DROVER_ACCOUNTS_WIDTH ?? '';
    if (raw === '' && process.stdout.isTTY) raw = String(process.stdout.columns ?? '');
    let width = raw === '' || raw.match(/[^0-9]/) ? 120 : Number(raw);
    if (width < 50) width = 50;
    return width;
}

export async function run(args: string[]): Promise<number> {
    let asJson = false;
    let onlyOrphans = false;
    for (const arg of args) {
        if (arg === '') continue;
        if (arg === '--json') {
            asJson = true;
        } else if (arg === '--orphans') {
            onlyOrphans = true;
        } else if (arg === '-h' || arg === '--help') {
            process.stdout.write(help);
            return 0;
        } else {
            process.stderr.write(`drover accounts: unknown argument '${arg}' (try --json, --orphans or --help)\n`);
            return 2;
        }
    }

    const env = process.env;
    const h = homeOf(env);
    const registryPath = env.DROVER_ACCOUNTS || join(droverEnv(env, h).droverDir, 'accounts.json');
    const state = stateDir(env, h);
    const ledgerPath = join(state, 'cooldowns.json');

    let registryText: string;
    try {
        registryText = readFileSync(registryPath, 'utf8');
    } catch {
        process.stderr.write(`drover accounts: no registry at ${registryPath}\n`);
        process.stderr.write('  copy accounts.example.json to accounts.json, or set DROVER_ACCOUNTS\n');
        return 1;
    }
    let registry: AccountRow[];
    try {
        const parsed: unknown = JSON.parse(registryText);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        registry = parsed as AccountRow[];
    } catch {
        // jq dies on a registry it cannot walk, and so does this. Saying "no
        // accounts" instead would report an empty estate to the phone.
        process.stderr.write(`drover accounts: ${registryPath} is not a JSON array of accounts\n`);
        return 5;
    }

    let ledgerText = '{}';
    try {
        ledgerText = readFileSync(ledgerPath, 'utf8').replace(/\n+$/, '');
    } catch {
        ledgerText = '{}';
    }
    let ledger: Record<string, LedgerEntry>;
    try {
        const parsed: unknown = JSON.parse(ledgerText);
        ledger = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            ? parsed as Record<string, LedgerEntry>
            : {};
    } catch {
        process.stderr.write(`drover accounts: the cooldown ledger at ${ledgerPath} is not valid JSON\n`);
        return 5;
    }

    const input: AccountsInput = { registry, ledger, home: h, stateDir: state, nowMs: Date.now(), env };
    const orphans = buildOrphans(input);

    if (onlyOrphans) {
        if (asJson) {
            process.stdout.write(`${jqJson(orphans)}\n`);
            return 0;
        }
        if (orphans.length === 0) {
            process.stdout.write('no orphans: every logged-in config dir has a registry row\n');
            return 0;
        }
        process.stdout.write('unregistered config dirs, logged in, that no account points at:\n');
        for (const o of orphans) process.stdout.write(`${orphanLines(o).join('\n')}\n`);
        process.stdout.write('  adopt one:   drover account add <name> --config-dir <dir>\n');
        process.stdout.write('  remove one:  drover account rm <name> --purge\n');
        process.stdout.write('  nothing here deletes a credential\n');
        return 0;
    }

    const rows = buildReport(input);
    if (asJson) {
        process.stdout.write(`${jqJson(rows)}\n`);
        return 0;
    }

    for (const line of renderTable(rows, terminalWidth(env), h, input.nowMs)) {
        process.stdout.write(`${line}\n`);
    }

    // The ledger is the flip's own memory, so say where it lives when it holds
    // something — a stale cooldown is otherwise invisible and unexplainable.
    if (ledgerText !== '{}' && ledgerText !== '') process.stdout.write(`\nledger: ${ledgerPath}\n`);

    // IT PRINTS AND STOPS THERE. Nothing in the drover removes a directory with
    // a credential in it, and this is not the place to start: an orphan may be
    // the better half of a pair, and the machine cannot tell which. The removal
    // is Clay's, and the two commands that do it are on the screen so he does
    // not have to go looking.
    if (orphans.length > 0) {
        process.stdout.write('\nunregistered config dirs, logged in, that no account points at:\n');
        for (const o of orphans) process.stdout.write(`${orphanLines(o).join('\n')}\n`);
        process.stdout.write('  adopt one:   drover account add <name> --config-dir <dir>\n');
        process.stdout.write('  remove one:  drover account rm <name> --purge\n');
        process.stdout.write('  nothing here deletes a credential\n');
    }
    return 0;
}

/** Unused here; `expandHome` is re-exported so the sibling verbs share one. */
export { expandHome };
