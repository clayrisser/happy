import { storage } from '@/sync/storage';
import { useDeepEqual } from '@/sync/storeSelectors';
import {
    collectGateEntries,
    gatesForSession,
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

export type { DroverGateEntry };
