import * as React from 'react';

import { autoAcceptSessions } from '@/sync/autoAcceptSessions';

/**
 * Whether THIS session is auto-accepting, and the switch that changes it
 * (DROVE-277).
 *
 * `useSyncExternalStore` over the module singleton, the same wiring the gate
 * overlay uses for its dismissals: the store swaps an immutable set on every
 * change, so identity comparison is enough and no deep-equal is needed.
 *
 * The set is in memory for the life of the process, so there is nothing to
 * hydrate and nothing to wait for — a fresh launch reads false for every
 * session because the set is empty, which is the reset-on-relaunch behaviour
 * with no code doing it.
 */
export function useAutoAccept(sessionId: string | undefined): boolean {
    const on = React.useSyncExternalStore(
        autoAcceptSessions.subscribe,
        autoAcceptSessions.get,
        autoAcceptSessions.get,
    );
    return !!sessionId && on.has(sessionId);
}

/** The setter, stable across renders, for the sheet's switch. */
export function useAutoAcceptToggle(sessionId: string | undefined): (on: boolean) => void {
    return React.useCallback((on: boolean) => {
        if (!sessionId) return;
        autoAcceptSessions.set(sessionId, on);
    }, [sessionId]);
}
