import { statSync } from 'fs';
import { join } from 'path';

import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { TrackedSession } from './types';

/**
 * A session that is merely BUILDING is not a failed spawn.
 *
 * DROVE-65, and the same cost seen from the other side in DROVE-2. `bin/drover`
 * rebuilds this CLI when its sources moved, and holds `.drover-build.lock` — a
 * directory, because mkdir is the atomic primitive a POSIX shell has — in the
 * package root for as long as it does. A clean build measured 6.4s against the
 * 15 seconds the daemon allows a spawned session to report itself, and a
 * session that arrives second waits on another drover's build for however long
 * that takes. Either way the phone was told "Session webhook timeout" for a
 * session that was going to arrive perfectly well.
 *
 * So the awaiter's clock does not run while that lock is held. It costs one
 * stat per tick when no build is going, which after DROVE-65 is the normal
 * case: an unchanged source tree does not build at all.
 */
export const droverBuildLockPath = join(projectPath(), '.drover-build.lock');

export function droverBuildRunning(): boolean {
    try {
        return statSync(droverBuildLockPath).isDirectory();
    } catch {
        return false;
    }
}

export interface AwaitSessionWebhookOptions {
    /** Time the session gets to report itself, NOT counting time spent building. */
    budgetMs?: number;
    /**
     * Absolute stop, so a build that never finishes cannot hold a spawn request
     * open forever. Matches the 300s bin/drover itself waits on another
     * process's build lock.
     */
    ceilingMs?: number;
    tickMs?: number;
    /** Injectable so the tests can drive the build window without a real lock. */
    isBuilding?: () => boolean;
}

/**
 * Wait for a spawned session's webhook, pausing the timeout while a drover
 * build holds the lock. Resolves success with the session id, or an error that
 * says which of the two it was.
 */
export function awaitSessionWebhook(
    pid: number,
    pidToAwaiter: Map<number, (session: TrackedSession) => void>,
    label: string,
    opts: AwaitSessionWebhookOptions = {},
): Promise<SpawnSessionResult> {
    const budgetMs = opts.budgetMs ?? 15_000;
    const ceilingMs = opts.ceilingMs ?? 300_000;
    const tickMs = opts.tickMs ?? 250;
    const isBuilding = opts.isBuilding ?? droverBuildRunning;

    return new Promise((resolve) => {
        const startedAt = Date.now();
        let remaining = budgetMs;
        let waitedOnBuild = false;

        const timer = setInterval(() => {
            if (isBuilding() && Date.now() - startedAt < ceilingMs) {
                waitedOnBuild = true;
                return;
            }
            remaining -= tickMs;
            if (remaining > 0) return;
            clearInterval(timer);
            pidToAwaiter.delete(pid);
            logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid}${label}`);
            resolve({
                type: 'error',
                errorMessage: waitedOnBuild
                    ? `The session did not report itself within ${budgetMs / 1000}s${label}, and a drover build of the CLI was running for part of that wait. `
                    + 'Check the build: drover status.'
                    : `Session webhook timeout for PID ${pid}${label}`,
            });
        }, tickMs);

        pidToAwaiter.set(pid, (completedSession) => {
            clearInterval(timer);
            logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook${label}`);
            resolve({
                type: 'success',
                sessionId: completedSession.happySessionId!,
            });
        });
    });
}
