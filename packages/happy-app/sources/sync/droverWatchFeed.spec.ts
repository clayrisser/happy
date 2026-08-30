import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DroverSnapshot } from 'drover-watch';

const mocks = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    allow: vi.fn(),
    deny: vi.fn(),
    sendMessage: vi.fn(),
    published: [] as DroverSnapshot[],
    onAnswer: null as
        ((event: { id: string; allow: boolean; optionId?: string; text?: string }) => void) | null,
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
    /** `Session.active` — the socket, not the lifecycle. */
    active?: boolean;
    /** Overrides `running`, for the one value that means retired. */
    lifecycleState?: string;
    /** A rig session, which stays live work even with its socket down. */
    rig?: boolean;
    /** `metadata.liveStatus` — what the pane is doing right now (DROVE-54). */
    liveStatus?: Record<string, unknown> | null;
}) {
    return {
        // Connected unless a test says otherwise: a non-rig session with no
        // socket reads as ARCHIVED, so a default of false would have quietly
        // emptied the wrist in every case below and called it a pass.
        active: options.active ?? true,
        agentState: options.requests ? { requests: options.requests } : undefined,
        metadata: {
            path: options.path,
            summary: options.summary ? { text: options.summary, updatedAt: 0 } : undefined,
            droverAccount: options.account,
            lifecycleState: options.lifecycleState ?? (options.running ? 'running' : 'idle'),
            ...(options.rig ? { client: { id: 'rig' } } : {}),
            activity: typeof options.subagents === 'number'
                ? { subagents: { running: options.subagents, queued: 0, total: options.subagents } }
                : undefined,
            liveStatus: options.liveStatus,
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

    /**
     * DROVE-54: the wrist gets one line saying what the session is DOING, and
     * the start of the turn, so it can run the clock itself.
     */
    it('carries a one-line live status and the turn start', () => {
        const now = Date.now();
        mocks.sessions = {
            s1: session({
                path: '/a/work',
                running: true,
                liveStatus: {
                    at: now,
                    turnStartedAt: now - 1_033_000,
                    tool: { id: 't1', name: 'Bash', arg: 'Run the unit suite', startedAt: now - 65_000 },
                    agents: [
                        { id: 'a1', label: 'one', startedAt: now - 10_000 },
                        { id: 'a2', label: 'two', startedAt: now - 9_000 },
                    ],
                },
            }),
        };
        const [s] = collectSessions();
        expect(s.status).toBe('Bash · 2 agents');
        expect(s.statusSince).toBe(new Date(now - 1_033_000).toISOString());
    });

    it('says nothing about a session that is idle, and nothing about a stale snapshot', () => {
        mocks.sessions = {
            idle: session({ path: '/a/idle' }),
            stale: session({
                path: '/a/stale',
                liveStatus: { at: Date.now() - 600_000, tool: { id: 't', name: 'Bash', startedAt: 0 } },
            }),
        };
        for (const s of collectSessions()) {
            expect('status' in s).toBe(false);
            expect('statusSince' in s).toBe(false);
        }
    });
});

/**
 * The wrist should only ever show sessions the phone would still show.
 *
 * It did not. collectSessions filtered exactly two things — a session with no
 * metadata, and the bridge's own — so every retired and test session `drover
 * sessions` still lists arrived on the watch as merely `active: false`, sitting
 * among live work on a screen with room for about three rows. The rule is
 * storage's own `isSessionArchived`, called rather than restated, so the two
 * surfaces cannot answer this differently.
 */
describe('collectSessions and the archive', () => {
    it('drops a session the agent retired', () => {
        mocks.sessions = {
            live: session({ path: '/a/live', running: true }),
            retired: session({ path: '/a/retired', lifecycleState: 'archived' }),
        };
        expect(collectSessions().map((s) => s.id)).toEqual(['live']);
    });

    it('drops a Happy CLI session whose socket is gone, which is how it ends', () => {
        mocks.sessions = {
            live: session({ path: '/a/live' }),
            ended: session({ path: '/a/ended', active: false }),
        };
        expect(collectSessions().map((s) => s.id)).toEqual(['live']);
    });

    // The clause that makes this worth calling instead of writing again: a rig
    // session off the network is work in progress, not work that ended.
    it('keeps a rig session that only lost its connection', () => {
        mocks.sessions = { r1: session({ path: '/a/rig', active: false, rig: true }) };
        expect(collectSessions().map((s) => s.id)).toEqual(['r1']);
    });

    it('publishes the live ones only, so the wrist never sees the archive', () => {
        mocks.sessions = {
            live: session({ path: '/a/live', running: true }),
            retired: session({ path: '/a/retired', lifecycleState: 'archived' }),
        };
        start();
        expect(mocks.published[0].sessions.map((s) => s.id)).toEqual(['live']);
    });
});

/**
 * A session that flips accounts is the SAME session, and the wrist has to agree.
 *
 * Nothing here has to be built for that to hold — the CLI keeps the Happy
 * session id across a flip, the title comes off the working directory, and the
 * watch list is keyed on the id — but nothing pinned it either, so a refactor
 * that derived either from the account would move the row out from under a
 * thumb mid-flip and read as a new session appearing.
 */
describe('a session flipped to another account', () => {
    it('keeps its id and its title, and moves only the account', () => {
        const on = (account: string) =>
            ({ s1: session({ path: '/Users/clay/Projects/drover', running: true, account }) });
        mocks.sessions = on('work');
        const before = collectSessions()[0];
        mocks.sessions = on('work-2');
        const after = collectSessions()[0];
        expect(after.id).toBe(before.id);
        expect(after.title).toBe(before.title);
        expect(before.account).toBe('work');
        expect(after.account).toBe('work-2');
    });

    it('reaches the wrist as the same row rather than a second one', () => {
        mocks.sessions = { s1: session({ path: '/a/work', running: true, account: 'work' }) };
        start();
        mocks.sessions = { s1: session({ path: '/a/work', running: true, account: 'work-2' }) };
        mocks.onStorage!();
        expect(mocks.published).toHaveLength(2);
        expect(mocks.published[1].sessions.map((s) => s.id)).toEqual(['s1']);
        expect(mocks.published[1].sessions[0].account).toBe('work-2');
        expect(mocks.published[1].sessions[0].title).toBe(mocks.published[0].sessions[0].title);
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

    // The wrist can type now (GateDetailView's TextFieldLink), and a typed
    // answer has to travel the same road a picked one does. It rides the one
    // `optionId` key on purpose: happy-cli's answerCandidates reads that and
    // the question card's own `answers`, nothing else, and busResolutionFor
    // resolves action=text when the string matches no option. A `text` key of
    // its own here would arrive where nothing is looking.
    it('forwards a typed answer, which the CLI then resolves as action=text', () => {
        start();
        mocks.onAnswer!({ id: 'sess1:req1', allow: true, text: 'rebase onto main first' });
        expect(mocks.allow).toHaveBeenCalledWith(
            'sess1', 'req1', undefined, undefined, undefined, { optionId: 'rebase onto main first' },
        );
    });

    it('prefers the picked option when a wrist somehow sends both', () => {
        start();
        mocks.onAnswer!({ id: 'sess1:req1', allow: true, optionId: 'Step 1 first', text: 'typed' });
        expect(mocks.allow).toHaveBeenCalledWith(
            'sess1', 'req1', undefined, undefined, undefined, { optionId: 'Step 1 first' },
        );
    });

    // A blank is refused on the watch (GateStore.answer) and again here: the
    // bus 400s a blank resolve, and an older bus takes it, records no answer,
    // and dismisses every surface with nothing to inject.
    it('sends no answer at all rather than a blank one', () => {
        start();
        mocks.onAnswer!({ id: 'sess1:req1', allow: true, text: '' });
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
