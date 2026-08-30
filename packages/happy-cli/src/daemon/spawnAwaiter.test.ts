import { describe, expect, it } from 'vitest';

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
        const started = Date.now();
        const result = await awaitSessionWebhook(43, awaiters, ' (tmux)', {
            budgetMs: 200,
            tickMs: 10,
            isBuilding: never,
        });
        expect(result.type).toBe('error');
        // The budget is spent, not exceeded by much: nothing paused the clock.
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(awaiters.has(43)).toBe(false);
    });

    it('does NOT time out while a drover build holds the lock', async () => {
        const awaiters = new Map<number, (s: TrackedSession) => void>();
        let building = true;
        const promise = awaitSessionWebhook(44, awaiters, '', {
            budgetMs: 100,
            tickMs: 10,
            isBuilding: () => building,
        });

        // Well past the budget, and still waiting — because the build is what
        // is holding things up, which is exactly what used to be misreported.
        let settled = false;
        void promise.then(() => { settled = true; });
        await new Promise(r => setTimeout(r, 400));
        expect(settled).toBe(false);

        // The build finishes and the session reports itself.
        building = false;
        awaiters.get(44)!({ happySessionId: 'sess-2' } as TrackedSession);
        await expect(promise).resolves.toEqual({ type: 'success', sessionId: 'sess-2' });
    });

    it('says the build was running when it does eventually give up', async () => {
        const awaiters = new Map<number, (s: TrackedSession) => void>();
        let building = true;
        const promise = awaitSessionWebhook(45, awaiters, ' (tmux)', {
            budgetMs: 100,
            tickMs: 10,
            isBuilding: () => building,
        });
        await new Promise(r => setTimeout(r, 200));
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
        // A build that hangs must not hold a spawn request open forever.
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});
