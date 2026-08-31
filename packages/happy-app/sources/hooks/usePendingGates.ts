import * as React from 'react';

import { storage } from '@/sync/storage';
import { withdrawnGates } from '@/sync/droverWithdrawn';
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
    useWithdrawnGates();
    return storage(useDeepEqual((state) => sortGateEntries(collectGateEntries(state.sessions))));
}

/**
 * Re-read the collectors when Clay withdraws a card (DROVE-218).
 *
 * collectGateEntries filters the withdrawn set out itself, so every surface
 * agrees — but the store has not changed, so nothing would re-run the selector
 * and the card would sit there until the next unrelated update. This is the
 * subscription that makes the tap immediate.
 */
export function useWithdrawnGates(): ReadonlySet<string> {
    return React.useSyncExternalStore(withdrawnGates.subscribe, withdrawnGates.get, withdrawnGates.get);
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
    useWithdrawnGates();
    return storage(useDeepEqual((state) => gatesForSession(state.sessions ?? {}, sessionId)));
}

/**
 * The pending gate asking a given question, for an in-session question card
 * that has no permission of its own to answer through (DROVE-52).
 *
 * Deep-equal for the same reason the two above are.
 */
export function useGateForQuestion(question: string): DroverGateEntry | null {
    useWithdrawnGates();
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
    useWithdrawnGates();
    return storage(useDeepEqual((state) => inboxCounts(collectGateEntries(state.sessions))));
}
