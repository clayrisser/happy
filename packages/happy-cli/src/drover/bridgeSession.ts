/**
 * The bridge's own Happy session, kept across restarts (BASED-98).
 *
 * The bridge wants ONE session per machine — the phone should show a single
 * "Cattle Drover" thread that gates appear in, not a new one every time
 * launchd restarts the service. That means a stable tag, and a stable tag is
 * exactly what `getOrCreateSession` did not survive:
 *
 *   run 1  POST /v1/sessions {tag}  -> creates it, metadata encrypted under a
 *                                      random key minted for that call
 *   run 2  POST /v1/sessions {tag}  -> returns the SAME record, still
 *                                      encrypted under run 1's key, which
 *                                      run 2 mints fresh and cannot match
 *
 * so run 2 decrypts metadata to null and the first `session.metadata.path`
 * downstream throws `Cannot read properties of null (reading 'path')`. That is
 * the crash the bridge has been in since it was written: it worked exactly
 * once, on the very first run, and never again.
 *
 * The fix is to keep the key. It is stored beside the rest of the drover state
 * and pinned through `getOrCreateSession({ dataKey })`. The server is not
 * involved and does not change — the key never leaves this machine except in
 * the same encrypt-for-the-account-public-key envelope a machine record has
 * always used.
 *
 * Second failure this handles: the stored key going stale. Re-pairing against
 * a different account, or a hand-deleted state file, leaves a key that no
 * longer decrypts. Rather than crash-loop again, the tag is ROTATED — a new
 * session on the phone is a visible, self-explaining outcome, and an
 * unreadable one is not.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'

import type { ApiClient } from '@/api/api'
import type { AgentState, Metadata, Session } from '@/api/types'
import { decodeBase64, encodeBase64, getRandomBytes } from '@/api/encryption'
import { logger } from '@/ui/logger'
import { droverStateDir } from './flip/accounts'

interface StoredIdentity {
    tag: string
    /** base64 of the 32-byte content key this session's records are sealed with. */
    dataKey: string
}

export function bridgeIdentityPath(): string {
    return join(droverStateDir(), 'bridge-session.json')
}

function readIdentity(): StoredIdentity | null {
    const path = bridgeIdentityPath()
    try {
        if (!existsSync(path)) return null
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof raw?.tag === 'string' && typeof raw?.dataKey === 'string') {
            return { tag: raw.tag, dataKey: raw.dataKey }
        }
    } catch (err) {
        logger.debug('[drover] unreadable bridge identity, minting a new one', err)
    }
    return null
}

function writeIdentity(identity: StoredIdentity): void {
    const path = bridgeIdentityPath()
    try {
        mkdirSync(dirname(path), { recursive: true })
        // Write-then-rename, 0600: this file holds a content key, and a
        // half-written one would rotate the session for no reason on the next
        // start.
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 })
        renameSync(tmp, path)
    } catch (err) {
        // Not fatal. Losing the file costs one rotation on the next restart,
        // which is far better than refusing to bridge at all.
        logger.debug('[drover] could not persist bridge identity', err)
    }
}

function mint(machineId: string, suffix?: string): StoredIdentity {
    return {
        tag: suffix ? `cattle-drover:${machineId}:${suffix}` : `cattle-drover:${machineId}`,
        dataKey: encodeBase64(getRandomBytes(32)),
    }
}

/**
 * Get the bridge's session, creating it the first time and re-attaching to the
 * same one on every restart after that.
 *
 * Throws only when the server will not give us a usable session at all; a
 * stale key is recovered from, not raised.
 */
export async function getOrCreateBridgeSession(opts: {
    api: ApiClient
    machineId: string
    metadata: Metadata
    state: AgentState
}): Promise<Session> {
    const { api, machineId, metadata, state } = opts

    let identity = readIdentity() ?? mint(machineId)
    let session = await api.getOrCreateSession({
        tag: identity.tag,
        metadata,
        state,
        dataKey: decodeBase64(identity.dataKey),
    })

    // A null metadata means the record exists but is sealed with a key we do
    // not have. Nothing recovers that, so take a fresh tag and say so — the
    // alternative is the crash loop this whole file exists to end.
    if (session && !session.metadata) {
        logger.debug(`[drover] ${identity.tag} no longer decrypts; rotating to a fresh session`)
        identity = mint(machineId, String(Date.now()))
        session = await api.getOrCreateSession({
            tag: identity.tag,
            metadata,
            state,
            dataKey: decodeBase64(identity.dataKey),
        })
    }

    if (!session) {
        throw new Error('Could not create the drover session on the Happy server.')
    }
    if (!session.metadata) {
        throw new Error('The drover session came back unreadable even on a fresh tag.')
    }

    writeIdentity(identity)
    logger.debug(`[drover] bridge session ${session.id} (tag ${identity.tag})`)
    return session
}
