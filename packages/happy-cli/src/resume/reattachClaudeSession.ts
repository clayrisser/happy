import axios from 'axios';

import { decodeBase64, decrypt } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { readCredentials, readPersistedSessions } from '@/persistence';
import { logger } from '@/ui/logger';

import { handoverSessionEnv } from '@/drover/relaunch/handover';

import type { ReconnectableHappySession } from './resolveHappySession';

/**
 * Reattach `drover --resume <id>` to the Happy session that already holds that
 * transcript (Cattle Drover, BASED-98).
 *
 * Without this every resume minted a NEW Happy session and the local scanner
 * replayed the whole transcript into it, so the phone showed a second copy of
 * the conversation with old messages streaming in as if they were new. A flip
 * never had the problem because it relaunches the child inside the same
 * wrapper; resume should look the same from the phone: one continuous session.
 *
 * The Claude id is known before the Happy session exists, which is what makes
 * this cheap: it is decided up front in runClaude, on the same reconnect path
 * the daemon's own resume takes through HAPPY_RECONNECT_*, rather than by
 * swapping sockets mid-run once the SessionStart hook fires.
 */

/**
 * A wrapper that sent a keepalive this recently is still driving the session.
 * Keepalives go every 2s; a crash stops them and the server flips `active`
 * off on its own timer, so this covers the gap without joining a live one.
 */
const liveWindowMs = 60_000;

// Moved to its own light module so pick-account can import it without paying
// for axios and the persistence stack (DROVE-288). Re-exported here so every
// existing importer keeps working.
export { resumedClaudeSessionId } from './resumedClaudeSessionId';

type ServerSession = {
    id: string;
    seq: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: string;
    metadataVersion: number;
    agentStateVersion: number;
};

/**
 * The newest Happy session on this machine whose metadata names
 * `claudeSessionId`, with everything needed to reconnect to it.
 *
 * Keys come from the daemon's persisted store (the only place this machine
 * keeps per-session keys); metadata, seq and versions come from the server,
 * because the local snapshot is taken at start-up, before the Claude id was
 * known, and its versions are stale by the first turn. Null means "start a
 * fresh session as before": never tracked here, server unreachable, or another
 * wrapper still live on it.
 */
export async function findHappySessionForClaudeSession(claudeSessionId: string): Promise<ReconnectableHappySession | null> {
    /**
     * The one session whose live-wrapper check is waived (DROVE-172).
     *
     * A relaunch onto a rebuilt bundle is a wrapper handing a session to its
     * own replacement, and the outgoing keepalive is seconds old when the
     * replacement asks. Left alone, the check below would decline and mint a
     * duplicate -- the exact twin-session bug BASED-98 closed. `bin/drover.mjs`
     * names the session it is releasing, and only that one: any other live
     * session still gets the refusal it should.
     */
    const handoverSessionId = process.env[handoverSessionEnv] ?? null;
    const persisted = readPersistedSessions();
    if (Object.keys(persisted).length === 0) return null;
    const credentials = await readCredentials();
    if (!credentials) return null;

    let sessions: ServerSession[];
    try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
            },
            timeout: 10_000,
        });
        sessions = (response.data as { sessions?: ServerSession[] }).sessions ?? [];
    } catch (error) {
        logger.debug('[REATTACH] Session list failed, starting a fresh Happy session', error);
        return null;
    }

    // Newest first: if the same transcript ended up in several Happy sessions
    // (this very bug), the one the phone saw last is the one to continue.
    const candidates = sessions
        .filter((session) => persisted[session.id] !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt);

    for (const raw of candidates) {
        const local = persisted[raw.id];
        const encryptionKey = decodeBase64(local.encryptionKey);
        let metadata: Metadata | null;
        try {
            metadata = decrypt(encryptionKey, local.encryptionVariant, decodeBase64(raw.metadata));
        } catch {
            continue;
        }
        if (!metadata || metadata.claudeSessionId !== claudeSessionId) continue;

        if (raw.active && Date.now() - raw.activeAt < liveWindowMs && raw.id !== handoverSessionId) {
            // Two wrappers on one Happy session would both answer the phone.
            logger.debug(`[REATTACH] Happy session ${raw.id} is live on another wrapper, starting a fresh one`);
            return null;
        }

        return {
            id: raw.id,
            active: raw.active,
            metadata,
            seq: raw.seq,
            metadataVersion: raw.metadataVersion,
            agentStateVersion: raw.agentStateVersion,
            encryptionKey,
            encryptionVariant: local.encryptionVariant,
        };
    }
    return null;
}
