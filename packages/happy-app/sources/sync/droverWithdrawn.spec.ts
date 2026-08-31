import { beforeEach, describe, expect, it, vi } from 'vitest';

// storage.ts pulls in React Native, and the collector only touches it for its
// default argument. Every test below passes sessions explicitly.
vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
}));

import { createWithdrawnGates, withdrawnGates, withoutWithdrawn } from './droverWithdrawn';
import { collectGateEntries, inboxCounts } from './droverGates';

const entry = (id: string, requestId: string) => ({ gate: { id }, requestId });

describe('a withdrawal is remembered until the app is relaunched', () => {
    it('holds what it was given', () => {
        const gates = createWithdrawnGates();
        gates.withdraw(['a', 'b']);
        expect([...gates.get()].sort()).toEqual(['a', 'b']);
    });

    it('publishes once for a real change and not at all for a repeat', () => {
        const gates = createWithdrawnGates();
        const listener = vi.fn();
        gates.subscribe(listener);
        gates.withdraw(['a']);
        gates.withdraw(['a']);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('keeps its snapshot identity when nothing changed, so a deep-equal read publishes nothing', () => {
        const gates = createWithdrawnGates();
        gates.withdraw(['a']);
        const before = gates.get();
        gates.withdraw(['a']);
        expect(gates.get()).toBe(before);
    });

    it('forgets everything on reset, which is what a relaunch does — a genuinely pending prompt comes back', () => {
        const gates = createWithdrawnGates();
        gates.withdraw(['a']);
        gates.reset();
        expect(gates.get().size).toBe(0);
    });
});

describe('a withdrawn card is gone from every surface, not just the one he was looking at', () => {
    it('drops it by the packed card id', () => {
        const list = [entry('sess:ev-1', 'ev-1'), entry('sess:ev-2', 'ev-2')];
        expect(withoutWithdrawn(list, new Set(['sess:ev-1']))).toEqual([list[1]]);
    });

    it('drops it by the bus event id too, because a push carries that one', () => {
        const list = [entry('sess:ev-1', 'ev-1'), entry('sess:ev-2', 'ev-2')];
        expect(withoutWithdrawn(list, new Set(['ev-1']))).toEqual([list[1]]);
    });

    it('returns the same array when nothing is withdrawn, so no surface re-renders for free', () => {
        const list = [entry('sess:ev-1', 'ev-1')];
        expect(withoutWithdrawn(list, new Set())).toBe(list);
    });
});

/**
 * The collector is where the filter lives, so the inbox, the in-session
 * overlay, the longhorn counts and the wrist feed all agree the instant the
 * card is withdrawn (DROVE-218).
 */
describe('the collector honours a withdrawal', () => {
    const sessions = {
        bridge: {
            agentState: {
                requests: {
                    'ev-1': { tool: 'Bash', arguments: { command: 'rm -rf x' } },
                    'ev-2': { tool: 'Bash', arguments: { command: 'ls' } },
                },
            },
        },
    };

    beforeEach(() => { withdrawnGates.reset(); });

    it('lists both while nothing is withdrawn', () => {
        expect(collectGateEntries(sessions)).toHaveLength(2);
    });

    it('drops the withdrawn one from the list', () => {
        withdrawnGates.withdraw(['bridge:ev-1']);
        expect(collectGateEntries(sessions).map((e) => e.requestId)).toEqual(['ev-2']);
    });

    it('drops it from the counts the longhorn shows, not only from the list', () => {
        withdrawnGates.withdraw(['bridge:ev-1']);
        expect(inboxCounts(collectGateEntries(sessions))).toEqual({ prompts: 1, todos: 0, total: 1 });
    });
});
