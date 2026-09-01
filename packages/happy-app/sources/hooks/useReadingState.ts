import * as React from 'react';

import { readAloud } from '@/voice/readAloudService';
import type { ReadingSessionState } from '@/voice/readingVoice';

/**
 * Whether THIS session is reading, holding its place, or off (DROVE-297).
 *
 * `useSyncExternalStore` over the one reader, the same wiring `useAutoAccept`
 * uses for its module singleton and the same wiring the composer's capsule
 * already uses for the pause. The reader is the truth — five surfaces drive it
 * and only one of them is any given row — so a copy in React state would be a
 * copy that drifts the moment he squeezes a headphone or types `drover read`
 * in a terminal.
 *
 * The snapshot is a STRING, which is what makes this safe on a list: a row
 * whose state has not changed does not re-render when the voice moves inside
 * another session, and `useSyncExternalStore` needs no memo to say so.
 *
 * Nothing to hydrate. Per-session enablement is runtime for the same reason
 * the pause is (DROVE-233), so a fresh launch reads every session against the
 * one persisted default.
 */
export function useReadingState(sessionId: string | undefined): ReadingSessionState {
    const snapshot = React.useCallback(
        () => (sessionId === undefined ? 'off' : readAloud.readingStateOf(sessionId)),
        [sessionId],
    );
    return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Module scope so the store gets a stable subscribe and never resubscribes. */
function subscribe(onChange: () => void): () => void {
    return readAloud.addTransportListener(onChange);
}
