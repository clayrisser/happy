/**
 * The one mechanism that stops the navigator's swipe-back from eating a
 * horizontal drag that belongs to a control (DROVE-216).
 *
 * Why a lock and not a responder claim. The effort slider already returned
 * `false` from `onResponderTerminationRequest`, which is the strongest thing
 * the JS responder system can say, and the screen still slid sideways. That is
 * because the pop gesture is not a JS responder at all: on iOS it is UIKit's
 * `interactivePopGestureRecognizer`, living on the navigation controller, and
 * it competes with React Native's touch handler as a peer recognizer rather
 * than through it. Nothing said in JS about responders reaches it. The same is
 * true of a `pagingEnabled` ScrollView, which is a UIScrollView whose pan loses
 * to the edge recogniser at the edge. So the only thing that actually works is
 * to turn the screen's gesture off while a control owns the drag.
 *
 * The cost of that choice is the failure it invites: a hold nobody drops is a
 * screen nobody can swipe back out of, which is a worse bug than the one being
 * fixed. So every hold is dropped by five separate things, and this module owns
 * the last of them:
 *
 *   1. the control's own release or terminate,
 *   2. the component unmounting,
 *   3. the screen losing focus,
 *   4. the app leaving `active` (a call, a notification, a background),
 *   5. the watchdog here, which drops a hold that has run past `timeoutMs`.
 *
 * The first four live in `useBackSwipeLock`. This file is pure so the counting
 * and the watchdog can be tested without a navigator.
 */

/** A hold longer than this is a stuck hold, not a drag. */
export const BACK_SWIPE_LOCK_TIMEOUT_MS = 8000;

/** Writes `gestureEnabled` onto the screen. */
export type BackSwipeApply = (enabled: boolean) => void;

export interface BackSwipeLock {
    /** Take the lock. The returned release is idempotent and safe to call late. */
    acquire(): () => void;
    /** Drop every hold at once. The safety nets call this. */
    releaseAll(): void;
    /** Live holds. Read by tests; nothing else should care. */
    readonly holders: number;
    /** What was last written to the screen. */
    readonly enabled: boolean;
}

/**
 * A counted lock over one screen's `gestureEnabled`.
 *
 * `apply` is called only on the transitions, so a screen that is already
 * swipeable is not rewritten on every touch.
 */
export function createBackSwipeLock(
    apply: BackSwipeApply,
    timeoutMs: number = BACK_SWIPE_LOCK_TIMEOUT_MS,
): BackSwipeLock {
    let holders = 0;
    let enabled = true;
    // Bumped by `releaseAll`, so a handle it invalidated cannot come back later
    // and decrement a hold that a different drag has since taken.
    let generation = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const settle = () => {
        const next = holders === 0;
        if (next === enabled) return;
        enabled = next;
        apply(next);
    };

    return {
        get holders() {
            return holders;
        },
        get enabled() {
            return enabled;
        },
        acquire() {
            const mine = generation;
            let live = true;
            let timer: ReturnType<typeof setTimeout> | null = null;
            holders += 1;
            settle();
            const drop = () => {
                if (!live || mine !== generation) return;
                live = false;
                if (timer) {
                    clearTimeout(timer);
                    timers.delete(timer);
                    timer = null;
                }
                holders -= 1;
                settle();
            };
            timer = setTimeout(drop, timeoutMs);
            timers.add(timer);
            return drop;
        },
        releaseAll() {
            generation += 1;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            if (holders === 0) return;
            holders = 0;
            settle();
        },
    };
}

export interface BackSwipeLockRegistry {
    /**
     * The lock for one screen, retained on behalf of the caller. Several
     * controls on the same screen share it, so one control's release cannot
     * hand the gesture back while another is still dragging.
     */
    open(key: string, apply: BackSwipeApply): BackSwipeLock;
    /** Give the retention back. The last one out drops every hold. */
    close(key: string): void;
    /** Screens with a live lock. Read by tests. */
    readonly size: number;
}

export function createBackSwipeLockRegistry(
    timeoutMs: number = BACK_SWIPE_LOCK_TIMEOUT_MS,
): BackSwipeLockRegistry {
    const entries = new Map<string, { lock: BackSwipeLock; consumers: number }>();
    return {
        get size() {
            return entries.size;
        },
        open(key, apply) {
            const found = entries.get(key);
            if (found) {
                found.consumers += 1;
                return found.lock;
            }
            const entry = { lock: createBackSwipeLock(apply, timeoutMs), consumers: 1 };
            entries.set(key, entry);
            return entry.lock;
        },
        close(key) {
            const entry = entries.get(key);
            if (!entry) return;
            entry.consumers -= 1;
            if (entry.consumers > 0) return;
            entry.lock.releaseAll();
            entries.delete(key);
        },
    };
}
