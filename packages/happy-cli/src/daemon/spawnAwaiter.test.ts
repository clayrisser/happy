import { describe, expect, it, vi } from 'vitest';

import { awaitSessionWebhook } from './spawnAwaiter';
import type { TrackedSession } from './types';

// DROVE-65 (and DROVE-2 from the other side): a phone-started session that is
// merely BUILDING is not a failed spawn. bin/drover rebuilds the fork CLI when
// its sources moved and holds .drover-build.lock while it does; a clean build
// measured 6.4s against this awaiter's 15s budget, so anything slower reported
// the phone's session as "Session webhook timeout" when it was going to arrive
// perfectly well.
describe('the daemon waiting for a spawned session to report itself', () => {
    const never = () => false;

    /**
     * Count the awaiter's ticks instead of sleeping through them (DROVE-68).
     *
     * `isBuilding` is asked exactly once per tick, so wrapping it turns the
     * code under test into its own clock: "the budget has been spent" becomes
     * a number this test can wait for, rather than a duration it hopes is long
     * enough. Under load a sleep is neither. It can be short of the ticks it
     * was standing in for, or so long that the thing it meant to catch has
     * already been and gone.
     */
    function ticker(building: () => boolean) {
        let ticks = 0;
        return {
            isBuilding: () => { ticks += 1; return building(); },
            /** Wait until the interval has fired at least `n` times. */
            after: async (n: number) => {
                await vi.waitFor(() => {
                    if (ticks < n) throw new Error(`waited for ${n} tick(s), saw ${ticks}`);
                }, { timeout: 4_000, interval: 5 });
            },
            count: () => ticks,
        };
    }

    it('resolves success as soon as the webhook lands', async () => {
        const awaiters = new Map<number, (s: TrackedSession) => void>();
        const promise = awaitSessionWebhook(42, awaiters, '', {
            budgetMs: 500,
            tickMs: 10,
            isBuilding: never,
        });
        awaiters.get(42)!({ happySessionId: 'sess-1' } as TrackedSession);
        await expect(promise).resolves.toEqual({ type: 'success', sessionId: 'sess-1' });
    });

    it('times out on its budget when nothing is building', async () => {
        const awaiters = new Map<number, (s: TrackedSession) => void>();
        const tick = ticker(never);
        const result = await awaitSessionWebhook(43, awaiters, ' (tmux)', {
            budgetMs: 200,
            tickMs: 10,
            isBuilding: tick.isBuilding,
        });
        expect(result.type).toBe('error');
        // The budget is spent, not exceeded: 200ms of budget at 10ms a tick is
        // twenty ticks and not one more. Counted rather than timed, because a
        // wall-clock bound on a loaded box measures the box.
        expect(tick.count()).toBe(20);
        expect(awaiters.has(43)).toBe(false);
    });

    it('does NOT time out while a drover build holds the lock', async () => {
        const awaiters = new Map<number, (s: TrackedSession) => void>();
        let building = true;
        const tick = ticker(() => building);
        const promise = awaitSessionWebhook(44, awaiters, '', {
            budgetMs: 100,
            tickMs: 10,
            isBuilding: tick.isBuilding,
        });

        // Forty ticks is four times the budget, and it is still waiting,
        // because the build is what is holding things up, which is exactly
        // what used to be misreported.
        let settled = false;
        void promise.then(() => { settled = true; });
        await tick.after(40);
        expect(settled).toBe(false);

        // The build finishes and the session reports itself.
        building = false;
        awaiters.get(44)!({ happySessionId: 'sess-2' } as TrackedSession);
        await expect(promise).resolves.toEqual({ type: 'success', sessionId: 'sess-2' });
    });

    it('says the build was running when it does eventually give up', async () => {
        const awaiters = new Map<number, (s: TrackedSession) => void>();
        let building = true;
        const tick = ticker(() => building);
        const promise = awaitSessionWebhook(45, awaiters, ' (tmux)', {
            budgetMs: 100,
            tickMs: 10,
            isBuilding: tick.isBuilding,
        });
        // Twice the budget's worth of ticks spent on the build, then it ends.
        await tick.after(20);
        building = false;
        const result = await promise;
        expect(result.type).toBe('error');
        expect(result.type === 'error' && result.errorMessage).toContain('drover build');
        expect(result.type === 'error' && result.errorMessage).toContain('drover status');
    });

    it('gives up at the ceiling even if the build never finishes', async () => {
        const awaiters = new Map<number, (s: TrackedSession) => void>();
        const started = Date.now();
        const result = await awaitSessionWebhook(46, awaiters, '', {
            budgetMs: 50,
            ceilingMs: 150,
            tickMs: 10,
            isBuilding: () => true,
        });
        expect(result.type).toBe('error');
        // A build that hangs must not hold a spawn request open forever, and
        // it says so on the way out.
        expect(result.type === 'error' && result.errorMessage).toContain('drover build');
        // The one wall clock left in this file, because the ceiling IS one:
        // `Date.now() - startedAt` in the code under test. Nothing here waits
        // on this number; it only has to be finite, and 2s against a 150ms
        // ceiling is not a duration anything is hoping about.
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});
