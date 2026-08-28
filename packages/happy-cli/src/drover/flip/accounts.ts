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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { logger } from '@/ui/logger'

export interface DroverAccount {
    name: string
    configDir: string
    /** Account-scoped override for what a resumed session is told on arrival. */
    flipPrompt?: string
}

export interface Cooldown {
    /** Epoch ms the account is expected to have headroom again. */
    until: number
    reason: string
    /** Epoch ms the cooldown was recorded — kept so a stale ledger is legible. */
    at: number
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
            .filter((a) => a && typeof a.name === 'string' && typeof a.configDir === 'string')
            .map((a) => ({
                name: a.name,
                configDir: expandTilde(a.configDir),
                ...(typeof a.flipPrompt === 'string' ? { flipPrompt: a.flipPrompt } : {}),
            }))
    } catch (err) {
        logger.debug('[flip] unreadable account registry at ' + path, err)
        return []
    }
}

export function accountByName(name: string): DroverAccount | undefined {
    return readAccounts().find((a) => a.name === name)
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
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    return readAccounts().find((a) => a.configDir === dir)
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
                out[name] = { until: c.until, reason: String(c.reason ?? ''), at: Number(c.at) || 0 }
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

export function setCooldown(name: string, until: number, reason: string): void {
    const ledger = readLedger()
    const existing = ledger[name]
    // Never shorten a cooldown by re-recording it: two sessions on the same
    // account both hit the limit, and the second one must not shrink the first
    // one's window just because its own message carried no reset time.
    if (existing && existing.until > until) return
    ledger[name] = { until, reason, at: Date.now() }
    writeLedger(ledger)
    logger.debug(`[flip] ${name} cooling until ${new Date(until).toISOString()} (${reason})`)
}

export function clearCooldown(name: string): void {
    const ledger = readLedger()
    if (!(name in ledger)) return
    delete ledger[name]
    writeLedger(ledger)
}

export function isCooling(name: string, now = Date.now()): boolean {
    const c = readLedger()[name]
    return !!c && c.until > now
}

export type Pick =
    | { kind: 'account'; account: DroverAccount }
    | { kind: 'parked'; until: number; account: DroverAccount }
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
 */
export function pickTarget(current: string | undefined, wanted?: string | null, now = Date.now()): Pick {
    const accounts = readAccounts()
    if (accounts.length === 0) return { kind: 'none' }

    if (wanted) {
        const target = accounts.find((a) => a.name === wanted)
        return target ? { kind: 'account', account: target } : { kind: 'none' }
    }

    const ledger = readLedger()
    const others = accounts.filter((a) => a.name !== current)
    if (others.length === 0) return { kind: 'none' }

    const free = others.find((a) => !(ledger[a.name] && ledger[a.name].until > now))
    if (free) return { kind: 'account', account: free }

    // Everything is cooling. Park until the soonest one comes back — including
    // the account we are on, which may well be the first to reset.
    const candidates = accounts.map((a) => ({ a, until: ledger[a.name]?.until ?? 0 }))
    candidates.sort((x, y) => x.until - y.until)
    const soonest = candidates[0]

    // A park whose deadline has ALREADY PASSED is not a park — that account
    // has headroom right now. Returning it as one is a livelock: the launcher
    // parks for zero milliseconds, wakes, asks again, gets the same answer,
    // and spins as fast as the event loop allows. This is the ordinary end of
    // every park, because the account we wake up FOR is usually the one we are
    // already sitting on, and `others` has excluded it from the search above.
    if (soonest.until <= now) return { kind: 'account', account: soonest.a }

    return { kind: 'parked', until: soonest.until, account: soonest.a }
}
