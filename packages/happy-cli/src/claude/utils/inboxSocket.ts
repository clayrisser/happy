/**
 * Channel 0: the inbox socket of the Claude that owns this pane (DROVE-1).
 *
 * A phone message for a pane session used to have exactly one carrier — typing
 * it into the tmux pane. That works only while Claude is sitting at its prompt
 * with nothing half-typed in the box, and a bracketed paste plus Enter lands on
 * whatever is on screen, an open permission dialog included.
 *
 * Every interactive Claude also binds a unix socket of its own and announces it
 * in the session registry: `<config dir>/sessions/<pid>.json` carries
 * `messagingSocketPath` and the session id, and the sibling `<pid>.<hash>.key`
 * carries the peer token that socket demands. A message written there is queued
 * BY CLAUDE and served between tool calls, so it is safe mid-turn, cannot merge
 * with a draft and cannot answer a dialog. It is deprivileged — it arrives as a
 * peer note rather than as the owner, so a slash command is text — which is why
 * the pane stays as the fallback rather than being deleted.
 *
 * Wire format copied from cattle-drover `engine/sender.js` socketSend, which is
 * the proven implementation: newline-delimited JSON, auth line first.
 *
 * The token is read, held for one write and never logged.
 */

import { readdir, readFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'

import { ambientDataDir } from '@/drover/flip/accounts'
import { logger } from '@/ui/logger'

export interface ClaudeInbox {
    /** The interactive claude that bound the socket. */
    pid: number
    /** Its own session id, echoed back on the user frame. */
    sessionId: string
    socketPath: string
    /** Peer token for the auth line. Never logged, never sent to the app. */
    token: string
}

/**
 * ok      delivered
 * gone    nothing behind the socket (ENOENT / ECONNREFUSED) — the process that
 *         bound it is dead, so fall through to the pane
 * failed  transient (timeout, write error) — also falls through, but the
 *         binding is not evidence of a dead session
 */
export type InboxSendResult = 'ok' | 'gone' | 'failed'

const socketTimeoutMs = 2_000

interface SessionRecord {
    pid?: unknown
    sessionId?: unknown
    tmux?: unknown
    messagingSocketPath?: unknown
}

/**
 * The inbox belonging to `claudeSessionId`, or null when there is none to find.
 *
 * Resolved fresh on every send rather than cached: a flip gives the session a
 * new pid and a new file, and a clean exit removes the old one. `tmuxPane` is
 * only a tie-break — two records claiming the same session id means one of them
 * is stale, and the one whose `tmux` field ends in our pane is ours.
 */
export async function findInbox(
    configDir: string | undefined,
    claudeSessionId: string | null,
    tmuxPane?: string,
): Promise<ClaudeInbox | null> {
    if (!claudeSessionId) return null

    const dir = join(configDir && configDir.length > 0 ? configDir : ambientDataDir(), 'sessions')
    let names: string[]
    try {
        names = await readdir(dir)
    } catch {
        // No registry at all: an old Claude, or a config dir that never ran one.
        return null
    }

    const candidates: { pid: number; socketPath: string; tmux: string | null }[] = []
    for (const name of names) {
        if (!name.endsWith('.json')) continue
        let record: SessionRecord
        try {
            record = JSON.parse(await readFile(join(dir, name), 'utf8')) as SessionRecord
        } catch {
            continue
        }
        if (record.sessionId !== claudeSessionId) continue
        if (typeof record.pid !== 'number') continue
        if (typeof record.messagingSocketPath !== 'string' || !record.messagingSocketPath) continue
        candidates.push({
            pid: record.pid,
            socketPath: record.messagingSocketPath,
            tmux: typeof record.tmux === 'string' ? record.tmux : null,
        })
    }
    if (candidates.length === 0) return null

    const chosen = (tmuxPane
        && candidates.find((c) => c.tmux !== null && c.tmux.endsWith(tmuxPane)))
        || candidates[0]

    const token = await readPeerToken(dir, names, chosen.pid)
    if (!token) {
        logger.debug(`[inbox] ${chosen.pid} has a socket but no readable peer token`)
        return null
    }
    logger.debug(`[inbox] ${claudeSessionId} is pid ${chosen.pid} on ${chosen.socketPath}`)
    return { pid: chosen.pid, sessionId: claudeSessionId, socketPath: chosen.socketPath, token }
}

/**
 * The token sits in `<pid>.<sha256 of the socket path>.key`, mode 0600.
 *
 * GLOBBED rather than recomputed: the digest is Claude's business and hashing
 * the path ourselves would break the day it salts or renames anything, silently
 * and in the direction of "no inbox found".
 */
async function readPeerToken(dir: string, names: string[], pid: number): Promise<string | null> {
    const prefix = `${pid}.`
    for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith('.key')) continue
        try {
            const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as { peerToken?: unknown }
            if (typeof parsed.peerToken === 'string' && parsed.peerToken.length > 0) {
                return parsed.peerToken
            }
        } catch {
            // Unreadable or not JSON — try the next one rather than giving up.
        }
    }
    return null
}

/**
 * Write one message into `inbox`. Resolves a reason rather than throwing,
 * because every failure here is a reason to try the pane and none of them is a
 * reason to fail the message.
 */
export function sendToInbox(inbox: ClaudeInbox, text: string, sessionId?: string): Promise<InboxSendResult> {
    return new Promise((resolve) => {
        let settled = false
        const done = (result: InboxSendResult) => {
            if (settled) return
            settled = true
            resolve(result)
        }

        let sock: Socket
        try {
            sock = createConnection({ path: inbox.socketPath })
        } catch {
            done('gone')
            return
        }

        sock.setTimeout(socketTimeoutMs)
        sock.on('timeout', () => {
            sock.destroy()
            done('failed')
        })
        sock.on('error', (err: NodeJS.ErrnoException) => {
            sock.destroy()
            // A stale socket file with nobody behind it.
            done(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'gone' : 'failed')
        })
        sock.on('connect', () => {
            const frames =
                JSON.stringify({ type: 'auth', token: inbox.token })
                + '\n'
                + JSON.stringify({
                    type: 'user',
                    message: { role: 'user', content: text },
                    session_id: sessionId ?? inbox.sessionId,
                })
                + '\n'
            // Half-close: the frames are the whole conversation, and Claude
            // reads to EOF.
            sock.end(frames, () => done('ok'))
        })
    })
}
