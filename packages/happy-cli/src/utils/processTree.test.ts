import { describe, expect, it } from 'vitest';

import { resolveTrackedPid } from './processTree';

// DROVE-2: a tmux spawn is tracked by the PANE pid, and the process that
// reports itself to the daemon is further down the launcher chain — the shell
// tmux started forks `bin/drover`, and `bin/drover.mjs` runs the entrypoint
// through `execFileSync`. Matching on equality alone left the awaiter hanging
// and the phone saw a webhook timeout for a session that had started fine.
describe('matching a session webhook to the spawn waiting for it', () => {
    const parents = new Map<number, number>([
        [400, 300], // node dist/index.mjs -> node bin/drover.mjs
        [300, 200], // node bin/drover.mjs -> sh running bin/drover
        [200, 100], // sh -> tmux server
    ]);
    const getParent = (pid: number) => parents.get(pid);

    it('walks up to the tracked pane pid', () => {
        expect(resolveTrackedPid(400, (pid) => pid === 200, getParent)).toBe(200);
    });

    it('returns a directly tracked pid without asking for a parent', () => {
        const asked: number[] = [];
        const spy = (pid: number) => {
            asked.push(pid);
            return getParent(pid);
        };

        expect(resolveTrackedPid(400, (pid) => pid === 400, spy)).toBe(400);
        expect(asked).toEqual([]);
    });

    it('gives the reported pid back when no ancestor is tracked', () => {
        expect(resolveTrackedPid(400, () => false, getParent)).toBe(400);
    });

    it('stops at the top of the tree instead of looping', () => {
        expect(resolveTrackedPid(400, (pid) => pid === 999, getParent)).toBe(400);
    });

    it('stops at maxDepth, so an unrelated tracked pid far above is not claimed', () => {
        expect(resolveTrackedPid(400, (pid) => pid === 100, getParent, 1)).toBe(400);
        expect(resolveTrackedPid(400, (pid) => pid === 100, getParent, 3)).toBe(100);
    });

    it('does not spin when a process reports itself as its own parent', () => {
        expect(resolveTrackedPid(7, (pid) => pid === 1234, () => 7)).toBe(7);
    });
});
