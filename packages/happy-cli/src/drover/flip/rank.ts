/**
 * THE ONE PICKER (DROVE-315 wave 2b, collapsing DROVE-4's split).
 *
 * There were two. `libexec/drover-flip-policy` ranked accounts by HEADROOM in
 * a jq program and decided what a session should do when it ran out; the
 * fork's `pickTarget` walked the registry in ORDER and took the first account
 * not cooling. They agreed about what "blocked" means and disagreed about
 * everything else, and only one of them ever saw a real usage limit — the
 * fork's, because a real limit is detected in `controller.ts` and never
 * reaches a shell script. So the policy Clay owns was written down in a file
 * nothing called on the path that mattered.
 *
 * This is that file, in node, and it is now the only one. `rankAccounts` is
 * the ranking both callers share: `pickTarget` orders its candidates with it
 * and reads its back-door flag, and `drover flip-policy` renders it and
 * decides on top of it. Two orderings for one question is the same class of
 * bug as a table that contradicts the picker.
 *
 * PORTED SENTENCE FOR SENTENCE from the jq `rank_program`, `best`, `best_any`,
 * `is_backdoor`, `pass` and `decide` in libexec/drover-flip-policy. Where the
 * shell read `drover accounts --json`, this reads the same facts out of the
 * registry, the cooldown ledger and each account's usage cache through
 * accounts.ts — one parser, not two, which is the other half of "one picker".
 *
 * HEADROOM IS A PERCENTAGE HERE, and a timestamp in `coolingUntil`. Both are
 * right for their question. `coolingUntil` asks "is this account blocked, and
 * until when"; Clay's ask is an ORDER — "most to least" — and an order needs a
 * gradient, which is `100 - the fullest limit that applies`. The two never
 * contradict: an account this calls blocked is exactly one `coolingUntil`
 * calls cooling, because both read `percent >= 100 with the reset still ahead`
 * and nothing else ever rules an account IN.
 */

import {
    cooldownFamily,
    coolingState,
    isBackdoorAccount,
    isClaudeAccount,
    isLoggedIn,
    isOnboarded,
    loginEmail,
    loginTwins,
    readAccounts,
    readLedger,
    readUsageCache,
    whenBack,
    type Cooldown,
    type DroverAccount,
    type Ledger,
    type UsageLimitRow,
} from './accounts'
import { familyOfDisplayName } from './limits'

// --- the facts a row is built from -------------------------------------------

/**
 * One limit row reduced to the three fields the ranking asks about, exactly as
 * `account_limits` in libexec/drover-accounts reduces it.
 *
 * `family` is null when the row stops EVERY model, and that is three cases,
 * not one: a surface scope (never observed, so read conservatively), no model
 * scope at all, and a display name that reduces to no family we know. An
 * unreadable scope must never make a dead account look alive.
 */
export interface RankLimit {
    percent: number
    /** Epoch ms the row resets, or null when it carries no parseable one. */
    until: number | null
    kind: string
    family: string | null
}

/**
 * Epoch ms from a `resets_at`, TRUNCATED TO THE SECOND.
 *
 * jq's `epoch_ms` strips the microseconds before `fromdateiso8601`, so the
 * shell has always compared whole seconds. `Date.parse` keeps the fraction, and
 * a row resetting 400µs from now would land on different sides of the `> now`
 * cut in the two implementations. Truncating here is what makes the port exact
 * rather than nearly exact.
 */
export function limitEpochMs(resetsAt: unknown): number | null {
    if (typeof resetsAt !== 'string' || !resetsAt) return null
    const parsed = Date.parse(resetsAt)
    if (!Number.isFinite(parsed)) return null
    return Math.floor(parsed / 1000) * 1000
}

/** The family a limit row is scoped to, or null for "this stops everything". */
export function limitFamily(row: UsageLimitRow): string | null {
    const scope = row?.scope
    if (!scope) return null
    if (scope.surface != null) return null
    if (scope.model == null) return null
    return familyOfDisplayName(scope.model.display_name) ?? null
}

/**
 * Every limit row this account is judged on: its own, plus every login twin's.
 *
 * A twin's rows ARE this account's rows (DROVE-21) — the fresher of two caches
 * for one quota is the one that knows — which is the union
 * `($lim[$me] // []) + [ $twins[] ... ]` that `drover accounts --json` builds
 * before the ranking ever sees a row.
 */
export function limitsOf(a: DroverAccount, accounts: DroverAccount[]): RankLimit[] {
    const own = rowsOf(a)
    const twins = loginTwins(a, accounts)
    for (const twin of twins) own.push(...rowsOf(twin))
    return own
}

function rowsOf(a: DroverAccount): RankLimit[] {
    if (!isClaudeAccount(a)) return []
    const cache = readUsageCache(a)
    if (!cache) return []
    const out: RankLimit[] = []
    for (const row of cache.rows) {
        // `select((.percent // null) != null)`: a row with no percent is not a
        // measurement, and a missing number must not read as zero.
        if (row?.percent == null) continue
        const percent = typeof row.percent === 'number' ? row.percent : 0
        out.push({
            percent,
            until: limitEpochMs(row.resets_at),
            kind: typeof row.kind === 'string' && row.kind ? row.kind : 'usage',
            family: limitFamily(row),
        })
    }
    return out
}

/** The live cooldown entry for one account, or null. Own row only, as the shell's is. */
function ledgerEntryOf(a: DroverAccount, ledger: Ledger, now: number): { until: number; reason: string; family: string | null } | null {
    const c: Cooldown | undefined = ledger[a.name]
    if (!c || !(c.until > now)) return null
    return { until: c.until, reason: c.reason ?? '', family: cooldownFamily(c) ?? null }
}

// --- a ranked row -------------------------------------------------------------

export interface RankedAccount {
    name: string
    /** Registry position, which is Clay's own preference order and the tie-break. */
    idx: number
    loggedIn: boolean
    onboarded: boolean
    blocked: boolean
    /**
     * The only field a caller has to read to know whether a flip CAN land here.
     * Never-logged-in and never-run are both false however much headroom they
     * have: the flip lands in Claude Code's first-run wizard, which a wrapped
     * session cannot answer, so it reads as the flip doing nothing at all.
     */
    eligible: boolean
    excluded: boolean
    twinOfHere: boolean
    /**
     * THE BACK DOOR, and it is NOT subtracted from `eligible` (DROVE-333).
     * Eligible means "a flip can land here", and one still can — by hand, which
     * is the entire point of a back door. What the rule takes away is the
     * AUTOMATIC path: `best` picks the top row that is eligible and not
     * backdoor, and only `bestAny` reads these.
     */
    backdoor: boolean
    /** Which of the two made it one: the ambient row itself, or a row on its login. */
    ambient: boolean
    headroom: number | null
    /** Which family did the blocking, or null when the witnesses disagree. */
    family: string | null
    until: number | null
    state: string
    reason: string | null
    bucket: number
    rank: number
    /** The ordering key, rendered once so every surface prints the same words. */
    key: string
}

export interface RankOptions {
    /** The model family the session is running. Empty means UNKNOWN, which is conservative. */
    family?: string
    /** The account the session is on now, so it is not offered itself. */
    exclude?: string
    now?: number
    accounts?: DroverAccount[]
    ledger?: Ledger
}

/** "fable" -> "Fable ", for the key. Empty when nothing is named. */
function familyPrefix(family: string | null): string {
    if (!family) return ''
    return family.charAt(0).toUpperCase() + family.slice(1) + ' '
}

/**
 * Every account ordered by headroom, most to least, with the ordering key on
 * each row. THIS IS THE ORDER, and there is only one of it: the tmux picker,
 * the limit prompt, `drover flip-policy rank` and `pickTarget` all read it.
 *
 * CURSOR ACCOUNTS ARE NOT FLIP TARGETS (DROVE-256). A flip is a
 * CLAUDE_CONFIG_DIR swap and a respawn, and a cursor row has no config dir to
 * swap to. It also has no measurable headroom, so left in it would enter as
 * "headroom unmeasured" — the eligible-but-unknown bucket — which is exactly
 * the wrong answer: it is not unknown whether work can go there, it is known
 * that it cannot. Dropped before the ranking, so it never appears in a picker.
 */
export function rankAccounts(opts: RankOptions = {}): RankedAccount[] {
    const all = (opts.accounts ?? readAccounts()).filter(isClaudeAccount)
    const ledger = opts.ledger ?? readLedger()
    // Whole seconds, because the shell passed `$(date +%s)000` and every
    // `until > now` comparison below has always been made at that granularity.
    const now = Math.floor((opts.now ?? Date.now()) / 1000) * 1000
    const demand = (opts.family ?? '').toLowerCase() || null
    const exclude = opts.exclude ?? ''

    // The login the session is on, so a TWIN of the current account — the same
    // claude.ai login under another name (DROVE-21) — is no more a target than
    // the account itself: it would relaunch the session onto the same quota.
    const here = all.find((a) => a.name === exclude)
    const exLogin = here ? (loginEmail(here) ?? null) : null

    // THE BACK DOOR (DROVE-333), by the AMBIENT config dir and never by the
    // name. `main` is whatever row sits on ~/.claude; naming it by string would
    // break the day Clay renames the row, and would fire on somebody else's
    // account that happens to be called main. Its twins are in for the same
    // reason the current account's are: a login is what a quota and a back door
    // both are.
    const rows: RankedAccount[] = all.map((a, idx) => {
        const login = loginEmail(a) ?? null
        const twinOfHere = exLogin !== null && login === exLogin && a.name !== exclude
        const backdoor = isBackdoorAccount(a, all)
        const limits = limitsOf(a, all)
        // Which of an account's limit rows apply to what this session is
        // running. A row scoped to no model (or to a scope we could not read)
        // blocks everything. With the family UNKNOWN every row applies — the
        // same conservative reading `modelDemand` makes, because a session
        // whose model we cannot name must not be sent somewhere it cannot run.
        const mine = limits.filter((r) => demand === null || r.family === null || r.family === demand)
        const led = ledgerEntryOf(a, ledger, now)

        // BLOCKED has two witnesses and either is enough. The usage cache: a
        // limit that APPLIES to this family, at 100%, whose reset is still
        // ahead. The ledger, which is what a drover session WATCHED happen.
        const cappedRows = mine.filter((r) => r.percent >= 100 && (r.until ?? 0) > now)
        const capped = cappedRows.length > 0
        const cooled = led !== null && (led.family === null || demand === null || led.family === demand)
        const blocked = capped || cooled

        const headroom = mine.length === 0
            ? null
            : Math.min(100, Math.max(0, 100 - Math.max(...mine.map((r) => r.percent))))

        const backs = [
            ...cappedRows.map((r) => r.until).filter((u): u is number => u != null),
            ...(cooled && led ? [led.until] : []),
        ].filter((u) => u > now)
        const until = backs.length === 0 ? null : Math.min(...backs)

        // WHICH family did the blocking, for the row. Only when every blocking
        // witness names the same one; two different families blocking means the
        // honest word is none of them.
        const witnesses = [...cappedRows.map((r) => r.family), ...(cooled && led ? [led.family] : [])]
        const uniqueFamilies = [...new Set(witnesses)]
        const blockedFamily = uniqueFamilies.length === 1 ? uniqueFamilies[0] : null

        const loggedIn = isLoggedIn(a)
        const onboarded = isOnboarded(a)

        return {
            name: a.name,
            idx,
            loggedIn,
            onboarded,
            blocked,
            eligible: loggedIn && onboarded && !blocked && a.name !== exclude && !twinOfHere,
            excluded: a.name === exclude,
            twinOfHere,
            backdoor,
            ambient: a.ambient === true,
            headroom,
            family: blockedFamily,
            until,
            state: blocked ? 'cooling' : 'ready',
            reason: blocked ? blockedReason(a, ledger, now, led) : null,
            bucket: 0,
            rank: 0,
            key: '',
        }
    })

    // THE ORDER. Buckets first, then the gradient inside the first bucket.
    //   0  eligible with a measured headroom  -> most left first
    //   1  eligible, never measured           -> registry order, which is
    //                                            Clay's own preference order
    //                                            and the only honest tie-break
    //                                            for a number nobody has
    //   2  blocked                            -> soonest back first
    //   3  cannot start a session at all      -> last; no login, or logged in
    //                                            but never run, equally dead
    // The account the session is ALREADY on sorts with its bucket but is never
    // eligible, so it shows in the list (Clay can see its headroom) and cannot
    // be picked as a flip target.
    for (const r of rows) {
        r.bucket = !(r.loggedIn && r.onboarded) ? 3 : r.blocked ? 2 : r.headroom === null ? 1 : 0
    }
    const farFuture = 9007199254740991
    rows.sort((x, y) =>
        x.bucket - y.bucket ||
        (x.headroom === null ? 0 : -x.headroom) - (y.headroom === null ? 0 : -y.headroom) ||
        (x.until ?? farFuture) - (y.until ?? farFuture) ||
        x.idx - y.idx)

    rows.forEach((r, i) => {
        r.rank = i + 1
        r.key = renderKey(r, now)
    })
    return rows
}

/**
 * `$a.reason // ($led.reason // null)` -- the coarse sentence `drover accounts`
 * renders beside a cooling row, and the ledger's own sentence under it.
 *
 * coolingState merges the ledger, the usage cache and every twin's copy of
 * both, preferring an account-wide row for the blame, which is the same
 * preference libexec/drover-accounts makes between its sources.
 */
function blockedReason(a: DroverAccount, ledger: Ledger, now: number, led: { reason: string } | null): string | null {
    return coolingState(a, ledger, now).reason || led?.reason || null
}

function renderKey(r: RankedAccount, now: number): string {
    if (!r.loggedIn) return 'no login'
    if (!r.onboarded) return 'never run'
    if (r.blocked) {
        const pct = r.headroom === null ? '0%' : `${r.headroom}%`
        if (r.until === null) return pct
        return `${pct} · ${familyPrefix(r.family)}back ${whenBack(r.until, now)}`
    }
    if (r.headroom === null) return 'headroom unmeasured'
    return `${r.headroom}% left`
}

// --- who an automatic flip may land on ---------------------------------------

/**
 * best — the top row an AUTOMATIC flip may land on, or undefined.
 *
 * That is the top eligible row that is NOT the back door (DROVE-333). Every
 * automatic path goes through here: auto, the fallback rungs, the account the
 * prompt offers first, and `pickTarget`'s candidate order.
 */
export function best(rows: RankedAccount[]): RankedAccount | undefined {
    return rows.find((r) => r.eligible && !r.backdoor)
}

/**
 * bestAny — the top eligible row, back door included. THE LAST RESORT, and
 * nothing else. Clay's rule is "never auto-flip through the main account unless
 * literally every other account has expired", so this is read only once the
 * ordinary pass and every fallback rung have found nothing, and what it returns
 * is stamped `backdoorLastResort` and said out loud rather than flipped to
 * quietly.
 */
export function bestAny(rows: RankedAccount[]): RankedAccount | undefined {
    return rows.find((r) => r.eligible)
}

/**
 * Does that row sit on the back door?
 *
 * Read off the ranking rather than re-derived, so "the session is on main" and
 * "main is not an auto target" can never be answered from two different pieces
 * of code. An empty name, or a name the registry does not carry, is not the
 * back door: too permissive by one row is survivable, and refusing to flip a
 * session we cannot place is not.
 */
export function isBackdoorRow(rows: RankedAccount[], name: string): boolean {
    if (!name) return false
    return rows.find((r) => r.name === name)?.backdoor ?? false
}

/**
 * The ONE order `pickTarget` sorts its candidates into.
 *
 * `pickTarget` used to take the first account in REGISTRY order with headroom,
 * which is the whole of what BASED-117 objected to: "registry position is not
 * headroom, so the account it lands on can be the next one to run out." It now
 * hands its candidate rows here and gets them back in the ranking's order, so
 * the account a real usage limit flips to is the account the tmux picker puts
 * at the top of the list. A picker that disagrees with itself is worse than no
 * picker.
 */
export function orderByHeadroom<T extends { name: string }>(rows: T[], ranked: RankedAccount[]): T[] {
    const place = new Map(ranked.map((r, i) => [r.name, i]))
    return [...rows].sort((x, y) => (place.get(x.name) ?? Number.MAX_SAFE_INTEGER) - (place.get(y.name) ?? Number.MAX_SAFE_INTEGER))
}

// --- the decision -------------------------------------------------------------

export type DecisionAction = 'auto' | 'prompt' | 'fallback' | 'stop' | 'backdoor'

export interface Decision {
    action: DecisionAction
    account: string | null
    family: string | null
    fromFamily?: string
    from: string | null
    key?: string
    headroom?: number | null
    why: string
    backdoorLastResort?: true
    ranked: RankedAccount[]
}

export type OnLimitSetting = 'prompt' | 'auto'
export type OnFamilySetting = 'flip-then-downgrade' | 'flip-only' | 'downgrade-only' | 'nothing'

export interface DecideSettings {
    onLimit: OnLimitSetting
    /**
     * The four documented values, and the legacy `stop`/`fallback` the store
     * still accepts. Typed wide because the shell's pre-bus default is the
     * legacy `stop`, and a no-session decision has to answer exactly as the
     * shell answered rather than as a value it never held.
     */
    onFamilyExhausted: OnFamilySetting | string
    /** The fallback chain for the family in play, in order. */
    chain: string[]
}

/** Which candidate set the current pass may land on. */
type Picker = (rows: RankedAccount[]) => RankedAccount | undefined

/**
 * pass — one whole decision against ONE candidate set.
 *
 * This is `decide` as it was written for BASED-117, unchanged except that the
 * rows it may land on come from `pick`. It is called twice (DROVE-333): first
 * with the back door excluded, and only if that stops, again with it included.
 */
function pass(ranked: RankedAccount[], pick: Picker, o: RankOptions & { settings: DecideSettings }): Decision {
    const { settings } = o
    const family = (o.family ?? '').toLowerCase()
    const from = o.exclude ?? ''
    const top = pick(ranked)

    if (top) {
        return {
            action: settings.onLimit === 'auto' ? 'auto' : 'prompt',
            account: top.name,
            family: family || null,
            from: from || null,
            key: top.key,
            headroom: top.headroom,
            why: `${top.name} has the most headroom (${top.key})`,
            ranked,
        }
    }

    // Nothing has the family we asked for. THIS is the second policy: stop, or
    // fall back to another model.
    const policy = settings.onFamilyExhausted
    if (policy === 'flip-only' || policy === 'nothing' || !family) {
        // Family unknown means we cannot name a substitute either — a fallback
        // from "we do not know what you were running" is a guess, and a silent
        // guess about which model answered is the thing this ticket forbids.
        return {
            action: 'stop',
            account: null,
            family: family || null,
            from: from || null,
            why: family
                ? `no account has ${family}, and account switching is set to ${policy}, which does not change the model`
                : 'no account has headroom, and the model family is unknown so there is nothing to fall back from',
            ranked,
        }
    }

    // The chain, in order. The current account is NOT excluded here: falling
    // back is a change of MODEL, and staying where you are while changing model
    // is the cheapest correct answer — the same "prefer current" the fork's
    // second pass makes, and the same thing that stops a relaunch loop.
    for (const next of settings.chain) {
        const alt = rankAccounts({ ...o, family: next, exclude: '' })
        const altTop = pick(alt)
        if (!altTop) continue
        return {
            action: 'fallback',
            account: altTop.name,
            family: next,
            fromFamily: family,
            from: from || null,
            key: altTop.key,
            headroom: altTop.headroom,
            why: `${family} is exhausted everywhere; ${altTop.name} has ${next} (${altTop.key})`,
            ranked: alt,
        }
    }

    return {
        action: 'stop',
        account: null,
        family: family || null,
        from: from || null,
        why: `no account has ${family}, and nothing in the fallback chain (${settings.chain.join(' ') || 'empty'}) has headroom either`,
        ranked,
    }
}

/**
 * decide — the back door rule wrapped round pass() (DROVE-333).
 *
 * Two things, in this order, and the order is the rule:
 *
 *   1. ON the back door, nothing automatic happens AT ALL. Not a flip, not a
 *      downgrade, not a park with its beats. Clay switches to main by hand when
 *      he is stuck and logs in from there, and a session that flips itself off
 *      main — or parks on it and waits — takes the escape hatch away at exactly
 *      the moment he reached for it. So this returns before any policy is read.
 *   2. THROUGH the back door, only as a last resort. The ordinary pass cannot
 *      see main or its twins at all, so a session lands there only when the
 *      whole registry and every rung of the fallback chain came back empty. It
 *      says so when it does.
 */
export function decide(o: RankOptions & { settings: DecideSettings }): Decision {
    const ranked = rankAccounts(o)
    const from = o.exclude ?? ''
    const family = (o.family ?? '').toLowerCase()

    if (isBackdoorRow(ranked, from)) {
        const row = ranked.find((r) => r.name === from)
        const ambientName = ranked.find((r) => r.ambient)?.name ?? 'main'
        const which = row?.ambient
            ? ' is the back door account'
            : ` is the same claude.ai login as ${ambientName}, the back door account`
        return {
            action: 'backdoor',
            account: null,
            family: family || null,
            from,
            why: `${from}${which}, so auto-flip is off here: no flip, no park, no model downgrade. ` +
                'Move by hand — drover flip <account>, or Switch on the phone.',
            ranked,
        }
    }

    const first = pass(ranked, best, o)
    if (first.action !== 'stop') return first

    // `nothing` means change neither the account nor the model and wait for
    // Clay. A last-resort flip onto main is still a flip, so that setting ends
    // it here rather than being overridden by the escalation below.
    if (o.settings.onFamilyExhausted === 'nothing') return first

    const second = pass(ranked, bestAny, o)
    if (second.action === 'stop') {
        // The back door has no headroom either. Report the FIRST stop: both
        // sentences say the same thing and the first one is the one measured
        // over the set this policy normally uses.
        return first
    }
    return {
        ...second,
        backdoorLastResort: true,
        why: `${second.why} — and it is the BACK DOOR account, taken only because nothing else has ` +
            `${family || 'any headroom'} or anything under it`,
    }
}
