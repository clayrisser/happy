import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    BACK_SWIPE_LOCK_TIMEOUT_MS,
    createBackSwipeLock,
    createBackSwipeLockRegistry,
} from './backSwipeLock';

function recorder() {
    const writes: boolean[] = [];
    return { writes, apply: (enabled: boolean) => writes.push(enabled) };
}

describe('back swipe lock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test('a drag turns the screen gesture off and a release turns it back on', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        const release = lock.acquire();
        expect(writes).toEqual([false]);
        expect(lock.enabled).toBe(false);

        release();
        expect(writes).toEqual([false, true]);
        expect(lock.enabled).toBe(true);
    });

    test('the screen is not rewritten when nothing changed', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        const first = lock.acquire();
        const second = lock.acquire();
        first();

        // Still held by the second drag, so nothing was handed back yet.
        expect(writes).toEqual([false]);
        expect(lock.holders).toBe(1);

        second();
        expect(writes).toEqual([false, true]);
    });

    test('releasing twice does not hand the gesture back early', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        const first = lock.acquire();
        const second = lock.acquire();
        first();
        first();
        first();

        expect(lock.holders).toBe(1);
        expect(writes).toEqual([false]);

        second();
        expect(lock.holders).toBe(0);
        expect(writes).toEqual([false, true]);
    });

    test('a drag interrupted by a background restores the gesture', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        lock.acquire();
        lock.releaseAll();

        expect(lock.holders).toBe(0);
        expect(lock.enabled).toBe(true);
        expect(writes).toEqual([false, true]);
    });

    test('a stale handle from before an interruption cannot unbalance the next drag', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        const stale = lock.acquire();
        lock.releaseAll();
        const fresh = lock.acquire();
        stale();

        expect(lock.holders).toBe(1);
        expect(lock.enabled).toBe(false);

        fresh();
        expect(lock.holders).toBe(0);
        expect(writes).toEqual([false, true, false, true]);
    });

    test('releaseAll on an idle lock writes nothing', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        lock.releaseAll();

        expect(writes).toEqual([]);
        expect(lock.enabled).toBe(true);
    });

    test('the watchdog drops a hold nobody released', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        lock.acquire();
        vi.advanceTimersByTime(BACK_SWIPE_LOCK_TIMEOUT_MS - 1);
        expect(lock.enabled).toBe(false);

        vi.advanceTimersByTime(1);
        expect(lock.holders).toBe(0);
        expect(lock.enabled).toBe(true);
        expect(writes).toEqual([false, true]);
    });

    test('a released hold does not fire the watchdog later', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        const first = lock.acquire();
        first();
        const second = lock.acquire();
        vi.advanceTimersByTime(BACK_SWIPE_LOCK_TIMEOUT_MS * 2);

        expect(writes).toEqual([false, true, false, true]);
        expect(lock.holders).toBe(0);
        void second;
    });

    test('releaseAll cancels the watchdog', () => {
        const { writes, apply } = recorder();
        const lock = createBackSwipeLock(apply);

        lock.acquire();
        lock.releaseAll();
        vi.advanceTimersByTime(BACK_SWIPE_LOCK_TIMEOUT_MS * 2);

        expect(writes).toEqual([false, true]);
    });
});

describe('back swipe lock registry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test('two controls on one screen share a lock', () => {
        const { writes, apply } = recorder();
        const registry = createBackSwipeLockRegistry();

        const slider = registry.open('session-1', apply);
        const deck = registry.open('session-1', apply);
        expect(slider).toBe(deck);

        const sliderHold = slider.acquire();
        const deckHold = deck.acquire();
        sliderHold();

        expect(writes).toEqual([false]);
        deckHold();
        expect(writes).toEqual([false, true]);
    });

    test('two screens do not share a lock', () => {
        const session = recorder();
        const settings = recorder();
        const registry = createBackSwipeLockRegistry();

        registry.open('session-1', session.apply).acquire();

        expect(settings.writes).toEqual([]);
        expect(registry.open('settings-1', settings.apply).enabled).toBe(true);
    });

    test('the last control off the screen drops the entry and the holds with it', () => {
        const { writes, apply } = recorder();
        const registry = createBackSwipeLockRegistry();

        const lock = registry.open('session-1', apply);
        registry.open('session-1', apply);
        lock.acquire();

        registry.close('session-1');
        expect(registry.size).toBe(1);
        expect(lock.enabled).toBe(false);

        registry.close('session-1');
        expect(registry.size).toBe(0);
        expect(writes).toEqual([false, true]);
    });

    test('closing a screen that was never opened is a no-op', () => {
        const registry = createBackSwipeLockRegistry();

        registry.close('nothing');

        expect(registry.size).toBe(0);
    });
});
