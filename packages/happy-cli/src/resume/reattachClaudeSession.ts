import axios from 'axios';

import { decodeBase64, decrypt } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { claudeFindLastSession } from '@/claude/utils/claudeFindLastSession';
import { configuration } from '@/configuration';
import { readCredentials, readPersistedSessions } from '@/persistence';
import { logger } from '@/ui/logger';

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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A wrapper that sent a keepalive this recently is still driving the session.
 * Keepalives go every 2s; a crash stops them and the server flips `active`
 * off on its own timer, so this covers the gap without joining a live one.
 */
const liveWindowMs = 60_000;

/**
 * The Claude transcript a `--resume` / `--continue` in claudeArgs will land on,
 * or null when it cannot be known before Claude starts.
 *
 * Mirrors claudeLocal's own flag handling so the two agree on the transcript.
 * Bare `--resume` is Claude's picker: the id only exists once the SessionStart
 * hook fires, too late to choose a Happy session, so it stays a fresh session.
 * That is the twin-session bug of DROVE-50, and it is closed on the OTHER side
 * of the exec: bin/drover answers a bare `--resume` (and `-c`) with its own
 * picker and starts this CLI as `--resume <id>`, so by the time this runs the
 * id is always in claudeArgs. The null branch is kept for a plain, unwrapped
 * invocation and for DROVER_RESUME_PICKER=0, which asks for the old behaviour.
 */
export function resumedClaudeSessionId(claudeArgs: string[] | undefined, workingDirectory: string): string | null {
    if (!claudeArgs) return null;
    for (let i = 0; i < claudeArgs.length; i++) {
        const arg = claudeArgs[i];
        if (arg === '--resume' || arg === '-r') {
            const value = claudeArgs[i + 1];
            return value && uuidPattern.test(value) ? value : null;
        }
        if (arg === '--continue' || arg === '-c') {
            return claudeFindLastSession(workingDirectory);
        }
    }
    return null;
}

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

        if (raw.active && Date.now() - raw.activeAt < liveWindowMs) {
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
