/**
 * The account registry and the cooldown ledger (BASED-98).
 *
 * The registry is the same accounts.json `drover account` reads — one
 * CLAUDE_CONFIG_DIR per Claude subscription. The ledger records which of them
 * are currently out of headroom and until when, so the flip has something
 * better than round-robin to pick with, and so an account that just said
 * "limit reached" is not the one we flip straight back onto.
 *
 * Both files are read fresh on every use. They are edited by hand and written
 * by other processes (several sessions flip independently), so anything
 * cached here would be a lie within the hour.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { logger } from '@/ui/logger'
import { familyOf, familyOfDisplayName, familyOfLimitText } from './limits'
import { projectDirFor } from './transcript'

/**
 * Whose headroom a question is about.
 *
 * A usage limit is not always an account-wide one. Measured 2026-08-29 on all
 * five of Clay's accounts: every maxed row was scoped to the Fable family
 * while main's own five_hour sat at 2% and weekly_all at 60% — Opus worked
 * there that minute, and `drover accounts` called it dead anyway. So "does
 * this account have headroom" needs a "for what".
 *
 *   `unknown` — we could not tell what model the session is running. EVERY
 *     maxed row blocks, scoped or not. This is what the code did before
 *     families existed and it must stay byte-for-byte that, because a wrong
 *     guess that parks a healthy session is far worse than no model awareness.
 *   `family`  — the session is on Fable (or Opus, …). Rows scoped to another
 *     family stop counting; unscoped rows still block everything.
 *   `any`     — is there ANY model left here? Only unscoped rows block. Used
 *     as the LAST look before parking, and only when the family is known, so
 *     the answer can name the model to switch to.
 */
export type ModelDemand =
    | { kind: 'unknown' }
    | { kind: 'family'; family: string }
    | { kind: 'any' }

export const unknownModel: ModelDemand = { kind: 'unknown' }
export const anyModel: ModelDemand = { kind: 'any' }

export function modelDemand(family: string | undefined): ModelDemand {
    return family ? { kind: 'family', family } : unknownModel
}

export interface DroverAccount {
    name: string
    /**
     * Where this account's transcripts live: `$configDir/projects/<munged-cwd>`.
     * Always a real path, even for the ambient account.
     */
    configDir: string
    /**
     * True when this account IS the default Claude Code config — the one you
     * get with CLAUDE_CONFIG_DIR unset — and therefore must be reached by
     * UNSETTING that variable rather than pointing it anywhere.
     *
     * This distinction is not pedantry, it is the difference between a flip
     * that works and one that lands in a login wizard. Measured in the 2.1.251
     * binary:
     *
     *     globalConfig = join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
     *     userSettings = join(CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), ...)
     *
     * So CLAUDE_CONFIG_DIR=~/.claude is NOT a no-op. It leaves settings where
     * they were but moves the GLOBAL config — which is where the OAuth account
     * and `hasCompletedOnboarding` live — from ~/.claude.json to
     * ~/.claude/.claude.json, an empty file. A registry entry saying
     * `{"name":"main","configDir":"~/.claude"}` therefore names a brand-new,
     * never-logged-in account that happens to share a settings file, and every
     * flip onto it dead-ends in Claude Code's first-run onboarding. Write
     * `"configDir": "default"` (or leave it out) to mean the real one.
     */
    ambient?: boolean
    /** Account-scoped override for what a resumed session is told on arrival. */
    flipPrompt?: string
}

/**
 * Registry spellings that mean "the default config, CLAUDE_CONFIG_DIR unset".
 *
 * `~/.claude` is in the list on purpose. Setting the variable to that path
 * yields an account sharing settings.json with the real one but holding its
 * own EMPTY global config — never logged in, never onboarded. Nobody wants
 * that account; everyone who writes that path means "my main one". So the
 * spelling is repaired rather than honoured, which fixes the registry every
 * install shipped with instead of requiring an edit.
 */
const ambientSpellings = new Set(['default', 'ambient', '~', ''])

export function isAmbientSpelling(configDir: unknown): boolean {
    if (configDir === undefined || configDir === null) return true
    if (typeof configDir !== 'string') return false
    const raw = configDir.trim()
    if (ambientSpellings.has(raw.toLowerCase())) return true
    return expandTilde(raw) === join(homedir(), '.claude')
}

/** The data dir the ambient account keeps its transcripts in. */
export function ambientDataDir(): string {
    return join(homedir(), '.claude')
}

export interface Cooldown {
    /** Epoch ms the account is expected to have headroom again. */
    until: number
    reason: string
    /** Epoch ms the cooldown was recorded — kept so a stale ledger is legible. */
    at: number
    /**
     * Which model family ran out, when the limit notice named one.
     *
     * Absent does NOT mean the account is out as a whole — see cooldownFamily.
     * An entry written before this field existed still names its model in the
     * `reason`, because the reason is the notice verbatim, and that sentence
     * is read as the fallback. Only an entry that names no model anywhere is
     * account-wide.
     *
     * Measured 2026-08-29: main, bitspur.com and risserproperties were all
     * blacked out for the full five-hour defaultCooldownMs with the reason
     * "You've reached your Fable 5 limit." A Fable-only limit recorded as a
     * total blackout, three times over, on the day Clay could not get a
     * session anywhere. Reading that reason back is what un-blacks them.
     */
    family?: string
}

export type Ledger = Record<string, Cooldown>

/** No reset time in the limit message: Claude's plan windows are five hours. */
export const defaultCooldownMs = 5 * 60 * 60 * 1000

function expandTilde(p: string): string {
    return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export function droverStateDir(): string {
    const xdg = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
    return join(xdg, 'cattle-drover')
}

export function registryPath(): string {
    return process.env.DROVER_ACCOUNTS || join(homedir(), 'Projects', 'bitspur', 'cattle-drover', 'accounts.json')
}

export function ledgerPath(): string {
    return join(droverStateDir(), 'cooldowns.json')
}

export function readAccounts(): DroverAccount[] {
    const path = registryPath()
    try {
        if (!existsSync(path)) return []
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        if (!Array.isArray(raw)) return []
        return raw
            .filter((a) => a && typeof a.name === 'string' &&
                (typeof a.configDir === 'string' || a.configDir === undefined || a.configDir === null))
            .map((a) => {
                const ambient = isAmbientSpelling(a.configDir)
                return {
                    name: a.name,
                    // The ambient account still HAS a data dir — that is where
                    // its transcripts are, and carrying one is the whole flip.
                    // What it does not have is a CLAUDE_CONFIG_DIR to set.
                    configDir: ambient ? ambientDataDir() : expandTilde(a.configDir),
                    ...(ambient ? { ambient: true } : {}),
                    ...(typeof a.flipPrompt === 'string' ? { flipPrompt: a.flipPrompt } : {}),
                }
            })
    } catch (err) {
        logger.debug('[flip] unreadable account registry at ' + path, err)
        return []
    }
}

/** The .claude.json holding an account's onboarding state and OAuth identity. */
export function accountConfigFile(a: DroverAccount): string {
    return a.ambient ? join(homedir(), '.claude.json') : join(a.configDir, '.claude.json')
}

/**
 * Has this account ever been logged in?
 *
 * Checked by PRESENCE, never by value: `oauthAccount` is written by Claude
 * Code's own login flow and is identity, not a secret, and nothing in the
 * drover reads a token. Installs that keep credentials in a file rather than
 * the macOS keychain are covered by the `.credentials.json` check.
 *
 * This matters because an account row with no credential is not a place work
 * can go. Flipping onto one hands the session Claude Code's first-run wizard,
 * which a wrapped session cannot answer — so from the outside the flip looks
 * like it silently failed. Measured on Clay's machine: BOTH registry accounts
 * were in this state, which is why every flip appeared to do nothing useful.
 */
export function isLoggedIn(a: DroverAccount): boolean {
    try {
        if (existsSync(join(a.configDir, '.credentials.json'))) return true
        const cfg = accountConfigFile(a)
        if (!existsSync(cfg)) return false
        const raw = JSON.parse(readFileSync(cfg, 'utf8'))
        return !!raw && typeof raw === 'object' && 'oauthAccount' in raw
    } catch (err) {
        logger.debug('[flip] could not read login state for ' + a.name, err)
        // Unreadable is not "logged out". Refusing to flip because a file
        // could not be parsed would be worse than trying and finding out.
        return true
    }
}

export function accountByName(name: string): DroverAccount | undefined {
    return readAccounts().find((a) => a.name === name)
}

// --- one login wearing two names ---------------------------------------------
//
// DROVE-21. `main` (~/.claude) and `risserproperties` both hold
// risserproperties@gmail.com in their .claude.json: one claude.ai login that
// drover has two names for. Measured 2026-08-30: main's cache said weekly_all
// 100% until Sep 3 while risserproperties' older cache still said 89%, so the
// table showed one dead row and one live row for the SAME quota, and a bare
// `drover` landed on the "live" one. Headroom and cooldowns are per login, so
// twins are read as one account. Nothing here edits the registry: the rows
// stay, and the duplicate is only marked.

/** The address an account is logged in as, from the same key isLoggedIn tests. */
export function loginEmail(a: DroverAccount): string | undefined {
    try {
        const cfg = accountConfigFile(a)
        if (!existsSync(cfg)) return undefined
        const raw = JSON.parse(readFileSync(cfg, 'utf8')) as { oauthAccount?: { emailAddress?: unknown } }
        const email = raw?.oauthAccount?.emailAddress
        return typeof email === 'string' && email ? email.trim().toLowerCase() : undefined
    } catch (err) {
        logger.debug('[flip] could not read the login for ' + a.name, err)
        return undefined
    }
}

/** Every OTHER registry account logged in as the same address. */
export function loginTwins(a: DroverAccount, accounts: DroverAccount[] = readAccounts()): DroverAccount[] {
    const email = loginEmail(a)
    if (!email) return []
    return accounts.filter((b) => b.name !== a.name && loginEmail(b) === email)
}

/**
 * The name this account duplicates, or undefined when it is the first of its
 * login in registry order. Registry order is what makes the answer stable:
 * `risserproperties` is "same login as main", never the other way round.
 */
export function sameLoginAs(a: DroverAccount, accounts: DroverAccount[] = readAccounts()): string | undefined {
    const email = loginEmail(a)
    if (!email) return undefined
    for (const b of accounts) {
        if (b.name === a.name) return undefined
        if (loginEmail(b) === email) return b.name
    }
    return undefined
}

// --- what Claude Code already knows about headroom ---------------------------
//
// The cooldown ledger below is REACTIVE: it only knows about an account that
// ran out while a drover session was watching it. An account exhausted
// anywhere else — a plain `claude` in another terminal, the web app, hours ago
// — is a blank to it, and a blank reads as "has headroom". So the chooser
// walked straight onto a dead account and the session felt round-robined.
//
// Measured 2026-08-28: jamrizzi sat at weekly_all 100% with no ledger entry at
// all, and three flips in a row landed there.
//
// There is no quota API to call here and nothing in the drover talks to
// Anthropic. But Claude Code caches its OWN usage response in each account's
// `.claude.json` under `cachedUsageUtilization`, and refreshes it as every
// session starts. That is a real per-account signal sitting on disk, so it is
// read rather than guessed at.

export interface UsageExhaustion {
    /** Epoch ms the last of the maxed-out limits resets. */
    until: number
    /** Which limit is biting, in the words the table and the ledger show. */
    reason: string
}

export interface UsageLimitRow {
    kind?: unknown
    percent?: unknown
    resets_at?: unknown
    scope?: { model?: { display_name?: unknown } | null; surface?: unknown } | null
}

/** Claude Code's cached usage response for one account, as it sits on disk. */
export interface UsageCache {
    /** Epoch ms Claude Code fetched it, or null when the cache does not say. */
    fetchedAt: number | null
    rows: UsageLimitRow[]
}

/**
 * The usage cache, read off the account's .claude.json, or null when there is
 * no readable one.
 *
 * The ONE place that file is parsed for headroom (DROVE-47). readUsageExhaustion
 * asks it "is anything at 100%" and the app's usage strip asks it "how full is
 * everything"; two readers of the same rows is fine, two parsers of the same
 * file is how `drover accounts` and the picker once disagreed about a limit.
 * Nothing here interprets a row — that stays with the callers, so this cannot
 * quietly change what "blocked" means.
 */
export function readUsageCache(a: DroverAccount): UsageCache | null {
    let cached: unknown
    try {
        const cfg = accountConfigFile(a)
        if (!existsSync(cfg)) return null
        const raw = JSON.parse(readFileSync(cfg, 'utf8')) as { cachedUsageUtilization?: unknown }
        cached = raw?.cachedUsageUtilization
    } catch (err) {
        logger.debug('[flip] could not read the usage cache for ' + a.name, err)
        return null
    }
    const c = cached as { fetchedAtMs?: unknown; utilization?: { limits?: unknown } } | null | undefined
    const rows = c?.utilization?.limits
    if (!Array.isArray(rows)) return null
    const fetchedAt = Number(c?.fetchedAtMs)
    return {
        fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : null,
        rows: rows.filter((row): row is UsageLimitRow => !!row && typeof row === 'object'),
    }
}

/**
 * Does this maxed-out row stand between the session and a turn?
 *
 * An unscoped row (`session`, `weekly_all`) stops every model, so it always
 * does. A scoped one stops one family. Anything we cannot READ — a surface
 * scope, which has never been observed, or a display name that reduces to no
 * family — blocks too. That default is the safety of the whole feature: an
 * unrecognised scope must never make a dead account look alive.
 */
function rowBlocks(row: UsageLimitRow, demand: ModelDemand): boolean {
    const scope = row?.scope
    if (!scope || (scope.model == null && scope.surface == null)) return true
    if (scope.surface != null) return true
    if (demand.kind === 'unknown') return true
    const rowFamily = familyOfDisplayName(scope.model?.display_name)
    if (!rowFamily) return true
    if (demand.kind === 'any') return false
    return rowFamily === demand.family
}

/** "Fable weekly limit at 100%" — said the way `drover accounts` prints it. */
function describeLimit(row: UsageLimitRow): string {
    const kind = String(row?.kind ?? '')
    const window = kind === 'session'
        ? '5-hour'
        : kind.startsWith('weekly')
            ? 'weekly'
            : kind.replace(/_/g, ' ') || 'usage'
    const model = row?.scope?.model?.display_name
    const what = typeof model === 'string' && model ? `${model} ${window}` : window
    return `${what} limit at 100% (Claude Code's own usage cache)`
}

/**
 * What Claude Code last measured about this account's headroom, or null.
 *
 * Read ONE WAY ONLY, and that asymmetry is the whole safety of it: a limit
 * already at 100% can rule an account OUT, but the absence of one never rules
 * an account IN. A stale cache can therefore only ever be conservative, and
 * the reactive ledger stays the thing that catches an account running out
 * mid-session. A limit whose `resets_at` has passed, or that carries no
 * parseable one, is simply no evidence — never "out forever".
 *
 * `demand` narrows WHICH maxed rows count, and it does not weaken that
 * asymmetry: a row still only ever rules the account out. All it changes is
 * that a row scoped to a family the session is not running stops being
 * evidence about the session. With the default demand nothing is narrowed and
 * this behaves exactly as it did before families existed.
 */
export function readUsageExhaustion(
    a: DroverAccount,
    now = Date.now(),
    demand: ModelDemand = unknownModel,
): UsageExhaustion | null {
    const cache = readUsageCache(a)
    if (!cache) return null
    const rows = cache.rows

    let until = 0
    let reason = ''
    // Tracked apart so the REASON can prefer an account-wide row. jamrizzi's
    // weekly_all reset at 18:59:59.859969Z and its Fable-scoped row 252
    // MICROSECONDS later, so "the latest" picked the scoped one and the table
    // read "Fable weekly limit at 100%" when the real blocker was weekly_all.
    // Right verdict, wrong explanation, and the explanation is what Clay acts
    // on: one says switch models, the other says wait.
    let wideUntil = 0
    let wideReason = ''
    for (const row of rows) {
        const percent = Number(row?.percent)
        if (!Number.isFinite(percent) || percent < 100) continue
        const resets = Date.parse(String(row?.resets_at ?? ''))
        if (!Number.isFinite(resets) || resets <= now) continue
        if (!rowBlocks(row, demand)) continue
        // Blocked until the LAST of the maxed-out limits clears, not the first.
        if (resets > until) {
            until = resets
            reason = describeLimit(row)
        }
        if (row?.scope?.model == null && resets > wideUntil) {
            wideUntil = resets
            wideReason = describeLimit(row)
        }
    }
    return until > 0 ? { until, reason: wideReason || reason } : null
}

/**
 * Which account this process is running as.
 *
 * DROVER_ACCOUNT is the stamp `drover account` exports and is authoritative.
 * Without it, CLAUDE_CONFIG_DIR still identifies the account if it happens to
 * match a registry entry — that covers a session started before the wrapper
 * existed, or one started by hand.
 */
export function currentAccount(): DroverAccount | undefined {
    const stamped = process.env.DROVER_ACCOUNT
    if (stamped) {
        const known = accountByName(stamped)
        if (known) return known
        // Stamped but unregistered: still worth naming, because the flip has
        // to know what it is flipping AWAY from to avoid choosing it again.
        return { name: stamped, configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') }
    }
    // Unset CLAUDE_CONFIG_DIR means the ambient account, and that is a
    // different thing from one whose configDir happens to be ~/.claude — see
    // DroverAccount.ambient. Matching them together is how a session on the
    // real login was mistaken for one on an empty config dir.
    const explicit = process.env.CLAUDE_CONFIG_DIR
    const accounts = readAccounts()
    if (!explicit) return accounts.find((a) => a.ambient)
    return accounts.find((a) => !a.ambient && a.configDir === explicit)
}

export function readLedger(): Ledger {
    try {
        const path = ledgerPath()
        if (!existsSync(path)) return {}
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
        const out: Ledger = {}
        for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
            const c = v as Partial<Cooldown>
            if (typeof c?.until === 'number' && Number.isFinite(c.until)) {
                out[name] = {
                    until: c.until,
                    reason: String(c.reason ?? ''),
                    at: Number(c.at) || 0,
                    // Missing stays missing: the field is never invented on
                    // read, so what is on disk stays what was written. The
                    // reason is consulted for a family at the point a decision
                    // needs one, in cooldownFamily, and nowhere else.
                    ...(typeof c.family === 'string' && c.family ? { family: c.family } : {}),
                }
            }
        }
        return out
    } catch (err) {
        logger.debug('[flip] unreadable cooldown ledger', err)
        return {}
    }
}

function writeLedger(ledger: Ledger): void {
    const path = ledgerPath()
    try {
        mkdirSync(dirname(path), { recursive: true })
        // Write-then-rename: several sessions flip at once, and a half-written
        // ledger read by the next one would park a session that has headroom.
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 })
        renameSync(tmp, path)
    } catch (err) {
        logger.debug('[flip] could not write cooldown ledger', err)
    }
}

export function setCooldown(name: string, until: number, reason: string, family?: string): void {
    const ledger = readLedger()
    const now = Date.now()
    const existing = ledger[name]
    // Never shorten a cooldown by re-recording it: two sessions on the same
    // account both hit the limit, and the second one must not shrink the first
    // one's window just because its own message carried no reset time.
    if (existing && existing.until > until) return
    // A family-scoped cooldown blocks LESS than an account-wide one, so it
    // must not quietly replace one that is still in force. "Fable is out"
    // written over "everything is out" would make a dead account read as
    // available for Opus. The window still extends; only the narrowing drops.
    //
    // Asked of cooldownFamily rather than of the bare field, and THAT is the
    // ratchet this killed. It was `!existing.family`, so a family-less entry
    // whose own reason already named Fable counted as account-wide: the next
    // Fable notice re-recorded it, pushed the window out and dropped the
    // family again. The entry could never become scoped, so the account stayed
    // blocked for every model until the whole window expired. Measured on
    // Clay's live ledger 2026-08-29 — three accounts pinned account-wide for
    // five hours by a limit that was only ever Fable's.
    const widened = !!existing && existing.until > now && !cooldownFamily(existing)
    // Widening keeps the STANDING reason, not the new one. The entry stays
    // account-wide, and an account-wide entry carrying a notice that names
    // Fable is the exact shape cooldownFamily reads as scoped — writing one
    // here would reinstate the ratchet the other way round. It is the better
    // sentence anyway, for the reason readUsageExhaustion already prefers a
    // wide row: one says wait, the other says switch models, and it is the
    // account-wide one that is true.
    const scopedTo = widened ? undefined : family
    const standing = widened && existing ? existing.reason : reason
    ledger[name] = { until, reason: standing, at: now, ...(scopedTo ? { family: scopedTo } : {}) }
    writeLedger(ledger)
    logger.debug(
        `[flip] ${name} cooling until ${new Date(until).toISOString()}` +
            `${scopedTo ? ` for ${scopedTo}` : ''} (${standing})`,
    )
}

export function clearCooldown(name: string): void {
    const ledger = readLedger()
    if (!(name in ledger)) return
    delete ledger[name]
    writeLedger(ledger)
}

/**
 * Which family a ledger entry is actually about.
 *
 * The `family` field when the writer set one, and otherwise the notice sitting
 * in `reason` — controller.ts passes detectLimit's verbatim quote as the
 * reason, so "You've reached your Fable 5 limit." is on disk in plain English
 * whether or not the field beside it was ever filled in.
 *
 * The bug this killed, measured against Clay's live ledger 2026-08-29: three
 * entries with no family, each with that exact reason. A family-less entry
 * blocks every model, so an Opus session — session usage 2%, weekly_all 60%,
 * the only 100% row a Fable weekly — was parked for five hours under a note
 * whose four lines each named a FABLE limit. That self-contradiction is the
 * tell. An entry whose reason names Fable was never account-wide.
 *
 * Undefined stays the conservative answer: a notice that names no model means
 * the account, and blocks everything, exactly as it always did.
 */
export function cooldownFamily(c: Cooldown): string | undefined {
    return c.family ?? familyOfLimitText(c.reason)
}

/** Same question as rowBlocks, asked of a ledger entry. */
function ledgerBlocks(c: Cooldown, demand: ModelDemand): boolean {
    const family = cooldownFamily(c)
    if (!family) return true
    if (demand.kind === 'unknown') return true
    if (demand.kind === 'any') return false
    return family === demand.family
}

export interface Cooling {
    /** Epoch ms it expects headroom again; 0 when it has some now. */
    until: number
    /** Why, in the words the announcement and `drover accounts` show. */
    reason: string
}

/**
 * When this account expects headroom again, and why.
 *
 * Two sources, and the LATER one wins, because they are evidence of the same
 * thing from opposite directions. The ledger is what a drover session watched
 * happen. The usage cache is what Claude Code itself last measured. Neither is
 * complete alone: the ledger is blind to an account emptied elsewhere, and the
 * cache is only as fresh as that account's last session.
 *
 * Both are filtered through the same `demand`, because both can be scoped to
 * one model family and neither should block a session running another.
 */
export function coolingState(
    a: DroverAccount,
    ledger: Ledger,
    now = Date.now(),
    demand: ModelDemand = unknownModel,
): Cooling {
    let best = ownCoolingState(a, ledger, now, demand)
    // A twin's evidence is evidence about THIS account (DROVE-21): the quota
    // is the login's, not the name's. The later deadline wins, exactly as it
    // does between the ledger and the cache above, and the reason says which
    // name saw it so the table stays explainable.
    for (const twin of loginTwins(a)) {
        const theirs = ownCoolingState(twin, ledger, now, demand)
        if (theirs.until > best.until) {
            best = { until: theirs.until, reason: `${theirs.reason} (seen on ${twin.name}, the same login)` }
        }
    }
    return best
}

function ownCoolingState(a: DroverAccount, ledger: Ledger, now: number, demand: ModelDemand): Cooling {
    const recorded = ledger[a.name]
    let until = 0
    let reason = ''
    if (recorded && recorded.until > now && ledgerBlocks(recorded, demand)) {
        until = recorded.until
        reason = recorded.reason
    }
    const measured = readUsageExhaustion(a, now, demand)
    if (measured && measured.until > until) {
        until = measured.until
        reason = measured.reason
    }
    return { until, reason }
}

export function coolingUntil(
    a: DroverAccount,
    ledger: Ledger,
    now = Date.now(),
    demand: ModelDemand = unknownModel,
): number {
    return coolingState(a, ledger, now, demand).until
}

export function isCooling(name: string, now = Date.now()): boolean {
    const ledger = readLedger()
    const account = accountByName(name)
    if (account) return coolingUntil(account, ledger, now) > 0
    const c = ledger[name]
    return !!c && c.until > now
}

/**
 * The model an account's settings.json pins, if it pins one.
 *
 * A LAST-RESORT seed for "what is this session running", used only before any
 * assistant turn has been seen. It is a startup default and it lags: a /model
 * switch writes mainLoopModelForSession in memory and never back to the file,
 * and bitspur.com's settings said fable while its copy of a live transcript
 * held both claude-opus-5 and claude-fable-5.
 *
 * Not used to rank TARGETS, though it is tempting: bitspur.com and jamrizzi
 * are both pinned to claude-fable-5[1m], so flipping an Opus session onto
 * either may hand it Fable. Whether a resumed child takes the target's
 * setting or inherits from the carried transcript has not been watched
 * happen, and ranking on an unverified inference is exactly the wrong guess
 * this whole feature is built to avoid.
 */
export function readSettingsModel(a: DroverAccount): string | undefined {
    try {
        const p = join(a.configDir, 'settings.json')
        if (!existsSync(p)) return undefined
        const raw = JSON.parse(readFileSync(p, 'utf8')) as { model?: unknown }
        return typeof raw?.model === 'string' && raw.model ? raw.model : undefined
    } catch (err) {
        logger.debug('[flip] could not read settings.json for ' + a.name, err)
        return undefined
    }
}

// --- where a session was left ------------------------------------------------
//
// A flip is process-local: it rewrites the NEXT child's environment and never
// this process's own. So when the WRAPPER restarts — Clay quits and runs
// `drover` again, or the daemon respawns it — DROVER_ACCOUNT is still the
// account the session was first stamped with, and the controller wakes up
// believing it is somewhere it left hours ago.
//
// Measured 2026-08-28, session 9ae61ba4: on jamrizzi at 22:52, reported
// `from=main` at 23:05 after a restart, carried a stale 384 KB transcript out
// of main's config dir over the newer 465 KB one, and recorded the limit
// jamrizzi hit against main. That last one is why the ledger never learned
// jamrizzi was empty and kept sending work back to it.
//
// This file is the only memory that survives the restart.

export interface Whereabouts {
    /** Registry name of the account this Claude session was last left on. */
    account: string
    /** Kept so a recycled session id in another project cannot match. */
    cwd: string
    at: number
}

/** Entries older than this are dropped on write; a session id is never reused. */
const whereaboutsTtlMs = 7 * 24 * 60 * 60 * 1000

export function whereaboutsPath(): string {
    return join(droverStateDir(), 'whereabouts.json')
}

export function readWhereabouts(): Record<string, Whereabouts> {
    try {
        const path = whereaboutsPath()
        if (!existsSync(path)) return {}
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
        const out: Record<string, Whereabouts> = {}
        for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
            const w = v as Partial<Whereabouts>
            if (typeof w?.account === 'string' && typeof w?.cwd === 'string') {
                out[id] = { account: w.account, cwd: w.cwd, at: Number(w.at) || 0 }
            }
        }
        return out
    } catch (err) {
        logger.debug('[flip] unreadable whereabouts', err)
        return {}
    }
}

export function rememberWhereabouts(claudeSessionId: string, cwd: string, account: string): void {
    const all = readWhereabouts()
    const now = Date.now()
    for (const [id, w] of Object.entries(all)) {
        if (now - w.at > whereaboutsTtlMs) delete all[id]
    }
    all[claudeSessionId] = { account, cwd, at: now }
    const path = whereaboutsPath()
    try {
        mkdirSync(dirname(path), { recursive: true })
        // Write-then-rename, same reason as the ledger: several sessions flip
        // at once and a half-written file read by the next one is a wrong
        // answer about where it is.
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
        renameSync(tmp, path)
    } catch (err) {
        logger.debug('[flip] could not write whereabouts', err)
    }
}

/** The account this Claude session was last left on, if we ever recorded one. */
export function recallWhereabouts(claudeSessionId: string, cwd: string): string | undefined {
    const w = readWhereabouts()[claudeSessionId]
    if (!w || w.cwd !== cwd) return undefined
    return w.account
}

/**
 * Which account this session is REALLY on, read from where it is writing.
 *
 * DROVE-43. The whereabouts record and the DROVER_ACCOUNT stamp both describe
 * the past: the stamp is where the session was born, the record is where some
 * earlier flip left it. Neither survives Clay quitting drover and starting it
 * again, because a bare `drover` starts on the ambient account and updates
 * neither. He hit exactly that — the record said jamrizzi, the session was on
 * main, and the flip answered "already on jamrizzi" four times and refused to
 * move, locking him out of the only account with headroom.
 *
 * The transcript cannot lie the same way. A session appends to the projects
 * tree it is actually using, so the NEWEST copy of <id>.jsonl names the
 * account that is live right now. That is the same principle the bus registry
 * already applies to titles ("the transcript is where the session is writing
 * NOW, so it is the one that is true").
 *
 * IT ONLY WORKS WHEN THE TREES ARE SEPARATE, and since DROVE-40 they are not
 * (DROVE-59). Sharing pointed every account's projects/ at one store so a flip
 * stops copying transcripts — which means six accounts now stat ONE INODE and
 * get one mtime six times. A strict `>` then keeps whichever account the
 * registry lists first, and that is `main`. Measured twice tonight, while both
 * /status and the whereabouts record correctly said jamrizzi:
 *
 *   [flip] transcript: 19c2f0a8… is writing under main, not jamrizzi
 *          — taking the transcript
 *
 * So the file is only evidence about an account if it belongs to exactly ONE.
 * A copy reachable through several accounts names all of them, which is to say
 * none, and it is dropped rather than broken by age — this function's whole
 * claim is "I know where it is", and it must not make that claim from a stat
 * that cannot tell two accounts apart. Identity first, then recency among what
 * is left.
 *
 * Undefined when nothing is left to point at: no account holds a transcript
 * (an untouched session), or every copy is shared. Either way the caller keeps
 * its stamp, which is the answer DROVE-43 overrode with a wrong one.
 */
export function accountByNewestTranscript(
    claudeSessionId: string,
    cwd: string,
): DroverAccount | undefined {
    // Keyed by device+inode, because two accounts reach the same bytes through
    // different paths — a symlinked projects/ is exactly that, and so is the
    // hard link the sharing migration leaves behind.
    const byFile = new Map<string, { accounts: DroverAccount[], mtime: number }>()
    for (const a of readAccounts()) {
        const file = join(projectDirFor(a.configDir, cwd), `${claudeSessionId}.jsonl`)
        let st
        try {
            st = statSync(file)
        } catch {
            continue
        }
        const key = `${st.dev}:${st.ino}`
        const seen = byFile.get(key)
        if (seen) seen.accounts.push(a)
        else byFile.set(key, { accounts: [a], mtime: st.mtimeMs })
    }

    let best: DroverAccount | undefined
    let bestMtime = -1
    for (const { accounts, mtime } of byFile.values()) {
        if (accounts.length !== 1) continue
        if (mtime > bestMtime) {
            bestMtime = mtime
            best = accounts[0]
        }
    }
    return best
}

/**
 * The account the newest session in this directory was left on, if any.
 *
 * The same whereabouts file, asked by cwd instead of by session id. A bare
 * `drover` has no id yet (Claude mints one at startup) and `--continue`
 * resolves its id only by reading the project dir, so "the account I was last
 * using here" is the record that fits — and it is one record, not a second
 * memory: every entry already carries its cwd.
 */
export function lastAccountIn(cwd: string): string | undefined {
    let best: Whereabouts | undefined
    for (const w of Object.values(readWhereabouts())) {
        if (w.cwd !== cwd) continue
        if (!best || w.at > best.at) best = w
    }
    return best?.account
}

/** One row of "why we are parked", so the terminal can print the whole story. */
export interface CoolingAccount {
    name: string
    /** Epoch ms; 0 means it has headroom right now. */
    until: number
    reason: string
}

/**
 * The model an account CANNOT run, when it is taken anyway.
 *
 * An account chosen as the last stop before parking has to say which family
 * ran out there, or the session lands, runs the same model, and hits the same
 * wall on its first turn. Empty when the account can run the model after all —
 * the ordinary "stayed put and it is fine here" answer — and empty whenever
 * the model is unknown, because then there is nothing truthful to name.
 */
function withoutModelOf(
    a: DroverAccount,
    ledger: Ledger,
    now: number,
    wants: ModelDemand,
): { withoutModel?: string } {
    if (wants.kind !== 'family') return {}
    return coolingUntil(a, ledger, now, wants) > 0 ? { withoutModel: wants.family } : {}
}

export type Pick =
    | {
          kind: 'account'
          account: DroverAccount
          /**
           * Chosen because nothing else had headroom, not because it was
           * preferred — so a same-account answer can say why instead of
           * reading as "you asked for the one you are on".
           */
          onlyOption?: boolean
          /**
           * The family this account CANNOT run: it was taken as the last stop
           * before parking, on the strength of having headroom for some other
           * model. The answer has to say so, or the session lands there, runs
           * the same model, and hits the same wall on its first turn.
           */
          withoutModel?: string
      }
    | {
          kind: 'parked'
          until: number
          account: DroverAccount
          /** Every candidate and its deadline, in wake-up order. */
          cooling: CoolingAccount[]
          /** Set when the park is about ONE model rather than the account. */
          family?: string
      }
    /** Named explicitly, but it has no credential — flipping there is a dead end. */
    | { kind: 'nologin'; account: DroverAccount }
    | { kind: 'none' }

/**
 * Choose where to flip.
 *
 * Registry order is the preference order — it is a list Clay wrote, not a set.
 * `wanted` names an account explicitly and skips the whole choice, including
 * its cooldown: an explicit flip is a human overriding the ledger, and
 * refusing it would be the tool arguing with the person holding it.
 *
 * With no account free, the answer is `parked` and the earliest expiry, never
 * a flip onto a limited account that would fail on the first turn.
 *
 * `family` is the model the session is actually running, and it makes the
 * choice model-aware in the order Clay asked for: an account with headroom
 * FOR THAT MODEL first, then one with headroom for some other model, then a
 * park. Leave it undefined and every step collapses back to the one strict
 * pass this always did — an unknown model must never change a flip.
 */
export function pickTarget(
    current: string | undefined,
    wanted?: string | null,
    now = Date.now(),
    family?: string,
): Pick {
    const accounts = readAccounts()
    if (accounts.length === 0) return { kind: 'none' }

    if (wanted) {
        const target = accounts.find((a) => a.name === wanted)
        if (!target) return { kind: 'none' }
        // An explicit flip overrides the COOLDOWN ledger, because that is a
        // human overruling a heuristic. It does not override a missing login,
        // because that is not a preference — there is no session to be had
        // there, only a first-run wizard nothing can answer.
        if (!isLoggedIn(target)) return { kind: 'nologin', account: target }
        return { kind: 'account', account: target }
    }

    const ledger = readLedger()
    // An account with no credential is not somewhere work can go, so it is not
    // a candidate at all — not for the automatic choice, and not for the park
    // deadline either. Leaving it in made auto-flip pick a dead account and
    // then park the session waiting for a limit that account never had.
    const usable = accounts.filter(isLoggedIn)
    // A twin of the current account is the same login (DROVE-21): moving
    // there changes nothing but the name and costs a relaunch, so it is no
    // more a target than the account we are on.
    const here = accounts.find((a) => a.name === current)
    const twins = new Set(here ? loginTwins(here, accounts).map((a) => a.name) : [])
    const others = usable.filter((a) => a.name !== current && !twins.has(a.name))
    if (others.length === 0) return { kind: 'none' }

    const wants = modelDemand(family)

    // Headroom, not position. Registry order still decides BETWEEN accounts
    // that have headroom, but an account known to be out is skipped whether
    // that knowledge came from the ledger or from Claude Code's usage cache —
    // see coolingUntil. Ordering alone is what made this feel round-robin.
    //
    // "Out" is now asked about the MODEL IN USE. On Clay's plan the server only
    // ever emits a Fable-scoped row, so for an Opus session the scoped rows
    // simply stop counting and the account is judged on `session` + `weekly_all`
    // alone. That is what unsticks main, which sat at five_hour 2% and was
    // called dead by a Fable weekly row it was not running.
    const free = others.find((a) => coolingUntil(a, ledger, now, wants) === 0)
    if (free) return { kind: 'account', account: free }

    // Nothing has headroom for this model. Before parking for hours, settle on
    // an account that can still run SOMETHING — Claude Code's own limit notice
    // says "switch models with /model", and a live session on Opus beats five
    // hours of nothing. Reachable ONLY when the family is known, because only
    // then can the answer name the model that ran out and the one to switch to.
    // With an unknown family this is skipped and the strict park below stands,
    // which is exactly what this did before.
    //
    // STAYING PUT COMES FIRST, and that is the whole termination argument.
    // The first cut took the first OTHER account with headroom for any model,
    // which has no fixed point. Measured 2026-08-29: three accounts each
    // carrying a Fable-scoped cooldown, session family fable, answered
    // `{account, withoutModel:'fable'}` twelve calls running — main -> alt ->
    // main -> alt, from the ledger and from the usage cache alike — and never
    // parked. Each of those hops relaunches Claude with the flip prompt
    // auto-submitted, so the session toured the registry burning a turn per
    // hop for as long as it was left alone. An unbounded relaunch loop is
    // strictly worse than the wedge this feature was built to fix.
    //
    // Preferring the account we are already on gives the choice a fixed point.
    // If this account can run something, the answer IS this account, which the
    // controller reads as "staying put" and nothing relaunches. If it cannot,
    // we move ONCE to the first account in registry order that can, and that
    // account answers itself on the next call. So for EVERY input the sequence
    // is at most one move long — there is no registry, ledger or cache that
    // makes it cycle.
    //
    // It is the better answer on its own merits too. Moving to an account that
    // is also out of Fable changes nothing a session can act on: it still has
    // to switch models, only now on a different login, with the conversation
    // dragged across for no gain.
    let deadline = wants
    if (wants.kind === 'family') {
        const anywhere = usable.filter((a) => coolingUntil(a, ledger, now, anyModel) === 0)
        const settle = anywhere.find((a) => a.name === current) ?? anywhere[0]
        if (settle) {
            return {
                kind: 'account',
                account: settle,
                onlyOption: true,
                ...withoutModelOf(settle, ledger, now, wants),
            }
        }
        deadline = anyModel
    }

    // Everything is cooling. Park until the soonest one comes back — including
    // the account we are on, which may well be the first to reset. The park is
    // measured against the LOOSEST demand that could still have been satisfied,
    // so we wake at the first moment any model is runnable anywhere rather than
    // sleeping through it waiting for one particular family.
    const candidates = usable.map((a) => ({ a, ...coolingState(a, ledger, now, deadline) }))
    candidates.sort((x, y) => x.until - y.until)
    const soonest = candidates[0]

    // A park whose deadline has ALREADY PASSED is not a park — that account
    // has headroom right now. Returning it as one is a livelock: the launcher
    // parks for zero milliseconds, wakes, asks again, gets the same answer,
    // and spins as fast as the event loop allows. This is the ordinary end of
    // every park, because the account we wake up FOR is usually the one we are
    // already sitting on, and `others` has excluded it from the search above.
    //
    // coolingState never returns a deadline in the past — it is 0 or in the
    // future — so this fires exactly when the soonest candidate is free, and
    // the model-aware passes above cannot slip a zero-length park past it.
    //
    // With a family in play this is now belt and braces: the fallback above
    // has already answered whenever anything could run any model, and when
    // nothing could, every candidate is cooling into the future and this
    // cannot fire. It still guards the model-blind path, which is the one the
    // spin was measured on, and it still names the model when it fires so a
    // later change to that fallback cannot hand back an account that runs
    // something else without saying so.
    if (soonest.until <= now) {
        return {
            kind: 'account',
            account: soonest.a,
            onlyOption: true,
            ...withoutModelOf(soonest.a, ledger, now, wants),
        }
    }

    return {
        kind: 'parked',
        until: soonest.until,
        account: soonest.a,
        cooling: candidates.map(({ a, until, reason }) => ({ name: a.name, until, reason })),
        ...(wants.kind === 'family' ? { family: wants.family } : {}),
    }
}

// --- which account a session STARTS on --------------------------------------
//
// DROVE-21. A bare `drover` made no account decision at all: CLAUDE_CONFIG_DIR
// stayed unset, so every restart opened on the ambient login — Clay's words,
// "it's always starting back with risserproperties" — while the account the
// session was actually left on sat in whereabouts.json unread, and the one
// with headroom sat unused. bin/drover asks this before the first spawn and
// execs through `drover account use`, so the child is stamped.
//
// Precedence, and why:
//   1. whereabouts for the resumed id   — the session was left there; under
//                                        the shared store any account can
//                                        resume it, so "last on" is the whole
//                                        of what "resume" means for accounts
//   2. the newest whereabouts for cwd   — a bare start has no id yet, so the
//                                        directory stands in for the session
//   3. pickTarget                       — nothing remembered, or the memory is
//                                        cooling for the model in use
//   4. nothing                          — no registry; bin/drover runs as it
//                                        always did
// An explicit -a/--account never reaches here: bin/drover handles it first.

export interface StartPick {
    account?: DroverAccount
    /** Where the answer came from, for the log and the tests. */
    via: 'session' | 'cwd' | 'picker' | 'none'
    /** One line for stderr, or nothing when there is nothing worth saying. */
    note?: string
    /** The family this account cannot run, when it was taken anyway. */
    withoutModel?: string
}

/** "21:00", or "Thu 21:00" when it is more than a day out — as `drover accounts` prints it. */
function whenBack(until: number, now: number): string {
    const d = new Date(until)
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    if (until - now < 24 * 60 * 60 * 1000) return hm
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`
}

export function pickStartAccount(opts: {
    cwd: string
    /** The id behind --resume/--continue, when the args named one. */
    sessionId?: string | null
    /** The --model flag, when one was typed. */
    model?: string
    now?: number
}): StartPick {
    const now = opts.now ?? Date.now()
    const accounts = readAccounts()
    if (accounts.length === 0) return { via: 'none' }

    let via: StartPick['via'] = 'none'
    let remembered = opts.sessionId ? recallWhereabouts(opts.sessionId, opts.cwd) : undefined
    if (remembered) {
        via = 'session'
    } else {
        remembered = lastAccountIn(opts.cwd)
        if (remembered) via = 'cwd'
    }
    const memory = remembered ? accounts.find((a) => a.name === remembered) : undefined
    const where = via === 'session' ? 'where this session was left' : 'last used in this directory'

    // What the session will run: the flag if there is one, else the remembered
    // account's own default. The same startup seed the controller uses, and
    // the same fallback — unknown, which counts every limit — when neither
    // says. A guess here would send a Fable session to an account that only
    // has Opus left and call it headroom.
    const family = familyOf(opts.model) ?? (memory ? familyOf(readSettingsModel(memory)) : undefined)
    const ledger = readLedger()

    if (memory && isLoggedIn(memory)) {
        const cooling = coolingState(memory, ledger, now, modelDemand(family))
        if (cooling.until === 0) {
            return { account: memory, via, note: `on ${memory.name} — ${where}` }
        }
        const choice = pickTarget(memory.name, null, now, family)
        const why = `${memory.name} is cooling: ${cooling.reason}, back ${whenBack(cooling.until, now)}.`
        if (choice.kind === 'account' && choice.account.name !== memory.name) {
            return {
                account: choice.account,
                via: 'picker',
                note:
                    `${why} Starting on ${choice.account.name} instead` +
                    (choice.withoutModel ? `, which is out of ${choice.withoutModel} too; switch models with /model` : ''),
                ...(choice.withoutModel ? { withoutModel: choice.withoutModel } : {}),
            }
        }
        // Nowhere better: pickTarget parked, or settled on the account we
        // remembered. Staying is the honest answer — the memory is still where
        // the work is, and a park with no child is not a session start.
        const back = choice.kind === 'parked' ? ` Every account is cooling; ${choice.account.name} is back first.` : ''
        return { account: memory, via, note: `${why}${back} Starting there anyway` }
    }

    const choice = pickTarget(undefined, null, now, family)
    if (choice.kind === 'account') {
        return {
            account: choice.account,
            via: 'picker',
            note:
                `on ${choice.account.name} — ${memory ? `${memory.name} has no login; ` : 'nothing remembered here; '}` +
                (choice.onlyOption ? 'the only account with headroom' : 'the first account with headroom') +
                (choice.withoutModel ? `, though it is out of ${choice.withoutModel}; switch models with /model` : ''),
            ...(choice.withoutModel ? { withoutModel: choice.withoutModel } : {}),
        }
    }
    if (choice.kind === 'parked') {
        return {
            account: choice.account,
            via: 'picker',
            note: `every account is cooling; ${choice.account.name} is back first (${whenBack(choice.until, now)}) — starting there`,
        }
    }
    return { via: 'none' }
}
