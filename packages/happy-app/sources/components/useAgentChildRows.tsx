/**
 * What one agent has spawned, for that agent's own screen (DROVE-185).
 *
 * Clay: "what if a subagent has lanes in it? Can we visualize that?" An agent
 * screen is a session screen scoped to one agent, so it asks the same question
 * the status row asks and gets it answered the same way: off the SESSION's one
 * live snapshot, which already holds every agent at every depth because Claude
 * Code files them all in one flat directory.
 *
 * No second fetch, no second derivation. `summarizeLiveStatus` is the one
 * place agents become rows, and this takes a branch of what it returns. That
 * is what stops an agent screen ever showing a different number from the row
 * that opened it.
 */
import * as React from 'react';

import { useSession } from '@/sync/storage';
import { useTickingNow } from './useTickingNow';
import {
    agentSubtreeRows,
    isLiveStatusFresh,
    summarizeLiveStatus,
    type LiveStatusRow,
} from '@/utils/liveStatus';

/** Stable empty, so a screen with no children never re-renders on identity. */
const none: LiveStatusRow[] = [];

export function useAgentChildRows(
    sessionId: string | null,
    agentId: string | null,
): LiveStatusRow[] {
    const session = useSession(sessionId ?? '');
    const live = sessionId ? session?.metadata?.liveStatus ?? null : null;
    // Ticking, because these rows carry clocks. Only while there is something
    // live to tick: a finished agent's screen must not run a 1Hz timer.
    const now = useTickingNow(!!live);
    const fresh = isLiveStatusFresh(live, now);
    return React.useMemo(() => {
        if (!live || !fresh || !agentId) return none;
        const rows = summarizeLiveStatus(live, now).rows;
        const subtree = agentSubtreeRows(rows, agentId);
        return subtree.length > 0 ? subtree : none;
    }, [live, fresh, now, agentId]);
}
