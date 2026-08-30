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
    onRefresh: null as (() => void) | null,
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
    addDroverRefreshListener: (listener: typeof mocks.onRefresh) => {
        mocks.onRefresh = listener;
        return { remove: () => { mocks.onRefresh = null; } };
    },
}));

import {
    collectAccountRows,
    collectAccounts,
    collectGates,
    collectSessions,
    startDroverWatchFeed,
    statusFor,
    updatedInputFor,
} from './droverWatchFeed';

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
    /** `Session.thinking` — the turn is running. */
    thinking?: boolean;
    thinkingAt?: number;
    /** The CLI's account/headroom snapshot (DROVE-47), read by the picker. */
    droverUsage?: unknown;
}) {
    return {
        // Connected unless a test says otherwise: a non-rig session with no
        // socket reads as ARCHIVED, so a default of false would have quietly
        // emptied the wrist in every case below and called it a pass.
        active: options.active ?? true,
        thinking: options.thinking ?? false,
        thinkingAt: options.thinkingAt ?? 0,
        agentState: options.requests ? { requests: options.requests } : undefined,
        metadata: {
            path: options.path,
            summary: options.summary ? { text: options.summary, updatedAt: 0 } : undefined,
            droverAccount: options.account,
            droverUsage: options.droverUsage,
            lifecycleState: options.lifecycleState ?? (options.running ? 'running' : 'idle'),
            ...(options.rig ? { client: { id: 'rig' } } : {}),
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
    mocks.onRefresh = null;
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
            // Subagents out IS the live line when nothing is thinking
            // (DROVE-54); the count on its own is a fact with no verb.
            status: '3 subagents',
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


/**
 * What the session is DOING, on one line (DROVE-54's watch half).
 *
 * Clay: "I wish I could see all this rich information on my mobile app as it's
 * working. Right now it just says online and I can't see what it's doing." The
 * wrist has room for the top line of the terminal's task tree, and every field
 * it needs is already on the phone — no new producer, nothing added to the CLI.
 */
describe('statusFor', () => {
    it('leads with thinking, because that is the thing that ends', () => {
        expect(statusFor({ thinking: true, thinkingAt: 1_000, metadata: {} }))
            .toEqual({ status: 'thinking', statusSince: new Date(1_000).toISOString() });
    });

    it('folds the subagent count into the thinking line rather than dropping it', () => {
        expect(statusFor({
            thinking: true,
            thinkingAt: 1_000,
            metadata: { activity: { subagents: { running: 3 } } },
        }).status).toBe('thinking · 3 out');
    });

    it('says how many subagents are out when the turn itself is not running', () => {
        expect(statusFor({ metadata: { activity: { subagents: { running: 1 } }, lifecycleStateSince: 5 } }))
            .toEqual({ status: '1 subagent', statusSince: new Date(5).toISOString() });
        expect(statusFor({ metadata: { activity: { subagents: { running: 2 } } } }).status)
            .toBe('2 subagents');
    });

    // The row's own dot already says idle. A second word for it is a line of
    // noise on a 40mm screen, and inventing one would make "no status" and
    // "status: idle" indistinguishable to the change key below.
    it('says nothing at all about an idle session', () => {
        expect(statusFor({ metadata: { activity: { subagents: { running: 0 } } } })).toEqual({});
        expect(statusFor({ metadata: {} })).toEqual({});
    });

    // A status carrying its own elapsed time would change every second, and
    // the feed republishes on any session change — so the wrist would be fed a
    // snapshot per second to keep a timer honest. The wrist counts up from the
    // stamp instead.
    it('never bakes an elapsed time into the string', () => {
        const { status } = statusFor({ thinking: true, thinkingAt: 1_000, metadata: {} });
        expect(status).not.toMatch(/\d+\s*(s|m|h)\b/);
    });

    it('republishes when only the status moved', () => {
        mocks.sessions = { s1: session({ path: '/a', running: true }) };
        start();
        expect(mocks.published).toHaveLength(1);
        expect(mocks.published[0].sessions[0].status).toBeUndefined();

        mocks.sessions = { s1: session({ path: '/a', running: true, thinking: true, thinkingAt: 7 }) };
        mocks.onStorage!();
        expect(mocks.published).toHaveLength(2);
        expect(mocks.published[1].sessions[0].status).toBe('thinking');
    });
});

/**
 * The flip picker's own list (DROVE-28's watch half).
 *
 * The wrist used to offer accounts collected from the SESSIONS, which can only
 * ever name an account something is already running on — the exact opposite of
 * what a flip wants. The account worth moving to is the one with headroom, and
 * the emptiest account has no session to be named by. `metadata.droverUsage`
 * (DROVE-47) is the CLI's own registry snapshot and carries the figure.
 */
describe('collectAccountRows', () => {
    const usage = (capturedAt: number, accounts: unknown[]) => ({ capturedAt, accounts });

    it('orders by headroom, most first, and carries the figure', () => {
        expect(collectAccountRows({
            s1: session({
                droverUsage: usage(10, [
                    { name: 'main', headroom: 4, loggedIn: true },
                    { name: 'jamrizzi', headroom: 65, loggedIn: true },
                ]),
            }),
        })).toEqual([
            { name: 'jamrizzi', headroom: 65, loggedIn: true },
            { name: 'main', headroom: 4, loggedIn: true },
        ]);
    });

    it('sinks an account that cannot take the session to the bottom', () => {
        expect(collectAccountRows({
            s1: session({
                droverUsage: usage(10, [
                    { name: 'spare', loggedIn: false },
                    { name: 'main', headroom: 0, loggedIn: true },
                ]),
            }),
        }).map((r) => r.name)).toEqual(['main', 'spare']);
    });

    // No figure is not a claim of a full tank. An account the CLI never
    // measured sorting to the top would be the wrist recommending the one it
    // knows least about.
    it('sorts an unmeasured account below every measured one', () => {
        expect(collectAccountRows({
            s1: session({
                droverUsage: usage(10, [
                    { name: 'unknown', loggedIn: true },
                    { name: 'measured', headroom: 1, loggedIn: true },
                ]),
            }),
        }).map((r) => r.name)).toEqual(['measured', 'unknown']);
    });

    it('takes the freshest snapshot, since every session carries its own copy', () => {
        expect(collectAccountRows({
            stale: session({ droverUsage: usage(1, [{ name: 'old', headroom: 90, loggedIn: true }]) }),
            fresh: session({ droverUsage: usage(2, [{ name: 'new', headroom: 10, loggedIn: true }]) }),
        }).map((r) => r.name)).toEqual(['new']);
    });

    it('carries when a cooling account is back, and omits the key when it is not out', () => {
        const [cooling, fine] = collectAccountRows({
            s1: session({
                droverUsage: usage(10, [
                    { name: 'fine', headroom: 50, loggedIn: true },
                    { name: 'cooling', headroom: 0, loggedIn: true, cooling: { until: 1_700 } },
                ]),
            }),
        }).reverse();
        expect(cooling.backAt).toBe(new Date(1_700).toISOString());
        expect('backAt' in fine).toBe(false);
    });

    it('is empty when no session has ever carried the registry', () => {
        expect(collectAccountRows({ s1: session({ path: '/a' }) })).toEqual([]);
    });

    it('publishes the rows AND the bare names, because the watch cannot update OTA', () => {
        mocks.sessions = {
            s1: session({
                path: '/a',
                account: 'main',
                droverUsage: usage(10, [
                    { name: 'main', headroom: 4, loggedIn: true },
                    { name: 'jamrizzi', headroom: 65, loggedIn: true },
                ]),
            }),
        };
        start();
        // A binary that predates accountRows reads only `accounts` — and it
        // still gets the headroom ORDER, it just cannot print the numbers.
        expect(mocks.published[0].accounts).toEqual(['jamrizzi', 'main']);
        expect(mocks.published[0].accountRows?.map((r) => r.name)).toEqual(['jamrizzi', 'main']);
    });

    it('republishes when only the headroom moved', () => {
        const rows = (headroom: number) => ({
            s1: session({
                path: '/a',
                droverUsage: usage(10, [{ name: 'main', headroom, loggedIn: true }]),
            }),
        });
        mocks.sessions = rows(50);
        start();
        expect(mocks.published).toHaveLength(1);
        // The session set and the gate set are untouched: without the rows in
        // the change key the picker offers yesterday's ranking forever.
        mocks.sessions = rows(5);
        mocks.onStorage!();
        expect(mocks.published).toHaveLength(2);
        expect(mocks.published[1].accountRows?.[0].headroom).toBe(5);
    });
});

/**
 * A question answered on the wrist has TWO readers and they read different keys
 * (DROVE-53 Part A).
 *
 * happy-cli's bus bridge reads `updatedInput.optionId`; Claude's own
 * AskUserQuestion is resolved through the permission callback, which merges
 * updatedInput into the tool input and reads the answer under the QUESTION'S
 * OWN TEXT. The wrist only ever sent optionId, so a NATIVE question answered
 * from the watch merged a key nothing reads and the harness saw no answer at
 * all — the same shape of failure as bus event "Step 1 order", one layer up.
 */
describe('updatedInputFor', () => {
    const asking = (question: string) => ({
        s1: session({
            requests: {
                req1: {
                    tool: 'AskUserQuestion',
                    createdAt: 0,
                    arguments: { questions: [{ question, options: [{ label: 'Yes' }] }] },
                },
            },
        }),
    });

    it('keys a question answer by the question text, the way the phone card does', () => {
        expect(updatedInputFor('s1', 'req1', 'Yes', asking('Ship it?')))
            .toEqual({ optionId: 'Yes', answers: { 'Ship it?': 'Yes' } });
    });

    it('still sends optionId, which is the only key the bus bridge reads', () => {
        expect(updatedInputFor('s1', 'req1', 'Yes', asking('Ship it?')).optionId).toBe('Yes');
    });

    it('sends optionId alone for a permission, which asks no question', () => {
        expect(updatedInputFor('s1', 'req1', 'allow', {
            s1: session({ requests: { req1: { tool: 'Bash', createdAt: 0, arguments: {} } } }),
        })).toEqual({ optionId: 'allow' });
    });

    it('sends optionId alone when the request is gone by the time the answer lands', () => {
        expect(updatedInputFor('s1', 'req1', 'Yes', {})).toEqual({ optionId: 'Yes' });
    });

    // The watch joins a multi-select with ", " because that is what the phone's
    // own card sends (providerAnswersFor) and what happy-cli splits on when
    // matching a label back to a bus option. It arrives here already joined and
    // must travel unchanged.
    it('passes a joined multi-select selection through untouched', () => {
        expect(updatedInputFor('s1', 'req1', 'Yes, No', asking('Which?')))
            .toEqual({ optionId: 'Yes, No', answers: { 'Which?': 'Yes, No' } });
    });

    it('is what the feed actually sends when the wrist answers a question', () => {
        mocks.sessions = asking('Ship it?');
        start();
        mocks.onAnswer!({ id: 's1:req1', allow: true, optionId: 'Yes' });
        expect(mocks.allow).toHaveBeenCalledWith(
            's1', 'req1', undefined, undefined, undefined,
            { optionId: 'Yes', answers: { 'Ship it?': 'Yes' } },
        );
    });
});

/**
 * The wrist asking the phone for a snapshot (DROVE-22).
 *
 * Clay: "When I open the drover watch app, it always just says out of date. How
 * to make it work without requiring the drover app to be open on my phone." A
 * watch-to-phone sendMessage launches this app in the background, so the push
 * below runs with the phone locked in a pocket.
 */
describe('a refresh asked for from the wrist', () => {
    it('republishes even though nothing changed, because the stamp IS the answer', () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        start();
        expect(mocks.published).toHaveLength(1);

        mocks.onRefresh!();
        expect(mocks.published).toHaveLength(2);
        expect(mocks.published[1].gates).toEqual(mocks.published[0].gates);
        expect(mocks.published[1].updatedAt >= mocks.published[0].updatedAt).toBe(true);
    });

    // Unsubscribed with the answer and flip listeners. A refresh subscription
    // that outlived its feed would wake the phone app for a surface that is no
    // longer publishing to it.
    it('stops listening with the feed rather than outliving it', () => {
        start();
        expect(mocks.onRefresh).not.toBeNull();
        stopFeed!();
        stopFeed = null;
        expect(mocks.onRefresh).toBeNull();
    });
});
