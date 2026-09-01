/**
 * The terminal's remote control, carried to the phone (DROVE-298).
 *
 * Clay: "I want to be able to control what's read from the CLI as well. NOT
 * that the CLI reads it, but that the CLI controls what the phone is reading."
 *
 * THIS PROCESS MAKES NO SOUND EITHER. It is a courier: a `reading-command`
 * frame off the bus becomes a field on the bridge session's agent state, the
 * phone applies its own rule, and its verdict comes back over the same RPC
 * seam a gate answer takes. Neither end of this file decides what taking the
 * voice means — that is DROVE-297's rule and it lives in the app, reached
 * identically by a thumb and by a terminal.
 *
 * TWO ID SPACES, and this is where they are joined. The bus and `drover
 * sessions` speak the HARNESS's session id (a Claude uuid); the phone speaks
 * the HAPPY session id it shows in its own list. The bridge already holds that
 * join for gate pushes (originSession.ts), so a command is translated on the
 * way in and every id in the phone's report is translated on the way out.
 * Nothing else has to know there are two.
 *
 * AN UNTRANSLATABLE COMMAND IS REFUSED, not delivered blind. A session the
 * phone has never seen would otherwise reach the app as a bare id it cannot
 * match, and the app's refusal would be indistinguishable from a phone that
 * is switched off — which is the one confusion this ticket asks us to remove.
 */

import { logger } from '@/ui/logger'

/** Mirrors VERBS in cattle-drover's engine/reading.js. */
export type ReadingVerb = 'status' | 'on' | 'off' | 'pause' | 'resume'

export interface ReadingCommandFrame {
    id: string
    verb: ReadingVerb
    sessionId?: string | null
    by?: string
    at: number
    ttlMs: number
    state?: string
}

export type ReadingSessionState = 'off' | 'speaking' | 'paused' | 'yielded'

export interface ReadingSessionRow {
    sessionId: string
    enabled: boolean
    state: ReadingSessionState
    title?: string | null
}

export interface ReadingSnapshot {
    global: 'on' | 'off'
    playing: boolean
    sessionId: string | null
    title?: string | null
    sentence?: string | null
    sessions: ReadingSessionRow[]
}

/** What the phone sends back over the `drover-reading` RPC. */
export interface ReadingReport {
    /** Present when this answers a command; absent for an unprompted report. */
    id?: string
    applied?: boolean
    reason?: string
    state: ReadingSnapshot
}

export function isReadingCommandFrame(value: unknown): value is ReadingCommandFrame {
    const v = value as ReadingCommandFrame | null
    return (
        !!v
        && typeof v.id === 'string'
        && typeof v.verb === 'string'
        && ['status', 'on', 'off', 'pause', 'resume'].includes(v.verb)
        && typeof v.at === 'number'
        && typeof v.ttlMs === 'number'
    )
}

/**
 * Past its life, so it must not be carried any further.
 *
 * The command's life is the TERMINAL'S OWN PATIENCE, to the millisecond — the
 * CLI sets ttlMs from its own --timeout. So a frame that arrives after that is
 * one nobody is waiting for, and delivering it would let a phone act on an ask
 * that has already been reported as unanswered. A phone that starts talking in
 * a pocket long after somebody gave up is the surprise DROVE-298 refuses, and
 * this is the first of the three places that refuse it (the bus expires it,
 * this drops it, and the app checks again before it applies).
 */
export function readingCommandExpired(cmd: ReadingCommandFrame, now: number = Date.now()): boolean {
    if (!Number.isFinite(cmd.at) || !Number.isFinite(cmd.ttlMs) || cmd.ttlMs <= 0) return true
    return now > cmd.at + cmd.ttlMs
}

/**
 * The phone's ids, put back into the terminal's words.
 *
 * A row the join cannot name is DROPPED rather than reported under a happy id
 * the terminal has never seen: `drover read` prints these as session names, and
 * a name from the wrong id space is worse than a row that is not there.
 */
export function toDroverIds(
    state: ReadingSnapshot,
    claudeIdFor: (happySessionId: string) => string | null,
): ReadingSnapshot {
    const sessionId = state.sessionId ? claudeIdFor(state.sessionId) : null
    const sessions: ReadingSessionRow[] = []
    for (const row of state.sessions ?? []) {
        const id = claudeIdFor(row.sessionId)
        if (!id) continue
        sessions.push({ ...row, sessionId: id })
    }
    return { ...state, sessionId, sessions }
}

async function post(url: string, body: unknown): Promise<number> {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        return res.status
    } catch (error) {
        logger.debug(`[drover] reading: ${url} unreachable`, error)
        return 0
    }
}

/** The phone's verdict, on the bus. A 409 means the command already expired. */
export async function ackReadingOnBus(
    droverUrl: string,
    id: string,
    body: { applied: boolean; reason?: string; state?: ReadingSnapshot },
): Promise<number> {
    return post(`${droverUrl}/v1/reading/commands/${encodeURIComponent(id)}`, body)
}

/**
 * The phone publishing what it is reading, unprompted.
 *
 * PUT rather than PATCH: a reading state is one indivisible picture of one
 * speaker, and half of it merged over the other half is a picture of nothing.
 * Fail-open like every other drover producer — a bus that is down costs a
 * logged line, never a throw into the socket handler.
 */
export async function reportReadingOnBus(droverUrl: string, state: ReadingSnapshot): Promise<number> {
    try {
        const res = await fetch(`${droverUrl}/v1/reading`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state),
        })
        return res.status
    } catch (error) {
        logger.debug('[drover] reading: could not publish the phone report', error)
        return 0
    }
}
