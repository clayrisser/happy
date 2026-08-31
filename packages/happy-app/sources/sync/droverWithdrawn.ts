/**
 * Cards Clay has WITHDRAWN himself, and why that is a different thing from a
 * card he swiped off a screen (DROVE-218).
 *
 * `gateOverlayDismissals` is a fact about one screen: the gate stays pending,
 * the longhorn keeps counting it, the inbox still lists it. This is the
 * opposite. A withdrawal says the prompt should not exist anywhere, so it is
 * filtered out of EVERY surface the moment it is made — inbox, in-session
 * banner, the counts on the longhorn, the wrist.
 *
 * It is a withdrawal and never an approval. The request that goes with it is
 * `POST /v1/events/:id/cancel`, which terminates the event with a NULL
 * resolution; there is no code path from here to `/resolve`, so nothing can
 * read a dismissal as a decision. DROVE-203 is the opposite bug — a gate that
 * resolved `allow` with nobody at the terminal — and a fix for a stuck card
 * must not widen it.
 *
 * The set is dropped locally whatever the bus answers back, because the whole
 * point is a card he can clear without waiting for a diagnosis. If the event
 * really was still pending the cancel lands and the producer learns its gate
 * went away; if it was already dead the card should not have been there at
 * all. Both are reasons the card goes.
 *
 * In memory, for the life of the process, like the overlay's dismissals and
 * for the same reason: a genuinely pending prompt may be the only thing
 * holding a session up, and forgetting it across a relaunch would hide it for
 * good.
 */

export interface WithdrawnGates {
    get(): ReadonlySet<string>;
    /** Both keys a card is known by: the packed `${session}:${event}` id and the request id. */
    withdraw(ids: readonly string[]): void;
    subscribe(listener: () => void): () => void;
    /** Testing only: forget everything, as a relaunch would. */
    reset(): void;
}

export function createWithdrawnGates(): WithdrawnGates {
    let snapshot: ReadonlySet<string> = new Set();
    const listeners = new Set<() => void>();
    const publish = () => { for (const listener of listeners) listener(); };
    return {
        get: () => snapshot,
        withdraw(ids) {
            const fresh = ids.filter((id) => id && !snapshot.has(id));
            if (fresh.length === 0) return;
            snapshot = new Set([...snapshot, ...fresh]);
            publish();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        reset() {
            if (snapshot.size === 0) return;
            snapshot = new Set();
            publish();
        },
    };
}

export const withdrawnGates = createWithdrawnGates();

/**
 * The entries minus the withdrawn ones.
 *
 * Matched on the card id AND the request id, because the two are not the same
 * string: the store keys a mirrored card as `${session}:${event}` while the
 * bus event id is the request id on its own, and a withdrawal is made from a
 * screen that has both.
 */
export function withoutWithdrawn<T extends { gate: { id: string }; requestId: string }>(
    entries: readonly T[],
    withdrawn: ReadonlySet<string> = withdrawnGates.get(),
): T[] {
    if (withdrawn.size === 0) return entries as T[];
    return entries.filter((entry) => !withdrawn.has(entry.gate.id) && !withdrawn.has(entry.requestId));
}
