/**
 * Which sessions are retired, for every surface that lists them (BASED-98).
 *
 * The rule used to live inside storage.ts, which is the whole app — React
 * Native, the socket, zustand, the reducer. Nothing outside it could import the
 * rule without importing all of that, so the wrist never did: collectSessions
 * filtered on its own two conditions and archived sessions sailed onto the
 * watch as merely `active: false`, mixed in with live work. `drover sessions`
 * lists around twenty rows and most of them are dead or test residue, so that
 * was most of what the wrist was carrying.
 *
 * Here it is one definition both surfaces call, and a vitest can call the real
 * one rather than a copy that drifts.
 */

import { isRigMetadata } from './rig';
import type { Metadata } from './storageTypes';

/**
 * Only the two fields the rule reads. `Session` satisfies it structurally, so
 * every real call site still type-checks against the full session.
 */
export interface ArchivableSession {
    active: boolean;
    metadata: Metadata | null;
}

/**
 * A session the agent retired, or a Happy CLI session that has ended. Rig
 * sessions that merely lost their connection are still live work, which is why
 * the second clause is not just `!active`.
 */
export function isSessionArchived(session: ArchivableSession): boolean {
    return session.metadata?.lifecycleState === 'archived'
        || (!isRigMetadata(session.metadata) && !session.active);
}
