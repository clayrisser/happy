import { storage } from '@/sync/storage';
import { useDeepEqual } from '@/sync/storeSelectors';
import { collectGateEntries, sortGateEntries, type DroverGateEntry } from '@/sync/droverGates';

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

export type { DroverGateEntry };
