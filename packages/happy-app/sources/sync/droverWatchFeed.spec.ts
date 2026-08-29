import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DroverSnapshot } from 'drover-watch';

const mocks = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    allow: vi.fn(),
    deny: vi.fn(),
    sendMessage: vi.fn(),
    published: [] as DroverSnapshot[],
    onAnswer: null as ((event: { id: string; allow: boolean; optionId?: string }) => void) | null,
    onFlip: null as ((event: { sessionId: string; account?: string }) => void) | null,
    onStorage: null as (() => void) | null,
}));

// storage.ts pulls in React Native, ops.ts the socket and sync.ts the whole
// client, so each is stubbed down to the surface the feed actually touches.
vi.mock('./storage', () => ({
    storage: {
        getState: () => ({ sessions: mocks.sessions }),
        subscribe: (listener: () => void) => {
            mocks.onStorage = listener;
            return () => { mocks.onStorage = null; };
        },
    },
}));

vi.mock('./sync', () => ({
    sync: { sendMessage: (...args: unknown[]) => mocks.sendMessage(...args) },
}));

vi.mock('./ops', () => ({
    sessionAllow: (...args: unknown[]) => { mocks.allow(...args); return Promise.resolve(); },
    sessionDeny: (...args: unknown[]) => { mocks.deny(...args); return Promise.resolve(); },
}));

vi.mock('drover-watch', () => ({
    isDroverWatchAvailable: () => true,
    getDroverWatchStatus: () => ({
        supported: true, activated: true, paired: true, installed: true, reachable: true,
    }),
    publishDroverSnapshot: (snapshot: DroverSnapshot) => {
        mocks.published.push(snapshot);
        return Promise.resolve(true);
    },
    addDroverAnswerListener: (listener: typeof mocks.onAnswer) => {
        mocks.onAnswer = listener;
        return { remove: () => { mocks.onAnswer = null; } };
    },
    addDroverFlipListener: (listener: typeof mocks.onFlip) => {
        mocks.onFlip = listener;
        return { remove: () => { mocks.onFlip = null; } };
    },
}));

import { collectAccounts, collectGates, collectSessions, startDroverWatchFeed } from './droverWatchFeed';

/** Only the fields the feed reads; the real sessions are built in storage.ts. */
function session(options: {
    path?: string;
    summary?: string;
    account?: string;
    running?: boolean;
    subagents?: number;
    requests?: Record<string, unknown>;
}) {
    return {
        agentState: options.requests ? { requests: options.requests } : undefined,
        metadata: {
            path: options.path,
            summary: options.summary ? { text: options.summary, updatedAt: 0 } : undefined,
            droverAccount: options.account,
            lifecycleState: options.running ? 'running' : 'idle',
            activity: typeof options.subagents === 'number'
                ? { subagents: { running: options.subagents, queued: 0, total: options.subagents } }
                : undefined,
        },
    };
}

// The feed guards itself with a module-level `started`, so a test that fails
// before its own stop() would leave every later start a silent no-op and turn
// one red test into four. Teardown is unconditional for that reason.
let stopFeed: (() => void) | null = null;

function start() {
    stopFeed = startDroverWatchFeed();
}

beforeEach(() => {
    mocks.sessions = {};
    mocks.published = [];
    mocks.onAnswer = null;
    mocks.onFlip = null;
    mocks.onStorage = null;
    mocks.allow.mockReset();
    mocks.deny.mockReset();
    mocks.sendMessage.mockReset();
});

afterEach(() => {
    stopFeed?.();
    stopFeed = null;
});

describe('collectGates', () => {
    it('titles a question with its own header and previews the question body', () => {
        mocks.sessions = {
            s1: session({
                path: '/Users/clay/Projects/drover',
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        createdAt: 0,
                        arguments: {
                            questions: [{ header: 'Flip?', question: 'Move this session to work-2?' }],
                        },
                    },
                },
            }),
        };
        const [gate] = collectGates();
        expect(gate.title).toBe('Flip?');
        expect(gate.preview).toBe('Move this session to work-2?');
        expect(gate.kind).toBe('question');
    });

    it('falls back to "Question" when the card carries no header', () => {
        mocks.sessions = {
            s1: session({
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        createdAt: 0,
                        arguments: { questions: [{ question: 'Proceed?' }] },
                    },
                },
            }),
        };
        expect(collectGates()[0].title).toBe('Question');
    });

    it('leaves a permission gate on the tool name and the command', () => {
        mocks.sessions = {
            s1: session({
                requests: { req1: { tool: 'Bash', createdAt: 0, arguments: { command: 'rm -rf dist' } } },
            }),
        };
        const [gate] = collectGates();
        expect(gate.title).toBe('Run Bash');
        expect(gate.preview).toBe('rm -rf dist');
        expect(gate.kind).toBe('permission');
    });

    it('omits the account key entirely rather than sending null', () => {
        mocks.sessions = {
            s1: session({ requests: { req1: { tool: 'Bash', createdAt: 0, arguments: {} } } }),
        };
        expect('account' in collectGates()[0]).toBe(false);
    });

    // Without these the watch could only ever send a bare allow, which the bus
    // refuses on a question — the wrist tap that reached the bus and still lost
    // the answer (event "Step 1 order", 2026-08-29).
    it('carries a question’s options, with the description when there is one', () => {
        mocks.sessions = {
            s1: session({
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        createdAt: 0,
                        arguments: {
                            questions: [{
                                question: 'Which order?',
                                options: [
                                    { label: 'Step 1 first', description: 'the safe one' },
                                    { label: 'Step 2 first' },
                                ],
                            }],
                        },
                    },
                },
            }),
        };
        expect(collectGates()[0].options).toEqual([
            { label: 'Step 1 first', description: 'the safe one' },
            { label: 'Step 2 first' },
        ]);
    });

    // happy-cli drops the bus's option ids when it mirrors a question through
    // the phone's AskUserQuestion card, so most real options arrive without
    // one. An id that IS there still has to survive: it is what the CLI matches
    // on first.
    it('keeps an option id when the card carried one', () => {
        mocks.sessions = {
            s1: session({
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        createdAt: 0,
                        arguments: {
                            questions: [{ question: 'Go?', options: [{ id: 'opt-1', label: 'Go' }] }],
                        },
                    },
                },
            }),
        };
        expect(collectGates()[0].options).toEqual([{ label: 'Go', id: 'opt-1' }]);
    });

    it('omits the options key on a permission, and on a question that has none', () => {
        mocks.sessions = {
            s1: session({
                requests: {
                    req1: { tool: 'Bash', createdAt: 0, arguments: { command: 'ls' } },
                    req2: {
                        tool: 'AskUserQuestion',
                        createdAt: 0,
                        arguments: { questions: [{ question: 'Free text?', options: [] }] },
                    },
                },
            }),
        };
        // Never `options: null`: WatchConnectivity takes property-list types
        // only, NSNull is not one, and a single null fails the WHOLE publish.
        for (const gate of collectGates()) expect('options' in gate).toBe(false);
    });

    it('drops an option with no usable label rather than sending a blank button', () => {
        mocks.sessions = {
            s1: session({
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        createdAt: 0,
                        arguments: {
                            questions: [{
                                question: 'Which?',
                                options: [{ label: 'Real' }, { description: 'no label' }, 'bare string'],
                            }],
                        },
                    },
                },
            }),
        };
        expect(collectGates()[0].options).toEqual([{ label: 'Real' }]);
    });
});

describe('collectSessions', () => {
    it('carries the path and the RUNNING subagent count', () => {
        mocks.sessions = {
            s1: session({ path: '/Users/clay/Projects/drover', running: true, subagents: 3 }),
        };
        expect(collectSessions()).toEqual([{
            id: 's1',
            title: 'drover',
            active: true,
            path: '/Users/clay/Projects/drover',
            subagents: 3,
        }]);
    });

    it('omits path and subagents when the session never said', () => {
        mocks.sessions = { s1: session({}) };
        const [s] = collectSessions();
        expect('path' in s).toBe(false);
        expect('subagents' in s).toBe(false);
        expect(s.title).toBe('session');
    });

    it('excludes the drover bridge session, which holds no conversation to flip', () => {
        mocks.sessions = {
            bridge: session({ summary: 'Cattle Drover — pending gates from every local agent' }),
            s1: session({ path: '/a/work' }),
        };
        expect(collectSessions().map((s) => s.id)).toEqual(['s1']);
    });
});

describe('collectAccounts', () => {
    it('dedups in first-seen order and drops unaccounted sessions', () => {
        mocks.sessions = {
            s1: session({ path: '/a', account: 'work' }),
            s2: session({ path: '/b' }),
            s3: session({ path: '/c', account: 'personal' }),
            s4: session({ path: '/d', account: 'work' }),
        };
        expect(collectAccounts(collectSessions())).toEqual(['work', 'personal']);
    });
});

describe('startDroverWatchFeed', () => {
    it('splits a gate id on the FIRST colon, so a subagent request id survives', () => {
        start();
        mocks.onAnswer!({ id: 'sess1:agent7:tool9', allow: false });
        expect(mocks.deny).toHaveBeenCalledWith('sess1', 'agent7:tool9');
    });

    it('passes the chosen option through as updatedInput, never a bare allow', () => {
        start();
        mocks.onAnswer!({ id: 'sess1:req1', allow: true, optionId: 'Flip it' });
        expect(mocks.allow).toHaveBeenCalledWith(
            'sess1', 'req1', undefined, undefined, undefined, { optionId: 'Flip it' },
        );
    });

    it('leaves updatedInput off a plain permission allow', () => {
        start();
        mocks.onAnswer!({ id: 'sess1:req1', allow: true });
        expect(mocks.allow).toHaveBeenCalledWith(
            'sess1', 'req1', undefined, undefined, undefined, undefined,
        );
    });

    it('turns a wrist flip into the /flip message the CLI already intercepts', () => {
        start();
        mocks.onFlip!({ sessionId: 'sess1', account: 'work-2' });
        mocks.onFlip!({ sessionId: 'sess2' });
        expect(mocks.sendMessage).toHaveBeenNthCalledWith(1, 'sess1', '/flip work-2');
        expect(mocks.sendMessage).toHaveBeenNthCalledWith(2, 'sess2', '/flip');
    });

    it('republishes when only the subagent count moved', () => {
        mocks.sessions = { s1: session({ path: '/a', running: true, subagents: 1 }) };
        start();
        expect(mocks.published).toHaveLength(1);

        // Same gates, same sessions, same account: without the count in the
        // change key this second push is dropped and the wrist shows 1 forever.
        mocks.sessions = { s1: session({ path: '/a', running: true, subagents: 4 }) };
        mocks.onStorage!();
        expect(mocks.published).toHaveLength(2);
        expect(mocks.published[1].sessions[0].subagents).toBe(4);

        // Nothing moved, so nothing is published.
        mocks.onStorage!();
        expect(mocks.published).toHaveLength(2);
    });

    // A feed that publishes only on change cannot produce a liveness signal:
    // an hour-old snapshot means "nothing happened" and "the phone is dead"
    // equally, and the wrist trusted both the same. The heartbeat is what lets
    // the watch tell them apart.
    it('republishes on a heartbeat so updatedAt tracks liveness, not just change', () => {
        vi.useFakeTimers();
        try {
            mocks.sessions = { s1: session({ path: '/a' }) };
            start();
            expect(mocks.published).toHaveLength(1);

            vi.advanceTimersByTime(60_000);
            expect(mocks.published).toHaveLength(2);
            // Same wall, later stamp — which is the entire content of the beat.
            expect(mocks.published[1].gates).toEqual(mocks.published[0].gates);
            expect(mocks.published[1].updatedAt > mocks.published[0].updatedAt).toBe(true);

            // And it stops with the feed, rather than outliving it.
            stopFeed!();
            stopFeed = null;
            vi.advanceTimersByTime(180_000);
            expect(mocks.published).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
