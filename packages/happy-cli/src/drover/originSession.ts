/**
 * The happy session a bus gate was RAISED in, for the push a gate sends
 * (DROVE-94).
 *
 * Every bus gate is mirrored into ONE bridge session per machine, and until
 * this existed the push carried that bridge session's id, so a tap on the
 * phone landed on the mirror thread rather than on the agent that stopped.
 * The bus event names the raising Claude session (`origin.sessionId`, a
 * Claude session uuid). The phone knows that uuid as `metadata.claudeSessionId`
 * on the happy session, so the join is: find the happy session whose metadata
 * names this uuid.
 *
 * Where that join lives, measured 2026-08-31:
 *
 * - The bus's `GET /v1/sessions` rows carry id, cwd, account, pane, harness
 *   and transcript. No happy id. Not a registry for this.
 * - `~/.happy/sessions.json` (the daemon's persisted store) carries each
 *   session's KEY and the metadata the session reported at start-up, which is
 *   before the Claude id is known: 1 of 73 rows named a claudeSessionId.
 * - The happy server's `GET /v1/sessions` carries the CURRENT metadata,
 *   encrypted. Decrypting each row with its persisted key is the same read
 *   `findHappySessionForClaudeSession` does for `drover --resume`, minus the
 *   live-wrapper refusal, which here is the normal case rather than a reason
 *   to bail: a session raising a gate is live by definition.
 *
 * Cached, because gates arrive in bursts and the read is a network round trip
 * plus a decrypt per row. A miss on a fresh cache refetches once, so a session
 * that started seconds ago is still found, and a miss on a cache younger than
 * `missGraceMs` is trusted, so an origin the registry does not know cannot
 * turn every gate into a fetch.
 */

import axios from 'axios'

import { decodeBase64, decrypt } from '@/api/encryption'
import type { Metadata } from '@/api/types'
import { configuration } from '@/configuration'
import { readCredentials, readPersistedSessions } from '@/persistence'
import { logger } from '@/ui/logger'

/** One registry row: a happy session and the Claude session it holds. */
export interface RegistryRow {
    id: string
    claudeSessionId?: string | null
}

export type RegistryReader = () => Promise<RegistryRow[]>

export interface OriginRegistry {
    /** The happy session id for a Claude session uuid, or null when unknown. */
    happySessionIdFor(claudeSessionId: string | null | undefined): Promise<string | null>
    /**
     * The other direction, off the SAME rows (DROVE-298).
     *
     * The phone answers a reading command in its own ids and `drover read`
     * prints session names a human typed, so the report has to come back into
     * the terminal's id space. Reading it off this cache rather than a second
     * one is the whole point: two joins over the same fact drift, and a name
     * from the wrong id space is worse than no name.
     */
    claudeSessionIdFor(happySessionId: string | null | undefined): Promise<string | null>
}

type ServerSession = {
    id: string
    metadata: string
}

/**
 * The live join: every happy session this machine holds a key for, with the
 * Claude session its CURRENT metadata names. Rows the key cannot open are
 * skipped rather than failing the read; one bad row is not a reason to lose
 * the rest.
 */
export async function readOriginRegistry(): Promise<RegistryRow[]> {
    const persisted = readPersistedSessions()
    if (Object.keys(persisted).length === 0) return []
    const credentials = await readCredentials()
    if (!credentials) return []

    let sessions: ServerSession[]
    try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
            },
            timeout: 10_000,
        })
        sessions = (response.data as { sessions?: ServerSession[] }).sessions ?? []
    } catch (error) {
        logger.debug('[drover] origin registry: session list failed', error)
        return []
    }

    const rows: RegistryRow[] = []
    for (const raw of sessions) {
        const local = persisted[raw.id]
        if (!local) continue
        let metadata: Metadata | null
        try {
            metadata = decrypt(decodeBase64(local.encryptionKey), local.encryptionVariant, decodeBase64(raw.metadata))
        } catch {
            continue
        }
        if (!metadata) continue
        rows.push({ id: raw.id, claudeSessionId: metadata.claudeSessionId ?? null })
    }
    return rows
}

export function createOriginRegistry(
    read: RegistryReader = readOriginRegistry,
    options: { ttlMs?: number; missGraceMs?: number; now?: () => number } = {},
): OriginRegistry {
    const ttlMs = options.ttlMs ?? 60_000
    const missGraceMs = options.missGraceMs ?? 5_000
    const now = options.now ?? (() => Date.now())

    let rows: RegistryRow[] = []
    let fetchedAt = Number.NEGATIVE_INFINITY
    let inflight: Promise<void> | null = null

    const lookup = (claudeSessionId: string): string | null =>
        rows.find((row) => row.claudeSessionId === claudeSessionId)?.id ?? null

    const reverse = (happySessionId: string): string | null =>
        rows.find((row) => row.id === happySessionId)?.claudeSessionId ?? null

    // One read at a time. A burst of gates while the first read is in flight
    // waits on that read rather than starting its own.
    const refresh = (): Promise<void> => {
        if (inflight) return inflight
        inflight = (async () => {
            try {
                rows = await read()
            } catch (error) {
                logger.debug('[drover] origin registry: read failed', error)
                rows = []
            } finally {
                fetchedAt = now()
                inflight = null
            }
        })()
        return inflight
    }

    return {
        async happySessionIdFor(claudeSessionId) {
            if (!claudeSessionId) return null
            const age = now() - fetchedAt
            if (age < ttlMs) {
                const hit = lookup(claudeSessionId)
                if (hit) return hit
                if (age < missGraceMs) return null
            }
            await refresh()
            return lookup(claudeSessionId)
        },
        async claudeSessionIdFor(happySessionId) {
            if (!happySessionId) return null
            const age = now() - fetchedAt
            if (age < ttlMs) {
                const hit = reverse(happySessionId)
                if (hit) return hit
                if (age < missGraceMs) return null
            }
            await refresh()
            return reverse(happySessionId)
        },
    }
}
