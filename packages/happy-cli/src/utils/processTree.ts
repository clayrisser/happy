/**
 * Walk a process's ancestors (DROVE-2).
 *
 * The daemon matches a session's `/session-started` webhook to the spawn that
 * is waiting for it by PID (`daemon/run.ts` `pidToAwaiter`). That works for a
 * direct spawn, where the daemon holds the child's own pid, and it does NOT
 * work for a tmux spawn: `new-window -P -F '#{pane_pid}'` reports the pid of
 * the SHELL tmux started, and the process that reports itself is two hops
 * further down — `sh -c` forks `bin/drover`, and `bin/drover.mjs` runs the
 * real entrypoint through `execFileSync`.
 *
 * Measured here: `/bin/sh -c 'unset A; cmd'` and `/bin/bash -c` both fork, and
 * only `/bin/zsh` execs in place, so which shell tmux happens to use decides
 * whether the pids line up. Depending on that is how a spawn from the phone
 * silently becomes a 15-second webhook timeout on a session that started fine.
 */

import { execFileSync } from 'node:child_process';

/** The parent of `pid`, or undefined when it cannot be read or is init. */
export function readParentPid(pid: number): number | undefined {
    if (process.platform === 'win32') return undefined;
    try {
        const output = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
            encoding: 'utf-8',
            timeout: 2_000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const parsed = Number.parseInt(output.trim(), 10);
        return Number.isFinite(parsed) && parsed > 1 ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The pid the daemon is tracking for a process that just reported itself.
 *
 * Returns `reportedPid` unchanged when it is tracked directly, otherwise the
 * nearest tracked ancestor, otherwise `reportedPid` again so the caller's
 * "unknown session" branch still runs. `maxDepth` is small on purpose: a
 * session's launcher chain is two or three processes, and a long walk would
 * only widen the window in which an unrelated tracked pid could be claimed.
 */
export function resolveTrackedPid(
    reportedPid: number,
    isTracked: (pid: number) => boolean,
    getParent: (pid: number) => number | undefined = readParentPid,
    maxDepth = 6,
): number {
    if (isTracked(reportedPid)) return reportedPid;

    let current = reportedPid;
    for (let depth = 0; depth < maxDepth; depth++) {
        const parent = getParent(current);
        if (parent === undefined || parent === current) return reportedPid;
        if (isTracked(parent)) return parent;
        current = parent;
    }
    return reportedPid;
}
