import { describe, expect, it, vi } from 'vitest';

// storage.ts pulls in React Native, and this module only touches it for the
// default argument. Every test below passes sessions explicitly.
vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
}));

import {
    collectGateEntries,
    collectGates,
    gatesForSession,
    previewFor,
    optionsFor,
    sortGateEntries,
    titleFor,
    type GateSession,
} from './droverGates';
import { memoizeDeepEqual } from './storeSelectors';

function session(options: {
    path?: string;
    summary?: string;
    account?: string;
    claudeSessionId?: string;
    requests?: Record<string, unknown>;
}): GateSession {
    return {
        agentState: options.requests ? { requests: options.requests } : undefined,
        metadata: {
            path: options.path,
            summary: options.summary ? { text: options.summary } : undefined,
            droverAccount: options.account,
            claudeSessionId: options.claudeSessionId,
        },
    };
}

describe('titleFor / previewFor', () => {
    it('titles a question with its own header and previews the question body', () => {
        const args = { questions: [{ header: 'Flip?', question: 'Move this session to work-2?' }] };
        expect(titleFor('AskUserQuestion', args)).toBe('Flip?');
        expect(previewFor('AskUserQuestion', args)).toBe('Move this session to work-2?');
    });

    it('falls back to "Question" when the card carries no header', () => {
        expect(titleFor('AskUserQuestion', { questions: [{ question: 'Proceed?' }] })).toBe('Question');
    });

    it('leaves a permission gate on the tool name and the command', () => {
        expect(titleFor('Bash', { command: 'ls' })).toBe('Run Bash');
        expect(previewFor('Bash', { command: 'ls' })).toBe('ls');
    });

    it('truncates a preview past the wrist limit', () => {
        const preview = previewFor('Bash', { command: 'x'.repeat(500) });
        expect(preview).toHaveLength(241);
        expect(preview.endsWith('…')).toBe(true);
    });
});

describe('collectGateEntries', () => {
    it('carries the keys an answer needs beside the gate', () => {
        const args = { questions: [{ header: 'Flip?', question: 'Move it?', options: [{ label: 'Yes' }] }] };
        const entries = collectGateEntries({
            s1: session({ path: '/a/work', requests: { 'agent7:tool9': { tool: 'AskUserQuestion', createdAt: 0, arguments: args } } }),
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].sessionId).toBe('s1');
        // Split on the FIRST colon only, so a subagent-scoped request id
        // survives being packed into the gate id and unpacked here.
        expect(entries[0].requestId).toBe('agent7:tool9');
        expect(entries[0].tool).toBe('AskUserQuestion');
        expect(entries[0].args).toBe(args);
        expect(entries[0].gate.id).toBe('s1:agent7:tool9');
        expect(entries[0].gate.kind).toBe('question');
    });

    it('omits the account key entirely rather than sending null', () => {
        const [entry] = collectGateEntries({
            s1: session({ requests: { req1: { tool: 'Bash', createdAt: 0, arguments: {} } } }),
        });
        expect('account' in entry.gate).toBe(false);
    });

    it('prefers the session summary over its path for the reason line', () => {
        const [withSummary] = collectGateEntries({
            s1: session({ path: '/a/work', summary: 'Fixing the bus', requests: { r: { tool: 'Bash', createdAt: 0 } } }),
        });
        const [withoutSummary] = collectGateEntries({
            s1: session({ path: '/a/work', requests: { r: { tool: 'Bash', createdAt: 0 } } }),
        });
        expect(withSummary.gate.reason).toBe('Fixing the bus');
        expect(withoutSummary.gate.reason).toBe('/a/work');
    });

    it('skips sessions holding no requests', () => {
        expect(collectGateEntries({ s1: session({ path: '/a' }), s2: undefined })).toEqual([]);
    });
});

describe('collectGates', () => {
    it('is exactly the gates out of collectGateEntries', () => {
        const sessions = {
            s1: session({ requests: { r1: { tool: 'Bash', createdAt: 0, arguments: { command: 'ls' } } } }),
            s2: session({ requests: { r2: { tool: 'Edit', createdAt: 0, arguments: { file_path: '/a.ts' } } } }),
        };
        expect(collectGates(sessions)).toEqual(collectGateEntries(sessions).map((e) => e.gate));
        expect(collectGates(sessions).map((g) => g.id)).toEqual(['s1:r1', 's2:r2']);
    });
});

describe('sortGateEntries', () => {
    it('puts the longest-waiting gate first', () => {
        const entries = collectGateEntries({
            s1: session({ requests: { newer: { tool: 'Bash', createdAt: 2000, arguments: {} } } }),
            s2: session({ requests: { older: { tool: 'Bash', createdAt: 1000, arguments: {} } } }),
        });
        expect(sortGateEntries(entries).map((e) => e.requestId)).toEqual(['older', 'newer']);
    });

    it('breaks a tie on the gate id, so the list does not shuffle under a tap', () => {
        const entries = collectGateEntries({
            b: session({ requests: { r: { tool: 'Bash', createdAt: 5, arguments: {} } } }),
            a: session({ requests: { r: { tool: 'Bash', createdAt: 5, arguments: {} } } }),
        });
        expect(sortGateEntries(entries).map((e) => e.gate.id)).toEqual(['a:r', 'b:r']);
    });

    it('leaves the input array alone', () => {
        const entries = collectGateEntries({
            s1: session({ requests: { newer: { tool: 'Bash', createdAt: 2000, arguments: {} } } }),
            s2: session({ requests: { older: { tool: 'Bash', createdAt: 1000, arguments: {} } } }),
        });
        sortGateEntries(entries);
        expect(entries.map((e) => e.requestId)).toEqual(['newer', 'older']);
    });
});

/**
 * usePendingGates reads this selector through `useDeepEqual`. Shallow would not
 * do: every entry here is a freshly minted object, so shallow compares them by
 * identity, reports a change on every read, and zustand's useSyncExternalStore
 * re-renders — which reads again. That is the "Maximum update depth exceeded"
 * loop storeSelectors documents, and it only bites once a gate is pending,
 * which is exactly when this screen matters.
 */
describe('the selector usePendingGates memoizes', () => {
    const select = (state: { sessions: Record<string, GateSession | undefined> }) =>
        sortGateEntries(collectGateEntries(state.sessions));

    it('returns the SAME array identity while the store has not moved', () => {
        const memoized = memoizeDeepEqual(select, { current: undefined });
        const state = {
            sessions: { s1: session({ requests: { r1: { tool: 'Bash', createdAt: 0, arguments: { command: 'ls' } } } }) },
        };
        expect(memoized(state)).toBe(memoized(state));
    });

    it('returns a new identity once a gate actually arrives', () => {
        const memoized = memoizeDeepEqual(select, { current: undefined });
        const before = memoized({ sessions: {} });
        const after = memoized({
            sessions: { s1: session({ requests: { r1: { tool: 'Bash', createdAt: 0, arguments: {} } } }) },
        });
        expect(after).not.toBe(before);
        expect(after).toHaveLength(1);
    });
});

describe('a gate whose CLI never stamped createdAt', () => {
    // Fake timers, not two back-to-back real reads: those land in the same
    // millisecond and the test passes whether or not the fix is there.
    it('keeps ONE timestamp instead of minting a fresh now on every read', () => {
        vi.useFakeTimers();
        try {
            const sessions = { s1: session({ requests: { r1: { tool: 'Bash', arguments: {} } } }) };
            const first = collectGateEntries(sessions)[0].gate.createdAt;
            vi.advanceTimersByTime(5000);
            expect(collectGateEntries(sessions)[0].gate.createdAt).toBe(first);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles under the memoized selector, which is the render loop this prevents', () => {
        vi.useFakeTimers();
        try {
            const memoized = memoizeDeepEqual(
                (state: { sessions: Record<string, GateSession | undefined> }) => collectGateEntries(state.sessions),
                { current: undefined },
            );
            const state = { sessions: { s1: session({ requests: { r1: { tool: 'Bash', arguments: {} } } }) } };
            const first = memoized(state);
            vi.advanceTimersByTime(5000);
            expect(memoized(state)).toBe(first);
        } finally {
            vi.useRealTimers();
        }
    });

    it('forgets a gate once it is answered, so the map cannot grow forever', () => {
        collectGateEntries({ s1: session({ requests: { gone: { tool: 'Bash', arguments: {} } } }) });
        collectGateEntries({});
        // Re-arriving under the same id means it was pruned and re-clocked, not
        // resurrected with the old timestamp.
        const again = collectGateEntries({ s1: session({ requests: { gone: { tool: 'Bash', arguments: {} } } }) });
        expect(again).toHaveLength(1);
    });
});

/**
 * Parity with droverWatchFeed's own collectGates, which still carries a copy of
 * this logic (its owner was mid-edit adding options when this module landed).
 * These tests are what makes the copy safe to delete.
 */
describe('optionsFor', () => {
    it('carries a label-only card through, since happy-cli drops the bus option ids', () => {
        const args = { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
        expect(optionsFor(args)).toEqual([{ label: 'Yes' }, { label: 'No' }]);
        expect(collectGateEntries({
            s1: session({ requests: { r1: { tool: 'AskUserQuestion', createdAt: 0, arguments: args } } }),
        })[0].gate.options).toEqual([{ label: 'Yes' }, { label: 'No' }]);
    });

    it('keeps an id and a description when the card actually has them', () => {
        expect(optionsFor({ questions: [{ options: [{ id: 'opt1', label: 'Yes', description: 'do it' }] }] }))
            .toEqual([{ label: 'Yes', id: 'opt1', description: 'do it' }]);
    });

    it('drops an option with no label, which nothing could answer with', () => {
        expect(optionsFor({ questions: [{ options: [{ id: 'a' }, null, 'nope', { label: 'Yes' }] }] }))
            .toEqual([{ label: 'Yes' }]);
    });

    it('leaves the key off a gate with no options rather than sending an empty array', () => {
        const [entry] = collectGateEntries({
            s1: session({ requests: { r1: { tool: 'Bash', createdAt: 0, arguments: { command: 'ls' } } } }),
        });
        expect('options' in entry.gate).toBe(false);
    });
});

describe('gatesForSession', () => {
    const sessions: Record<string, GateSession> = {
        watched: session({
            path: '~/work',
            requests: {
                'req-1': {
                    tool: 'AskUserQuestion',
                    createdAt: 200,
                    arguments: {
                        questions: [{
                            header: 'Flip?',
                            question: 'Move this session to work-2?',
                            options: [{ label: 'Yes' }, { label: 'Stay here' }],
                        }],
                    },
                },
                'req-0': { tool: 'Bash', createdAt: 100, arguments: { command: 'ls' } },
            },
        }),
        other: session({
            path: '~/elsewhere',
            requests: {
                'req-9': { tool: 'Bash', createdAt: 50, arguments: { command: 'rm -rf /' } },
            },
        }),
    };

    it('returns only the gates raised by the session asked for', () => {
        const entries = gatesForSession(sessions, 'watched');
        expect(entries.map((entry) => entry.gate.id)).toEqual(['watched:req-0', 'watched:req-1']);
        expect(entries.every((entry) => entry.sessionId === 'watched')).toBe(true);
    });

    // The screen renders entries[0]. A different session's prompt reaching it
    // would hijack the view the user is on, which is worse than the walk to the
    // gates list — several sessions running at once is the normal case here.
    it('never leaks another session\'s gate, even the oldest one', () => {
        const ids = gatesForSession(sessions, 'watched').map((entry) => entry.gate.id);
        expect(ids).not.toContain('other:req-9');
    });

    it('is empty for a session with no requests, and for one that is not there', () => {
        expect(gatesForSession(sessions, 'missing')).toEqual([]);
        expect(gatesForSession({ quiet: session({ path: '~/quiet' }) }, 'quiet')).toEqual([]);
    });

    it('puts the longest-waiting gate first, so the screen presents what is holding the session up', () => {
        expect(gatesForSession(sessions, 'watched')[0].gate.id).toBe('watched:req-0');
    });
});

/**
 * A pane session's prompts never reach its own agentState (DROVE-19).
 *
 * The PreToolUse hook publishes to the bus and the bridge mirrors every local
 * agent's gate into ONE bridge session per machine, so the session Clay was
 * watching held nothing and the only copy was on the home screen. These are
 * the fixtures the live bus produces: two lanes of the same checkout, each a
 * separate Claude session uuid, both mirrored into 'bridge'.
 */
describe('gatesForSession, for a gate the bridge mirrored', () => {
    const checkout = '/Users/clay/Projects/bitspur/cattle-drover';
    const sessions: Record<string, GateSession> = {
        bridge: session({
            path: checkout,
            requests: {
                'ev-a': {
                    tool: 'AskUserQuestion',
                    createdAt: 100,
                    droverOrigin: { sessionId: 'claude-a', cwd: checkout },
                    arguments: {
                        questions: [{
                            header: 'DROVE-50',
                            question: 'Who owns the picker?',
                            options: [{ label: 'Drover owns it' }, { label: 'Claude owns it' }],
                        }],
                    },
                },
                'ev-b': {
                    tool: 'Bash',
                    createdAt: 200,
                    droverOrigin: { sessionId: 'claude-b', cwd: checkout },
                    arguments: { command: 'rm -rf build' },
                },
            },
        }),
        paneA: session({ path: checkout, claudeSessionId: 'claude-a' }),
        paneB: session({ path: checkout, claudeSessionId: 'claude-b' }),
        paneNoClaude: session({ path: checkout }),
    };

    it('presents the prompt on the session that raised it', () => {
        expect(gatesForSession(sessions, 'paneA').map((entry) => entry.gate.id)).toEqual(['bridge:ev-a']);
    });

    // The answer goes to whoever HOLDS the card, which is the bridge. Sending
    // it to the session on screen would reach an agent that never asked.
    it('keeps the answer addressed to the bridge session that holds the card', () => {
        const entry = gatesForSession(sessions, 'paneA')[0];
        expect(entry.sessionId).toBe('bridge');
        expect(entry.requestId).toBe('ev-a');
    });

    // Two lanes, one checkout, which is the normal case here. Matching on cwd
    // would drop lane A's question onto lane B's screen.
    it('never puts one lane\'s prompt on another lane\'s screen, same cwd or not', () => {
        expect(gatesForSession(sessions, 'paneB').map((entry) => entry.gate.id)).toEqual(['bridge:ev-b']);
    });

    // Both undefined must not compare equal: an older CLI sends no origin, and
    // a session that never recorded a Claude id would otherwise inherit it.
    it('gives a session with no Claude session id nothing at all', () => {
        expect(gatesForSession({
            ...sessions,
            bridge: session({
                path: checkout,
                requests: { 'ev-old': { tool: 'Bash', createdAt: 1, arguments: { command: 'ls' } } },
            }),
        }, 'paneNoClaude')).toEqual([]);
    });

    // The bridge session is the drover thread. Routing a gate to its origin
    // must not take it away from the one screen that shows every gate.
    it('still shows both on the bridge session itself', () => {
        expect(gatesForSession(sessions, 'bridge').map((entry) => entry.gate.id))
            .toEqual(['bridge:ev-a', 'bridge:ev-b']);
    });

    it('folds a session\'s own request in with the mirrored one, oldest first', () => {
        const withOwn = {
            ...sessions,
            paneA: session({
                path: checkout,
                claudeSessionId: 'claude-a',
                requests: { own: { tool: 'Bash', createdAt: 50, arguments: { command: 'ls' } } },
            }),
        };
        expect(gatesForSession(withOwn, 'paneA').map((entry) => entry.gate.id))
            .toEqual(['paneA:own', 'bridge:ev-a']);
    });

    // Collecting over a one-session map made collectGateEntries believe every
    // other session's gate had gone away, which evicted them from the
    // first-seen map and re-clocked them on the next global read. A createdAt
    // that moves is the render/read loop that map exists to stop.
    it('does not re-clock another session\'s unstamped gate on the way past', () => {
        vi.useFakeTimers();
        try {
            const unstamped = {
                paneA: session({ path: checkout, claudeSessionId: 'claude-a' }),
                noisy: session({ path: '~/elsewhere', requests: { r: { tool: 'Bash', arguments: {} } } }),
            };
            const before = collectGateEntries(unstamped)[0].gate.createdAt;
            gatesForSession(unstamped, 'paneA');
            vi.advanceTimersByTime(5000);
            expect(collectGateEntries(unstamped)[0].gate.createdAt).toBe(before);
        } finally {
            vi.useRealTimers();
        }
    });
});
