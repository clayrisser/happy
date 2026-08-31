/**
 * What the session gate overlay shows, and what it has put away (DROVE-88).
 *
 * The overlay floats over the chat above the composer. Everything it decides
 * without a screen lives here so it can be tested without one: which cards
 * are in the deck, which one is in view, and which gates Clay has swiped off
 * to the inbox without answering.
 *
 * A dismissal is a fact about the SCREEN, never about the gate. The gate stays
 * pending on the bus, the longhorn keeps counting it, and the inbox still
 * lists it. All a dismissal does is stop this overlay from drawing it. That is
 * why it is a plain set of ids held in memory: it must survive leaving the
 * session and coming back (a card you swiped away must not pounce again on
 * return), and it must NOT survive a relaunch, because by then the prompt may
 * be the only thing holding a session up and forgetting it would hide it for
 * good.
 */

export interface GateOverlayCard {
    gate: { id: string };
}

export interface GateOverlayDeck<T extends GateOverlayCard> {
    /** The cards the overlay draws, in the order they came, dismissed ones gone. */
    cards: T[];
    /** The card in view, clamped to the deck. 0 when the deck is empty. */
    index: number;
    count: number;
}

/**
 * The pending gates minus the dismissed ones, with the requested index pulled
 * back inside the deck.
 *
 * Clamped rather than reset: answering the card in view shrinks the deck by
 * one, and the card that was NEXT should slide into its place, not the first
 * card of the pile. Dismissing the last card lands on the new last card for
 * the same reason.
 */
export function overlayDeck<T extends GateOverlayCard>(
    entries: readonly T[],
    dismissed: ReadonlySet<string>,
    index: number,
): GateOverlayDeck<T> {
    const cards = entries.filter((entry) => !dismissed.has(entry.gate.id));
    return { cards, index: clampIndex(index, cards.length), count: cards.length };
}

export function clampIndex(index: number, count: number): number {
    if (count <= 0 || !Number.isFinite(index)) return 0;
    return Math.min(Math.max(0, Math.trunc(index)), count - 1);
}

/** One card left or right, stopping at the ends. A stack is not a carousel. */
export function stepIndex(index: number, count: number, delta: number): number {
    return clampIndex(clampIndex(index, count) + delta, count);
}

/**
 * The page a horizontal swipe landed on, from the scroll offset and the page
 * width. Rounded, because a paging scroll view settles a hair off the exact
 * multiple and a card that is 0.4 pages in is still the card it started on.
 */
export function pageForOffset(offsetX: number, pageWidth: number, count: number): number {
    if (pageWidth <= 0) return 0;
    return clampIndex(Math.round(offsetX / pageWidth), count);
}

/**
 * "2 of 3" for a stack, nothing for a lone card. The header's title already
 * counts the whole deck, so a counter on one card would only repeat it.
 */
export function overlayCounter(index: number, count: number): string | null {
    if (count <= 1) return null;
    return `${clampIndex(index, count) + 1} of ${count}`;
}

/**
 * Whether a swipe on the sheet has gone far enough to mean "put this away".
 *
 * Distance OR speed, the same pair a bottom sheet reads. A slow drag has to
 * travel; a flick can be short. Nothing above the start line ever dismisses,
 * so a drag that wandered up and came back to rest is a drag that changed its
 * mind. A worklet, because the pan gesture asks on the UI thread.
 */
export function swipeDismisses(translationY: number, velocityY: number): boolean {
    'worklet';
    if (translationY <= 0) return false;
    return translationY > 56 || velocityY > 600;
}

/**
 * The dismissed set, shared by every session screen and kept for the life of
 * the process.
 *
 * Immutable snapshots, so useSyncExternalStore can compare by identity and a
 * dismissal that changes nothing (already dismissed) publishes nothing.
 */
export interface GateOverlayDismissals {
    get(): ReadonlySet<string>;
    dismiss(ids: readonly string[]): void;
    /**
     * Put a dismissed gate back on the overlay. A tap on that gate's push is
     * asking to see it, and a card swiped away an hour ago must not answer
     * that tap with nothing (DROVE-94).
     */
    restore(ids: readonly string[]): void;
    subscribe(listener: () => void): () => void;
    /** Testing only: forget everything, as a relaunch would. */
    reset(): void;
}

export function createGateOverlayDismissals(): GateOverlayDismissals {
    let snapshot: ReadonlySet<string> = new Set();
    const listeners = new Set<() => void>();
    return {
        get: () => snapshot,
        dismiss(ids) {
            const fresh = ids.filter((id) => !snapshot.has(id));
            if (fresh.length === 0) return;
            snapshot = new Set([...snapshot, ...fresh]);
            for (const listener of listeners) listener();
        },
        restore(ids) {
            const held = ids.filter((id) => snapshot.has(id));
            if (held.length === 0) return;
            snapshot = new Set([...snapshot].filter((id) => !held.includes(id)));
            for (const listener of listeners) listener();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        reset() {
            if (snapshot.size === 0) return;
            snapshot = new Set();
            for (const listener of listeners) listener();
        },
    };
}

export const gateOverlayDismissals = createGateOverlayDismissals();

/**
 * The card a tap on a gate push asked for, by gate id (DROVE-94).
 *
 * The index the deck will have for that gate once it is back in the deck:
 * the dismissed set is applied with the focused gate taken OUT of it, because
 * a push tap is a request to see the card whether or not it was swiped away
 * earlier. The gate is matched on the request id it was filed under as well
 * as the card id, since the push carries the bus event id and the store keys
 * the card as `${session}:${event}`. -1 when this session lists no such gate,
 * which is the case until the store has caught up after a cold start, and
 * for good once the gate has been answered elsewhere.
 */
export function focusIndex<T extends GateOverlayCard & { requestId?: string }>(
    entries: readonly T[],
    dismissed: ReadonlySet<string>,
    gateId: string,
): number {
    const matches = (entry: T) => entry.gate.id === gateId || entry.requestId === gateId;
    const cards = entries.filter((entry) => matches(entry) || !dismissed.has(entry.gate.id));
    return cards.findIndex(matches);
}

/**
 * A request to show one gate on one session's overlay, made by the session
 * route when it arrives with `?gate=` and consumed by the overlay once that
 * gate is in its deck (DROVE-94).
 *
 * Held here rather than threaded through SessionView as a prop: the overlay
 * is mounted several components down, and the same SessionView also draws in
 * a side panel that has no route of its own to read the param from. One
 * request at a time; a newer tap replaces an older one that never landed.
 */
export interface GateOverlayFocusRequest {
    sessionId: string;
    gateId: string;
}

export interface GateOverlayFocus {
    get(): GateOverlayFocusRequest | null;
    request(focus: GateOverlayFocusRequest): void;
    /** Consumed, or given up on. Only clears the request it was handed. */
    clear(focus: GateOverlayFocusRequest): void;
    subscribe(listener: () => void): () => void;
}

export function createGateOverlayFocus(): GateOverlayFocus {
    let snapshot: GateOverlayFocusRequest | null = null;
    const listeners = new Set<() => void>();
    const publish = () => { for (const listener of listeners) listener(); };
    return {
        get: () => snapshot,
        request(focus) {
            if (snapshot && snapshot.sessionId === focus.sessionId && snapshot.gateId === focus.gateId) return;
            snapshot = { sessionId: focus.sessionId, gateId: focus.gateId };
            publish();
        },
        clear(focus) {
            if (snapshot !== focus) return;
            snapshot = null;
            publish();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

export const gateOverlayFocus = createGateOverlayFocus();
