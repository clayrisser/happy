import { storage } from '@/sync/storage';
import { useDeepEqual } from '@/sync/storeSelectors';
import {
    collectGateEntries,
    gateForQuestion,
    gatesForSession,
    inboxCounts,
    sortGateEntries,
    type DroverGateEntry,
} from '@/sync/droverGates';

/**
 * Every pending gate across every session, for the global gates surface
 * (BASED-98).
 *
 * Deep-equal, not shallow: collectGateEntries mints a fresh object per gate on
 * every call, so `useShallow` compares those by identity and reports a changed
 * snapshot on every read — render, read, render. That is the same loop
 * useSessionPendingCommunications documents, and it only bites once a gate is
 * actually pending, which is exactly when this hook matters.
 */
export function usePendingGates(): DroverGateEntry[] {
    return storage(useDeepEqual((state) => sortGateEntries(collectGateEntries(state.sessions))));
}

/**
 * The gates raised by one session, for presenting them on that session's own
 * view (BASED-113).
 *
 * Deep-equal for the same reason usePendingGates is: the entries are minted
 * fresh on every read, so identity comparison reports a change every time and
 * spins render against read.
 */
export function useSessionGates(sessionId: string): DroverGateEntry[] {
    return storage(useDeepEqual((state) => gatesForSession(state.sessions ?? {}, sessionId)));
}

/**
 * The pending gate asking a given question, for an in-session question card
 * that has no permission of its own to answer through (DROVE-52).
 *
 * Deep-equal for the same reason the two above are.
 */
export function useGateForQuestion(question: string): DroverGateEntry | null {
    return storage(useDeepEqual((state) => gateForQuestion(state.sessions ?? {}, question)));
}

export type { DroverGateEntry };

/**
 * What the longhorn shows without being tapped (DROVE-71).
 *
 * Two counts, never a sum. A pending prompt is blocking a session right now;
 * a to-do is a job that never expires and stalls nothing. Reduced to three
 * numbers on purpose: the header re-renders on every store change, and
 * comparing a scalar record is what keeps that cheap next to the entry list
 * the inbox screen itself reads.
 */
export function useInboxCounts(): { prompts: number; todos: number; total: number } {
    return storage(useDeepEqual((state) => inboxCounts(collectGateEntries(state.sessions))));
}
