import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DroverGate, DroverSession, DroverSnapshot, DroverTranscriptDelta } from 'drover-watch';

const mocks = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    /** The store's per-session message lists, only what the feed reads (DROVE-91). */
    sessionMessages: {} as Record<string, { messages: unknown[] }>,
    /** Deltas sent by sendMessage while the watch is reachable (DROVE-91). */
    transcripts: [] as DroverTranscriptDelta[],
    visible: vi.fn(),
    allow: vi.fn(),
    deny: vi.fn(),
    sendMessage: vi.fn(),
    published: [] as DroverSnapshot[],
    /** Snapshots sent through the background wake (DROVE-62). */
    woken: [] as DroverSnapshot[],
    /** The watch app is frontmost, so publish's own sendMessage reaches it. */
    reachable: true,
    /** Background wakes left today; undefined is a native module without the key (DROVE-86). */
    wakes: undefined as number | undefined,
    onAnswer: null as
        ((event: { id: string; allow: boolean; optionId?: string; text?: string }) => void) | null,
    onFlip: null as ((event: { sessionId: string; account?: string }) => void) | null,
    onRefresh: null as (() => void) | null,
    onOpened: null as ((event: { sessionId?: string }) => void) | null,
    onSay: null as ((event: { sessionId: string; text: string }) => void) | null,
    onRoute: null as ((event: { headphones: boolean }) => void) | null,
    onSpoken: null as ((event: { id: string; finished: boolean }) => void) | null,
    /** What the voice side was told (DROVE-92). */
    interrupted: [] as string[],
    watchRoute: [] as boolean[],
    settled: [] as { id: string; finished: boolean }[],
    onStorage: null as (() => void) | null,
}));

// storage.ts pulls in React Native, ops.ts the socket and sync.ts the whole
// client, so each is stubbed down to the surface the feed actually touches.
vi.mock('./storage', () => ({
    storage: {
        getState: () => ({ sessions: mocks.sessions, sessionMessages: mocks.sessionMessages }),
        subscribe: (listener: () => void) => {
            mocks.onStorage = listener;
            return () => { mocks.onStorage = null; };
        },
    },
}));

vi.mock('./sync', () => ({
    sync: {
        sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
        loadSessionMessages: (id: string) => mocks.visible(id),
    },
}));

// The row builder folds tool runs through the phone's own labels, which read
// the locale off React Native; neither exists under vitest (DROVE-91).
vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
// The real English strings, not a stub of the key. The wrist's limit label is
// the phone's own word for the window ("Session", "Fable week"), and a test
// that accepts `agentInput.usagePopup.session:` would pass while the two
// surfaces printed different things (DROVE-131).
vi.mock('@/text', async () => {
    const { en } = await import('@/text/_default');
    return {
        t: (key: string, params?: Record<string, unknown>) => {
            const value = key.split('.').reduce<any>((node, part) => node?.[part], en);
            if (typeof value === 'function') return value(params);
            if (typeof value === 'string') return value;
            return `${key}:${(params as { count?: number } | undefined)?.count ?? ''}`;
        },
    };
});

// The voice side owns the reader and the wrist speaker; the feed only hands
// them facts off the wire (DROVE-92).
vi.mock('@/voice/readAloudService', () => ({
    readAloud: {
        interrupt: (reason: string) => mocks.interrupted.push(reason),
        // Sending stops the capture and leaves the narration running
        // (DROVE-122), so the wrist goes through userSent like the composer.
        userSent: () => mocks.interrupted.push('sent'),
    },
}));
vi.mock('@/voice/watchSpeaker', () => ({
    setWatchRoute: (headphones: boolean) => mocks.watchRoute.push(headphones),
    settleWatchUtterance: (id: string, finished: boolean) => mocks.settled.push({ id, finished }),
}));

vi.mock('./ops', () => ({
    sessionAllow: (...args: unknown[]) => { mocks.allow(...args); return Promise.resolve(); },
    sessionDeny: (...args: unknown[]) => { mocks.deny(...args); return Promise.resolve(); },
}));

vi.mock('drover-watch', () => ({
    isDroverWatchAvailable: () => true,
    getDroverWatchStatus: () => ({
        supported: true, activated: true, paired: true, installed: true, reachable: mocks.reachable,
        ...(mocks.wakes === undefined ? {} : { wakes: mocks.wakes }),
    }),
    describeDroverWakeBudget: (status: { wakes?: number }) =>
        typeof status.wakes === 'number' ? `wake budget ${status.wakes}/50 today` : 'wake budget unknown',
    publishDroverSnapshot: (snapshot: DroverSnapshot) => {
        mocks.published.push(snapshot);
        return Promise.resolve(true);
    },
    wakeDroverWatch: (snapshot: DroverSnapshot) => {
        mocks.woken.push(snapshot);
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
    addDroverOpenedListener: (listener: typeof mocks.onOpened) => {
        mocks.onOpened = listener;
        return { remove: () => { mocks.onOpened = null; } };
    },
    addDroverSayListener: (listener: typeof mocks.onSay) => {
        mocks.onSay = listener;
        return { remove: () => { mocks.onSay = null; } };
    },
    addDroverRouteListener: (listener: typeof mocks.onRoute) => {
        mocks.onRoute = listener;
        return { remove: () => { mocks.onRoute = null; } };
    },
    addDroverSpokenListener: (listener: typeof mocks.onSpoken) => {
        mocks.onSpoken = listener;
        return { remove: () => { mocks.onSpoken = null; } };
    },
    sendDroverTranscript: (delta: DroverTranscriptDelta) => {
        if (!mocks.reachable) return Promise.resolve(false);
        mocks.transcripts.push(delta);
        return Promise.resolve(true);
    },
}));

import {
    collectAccountRows,
    collectAccounts,
    collectGates,
    collectSessions,
    deservesAWake,
    startDroverWatchFeed,
} from './droverWatchFeed';
import { getSessionName } from '@/utils/sessionUtils';
import { currentDroverAccountRow } from '@/utils/droverUsage';
import { resolveSessionState } from './sessionState';

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
    /** `Session.thinking` — the turn is running. */
    thinking?: boolean;
    thinkingAt?: number;
    /** The CLI's account/headroom snapshot (DROVE-47), read by the picker. */
    droverUsage?: unknown;
    /** `Session.presence` — what the phone resolves its state from (DROVE-129). */
    presence?: 'online' | number;
    /** `metadata.name` — the CLI's own copy of the session's name (DROVE-127). */
    name?: string;
}) {
    return {
        // Connected unless a test says otherwise: a non-rig session with no
        // socket reads as ARCHIVED, so a default of false would have quietly
        // emptied the wrist in every case below and called it a pass.
        active: options.active ?? true,
        // Online unless a test says otherwise, matching `active`: the feed
        // resolves the session's state through the phone's own
        // resolveSessionState, which reads presence and not the socket flag
        // (DROVE-129).
        presence: options.presence ?? (options.active === false ? 0 : 'online'),
        thinking: options.thinking ?? false,
        thinkingAt: options.thinkingAt ?? 0,
        agentState: options.requests ? { requests: options.requests } : undefined,
        metadata: {
            path: options.path,
            name: options.name,
            summary: options.summary ? { text: options.summary, updatedAt: 0 } : undefined,
            droverAccount: options.account,
            droverUsage: options.droverUsage,
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
    mocks.sessionMessages = {};
    mocks.transcripts = [];
    mocks.visible.mockReset();
    mocks.onOpened = null;
    mocks.onSay = null;
    mocks.onRoute = null;
    mocks.onSpoken = null;
    mocks.interrupted = [];
    mocks.watchRoute = [];
    mocks.settled = [];
    mocks.published = [];
    mocks.woken = [];
    mocks.reachable = true;
    mocks.wakes = undefined;
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
            state: 'waiting',
            path: '/Users/clay/Projects/drover',
            subagents: 3,
        }]);
    });

    it('omits path and subagents when the session never said', () => {
        mocks.sessions = { s1: session({}) };
        const [s] = collectSessions();
        expect('path' in s).toBe(false);
        expect('subagents' in s).toBe(false);
        // The phone's last word for a session with neither a name nor a path,
        // not the wrist's old literal `session` (DROVE-127). `@/text` resolves
        // real English here (DROVE-130 changed the mock), so this asserts the
        // words the wrist actually draws rather than a key.
        expect(s.title).toBe('New chat');
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
 * DROVE-127 and DROVE-129: the wrist is the phone folded to wrist size, so
 * every value it shows has to come off the phone's own derivation.
 *
 * Asserted at the SHARED FUNCTION, never through a screen. A UI test would
 * pass the day someone reimplemented `sessionDisplayTitle` inside the feed,
 * which is exactly the bug: two implementations that happen to agree today.
 * These call the phone's function and the feed's output and demand they be the
 * same string.
 */
describe('what the wrist shows is what the phone shows', () => {
    it('titles a session by its NAME, which is what the phone header shows', () => {
        mocks.sessions = {
            s1: session({
                path: '/Users/clay/Projects/bitspur/cattle-drover',
                summary: 'DROVER',
                running: true,
            }),
        };
        const [wrist] = collectSessions();
        // The photo Clay sent: the wrist said one of these and the phone the
        // other, for one session.
        expect(wrist.title).toBe('DROVER');
        expect(wrist.title).not.toBe('cattle-drover');
        expect(wrist.title).toBe(getSessionName(mocks.sessions.s1 as never));
    });

    it('takes metadata.name when only the CLI stamped one', () => {
        mocks.sessions = { s1: session({ path: '/a/cattle-drover', name: 'zap' }) };
        const [wrist] = collectSessions();
        expect(wrist.title).toBe('zap');
        expect(wrist.title).toBe(getSessionName(mocks.sessions.s1 as never));
    });

    it('still falls back to the directory when a session has no name at all', () => {
        mocks.sessions = { s1: session({ path: '/Users/clay/Projects/bitspur/cattle-drover' }) };
        const [wrist] = collectSessions();
        expect(wrist.title).toBe('cattle-drover');
        expect(wrist.title).toBe(getSessionName(mocks.sessions.s1 as never));
    });

    /** AC: renaming a session updates the wrist without a restart. */
    it('republishes when a session is renamed, so the wrist follows a rename', async () => {
        mocks.sessions = { s1: session({ path: '/a/cattle-drover', running: true }) };
        start();
        expect(mocks.published.at(-1)?.sessions[0].title).toBe('cattle-drover');
        const published = mocks.published.length;
        mocks.sessions = {
            s1: session({ path: '/a/cattle-drover', summary: 'DROVER', running: true }),
        };
        mocks.onStorage?.();
        await Promise.resolve();
        expect(mocks.published.length).toBeGreaterThan(published);
        expect(mocks.published.at(-1)?.sessions[0].title).toBe('DROVER');
    });

    /**
     * The account line, resolved the way the session info screen and the
     * composer popup resolve it. `droverUsage` marks the account the session
     * is on RIGHT NOW; the `droverAccount` stamp is the older fact, and the
     * wrist used to read only that.
     */
    it('names the account the phone names, not the stale stamp', () => {
        const droverUsage = {
            capturedAt: 1,
            accounts: [
                { name: 'work', headroom: 12 },
                { name: 'work-2', headroom: 88, current: true },
            ],
        };
        mocks.sessions = {
            s1: session({ path: '/a/work', running: true, account: 'work', droverUsage }),
        };
        const [wrist] = collectSessions();
        expect(wrist.account).toBe('work-2');
        expect(wrist.account).toBe(currentDroverAccountRow(droverUsage, 'work')?.name);
    });

    it('keeps the plain stamp when nothing measured the accounts', () => {
        mocks.sessions = { s1: session({ path: '/a/work', running: true, account: 'work' }) };
        expect(collectSessions()[0].account).toBe('work');
    });

    it('omits the account rather than inventing one for an unaccounted session', () => {
        mocks.sessions = { s1: session({ path: '/a/work', running: true }) };
        expect('account' in collectSessions()[0]).toBe(false);
    });

    /**
     * The state word. The wrist cannot import resolveSessionState, so the
     * phone resolves and sends; sessionStateWire.spec.ts is what pins the
     * Swift that draws it.
     */
    it('sends the phone resolved state, not whether the process is up', () => {
        mocks.sessions = {
            idle: session({ path: '/a/idle', running: true }),
            busy: session({ path: '/a/busy', running: true, thinking: true }),
            gated: session({ path: '/a/gated', running: true, requests: { r1: { tool: 'Bash' } } }),
            gone: session({ path: '/a/gone', running: true, presence: 0, rig: true }),
        };
        const byId = Object.fromEntries(collectSessions().map((s) => [s.id, s]));
        expect(byId.idle.state).toBe('waiting');
        expect(byId.busy.state).toBe('thinking');
        expect(byId.gated.state).toBe('permission_required');
        expect(byId.gone.state).toBe('disconnected');
        for (const [id, wrist] of Object.entries(byId)) {
            const phone = mocks.sessions[id] as {
                agentState?: unknown; thinking?: boolean; presence?: unknown;
            };
            expect(wrist.state, id).toBe(resolveSessionState({
                agentState: phone.agentState as never,
                thinking: !!phone.thinking,
                isOnline: phone.presence === 'online',
            }));
        }
    });

    /**
     * A session running and a session blocked on a permission both report
     * `active: true`, so the old wrist drew the same green dot for both. That
     * is the divergence the state field closes.
     */
    it('tells a running session apart from one waiting on a human, which `active` cannot', () => {
        mocks.sessions = {
            busy: session({ path: '/a/busy', running: true, thinking: true }),
            gated: session({ path: '/a/gated', running: true, requests: { r1: { tool: 'Bash' } } }),
        };
        const [busy, gated] = collectSessions().sort((a, b) => a.id.localeCompare(b.id));
        expect(busy.active).toBe(gated.active);
        expect(busy.state).not.toBe(gated.state);
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

    // Clay: "I should be able to speak back to it, in fact I should be able
    // to speak with the watch." A dictated message takes the composer's own
    // send path, so it reaches the inbox socket like any typed one (DROVE-92).
    it('sends a message dictated on the wrist exactly like a phone-typed one', () => {
        start();
        mocks.onSay!({ sessionId: 's1', text: '  run the tests again  ' });
        expect(mocks.sendMessage).toHaveBeenCalledWith('s1', 'run the tests again', { source: 'voice' });
        expect(mocks.interrupted).toEqual(['sent']);
    });

    it('sends nothing for a dictation that heard silence', () => {
        start();
        mocks.onSay!({ sessionId: 's1', text: '   ' });
        mocks.onSay!({ sessionId: '', text: 'hello' });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.interrupted).toEqual([]);
    });

    it('hands the wrist route and spoken acknowledgements to the voice side', () => {
        start();
        mocks.onRoute!({ headphones: true });
        mocks.onRoute!({ headphones: false });
        mocks.onSpoken!({ id: 'u1', finished: true });
        expect(mocks.watchRoute).toEqual([true, false]);
        expect(mocks.settled).toEqual([{ id: 'u1', finished: true }]);
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

    // DROVE-22. The heartbeat above only runs while iOS lets this app run, and
    // it does not let a backgrounded one run at all — which is every moment
    // Clay actually looks at his watch. So the wrist asks, iOS wakes this app
    // to answer, and the answer has to be a real republish.
    it('republishes when the wrist asks, even though nothing changed', async () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        start();
        expect(mocks.published).toHaveLength(1);
        expect(mocks.onRefresh).not.toBeNull();

        // A millisecond of real time, so the two ISO stamps differ.
        await new Promise((resolve) => setTimeout(resolve, 2));
        mocks.onRefresh!();

        expect(mocks.published).toHaveLength(2);
        // The gate set is IDENTICAL, which is exactly why this has to be a
        // forced publish: the change check would drop it and the watch would be
        // answered with the same stale snapshot it asked to replace.
        expect(mocks.published[1].gates).toEqual(mocks.published[0].gates);
        expect(mocks.published[1].updatedAt > mocks.published[0].updatedAt).toBe(true);
    });

    it('stops answering asks once the feed is torn down', () => {
        start();
        stopFeed!();
        stopFeed = null;
        expect(mocks.onRefresh).toBeNull();
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

    /**
     * The wrist shows one number per account, so it has to be told WHICH limit
     * that number is about, when it resets and how alarmed to look (DROVE-131).
     * All four decided by the phone and sent, because the watch is Swift and
     * cannot import the ranking (DROVE-129).
     */
    it('sends which limit binds, when it resets, and which account is current', () => {
        const rows = collectAccountRows({
            s1: session({
                droverUsage: usage(10, [
                    {
                        name: 'promanagerdevteam', headroom: 2, loggedIn: true, current: true,
                        limits: [
                            { kind: 'session', percent: 98, resetsAt: 1_700, scope: null, family: null },
                            { kind: 'weekly_all', percent: 62, resetsAt: 9_000, scope: null, family: null },
                        ],
                    },
                    {
                        name: 'jamrizzi', headroom: 61, loggedIn: true,
                        limits: [
                            { kind: 'weekly_scoped', percent: 39, resetsAt: 9_000, scope: 'Fable', family: 'fable' },
                        ],
                    },
                ]),
            }),
        });
        // Ordered by headroom, so the current account is not the first row —
        // which is exactly why the wrist needs the flag rather than an index.
        const current = rows.find((r) => r.name === 'promanagerdevteam')!;
        const other = rows.find((r) => r.name === 'jamrizzi')!;
        expect(current).toMatchObject({
            name: 'promanagerdevteam',
            headroom: 2,
            current: true,
            limit: 'Session',
            tone: 'critical',
            resetsAt: new Date(1_700).toISOString(),
        });
        // The bar and the label are two readings of one number: the CLI's
        // headroom is 100 minus the fullest row, which is the row named here.
        expect(current.headroom).toBe(100 - 98);
        expect(other).toMatchObject({ name: 'jamrizzi', limit: 'Fable week', tone: 'ample' });
        expect('current' in other).toBe(false);
    });

    // The watch is a TestFlight binary and cannot be updated OTA, so a row it
    // has nothing to say about must stay exactly as small as it was — and one
    // NSNull anywhere fails the whole WatchConnectivity publish.
    it('omits every limit key rather than sending a null for an account with no rows', () => {
        const [row] = collectAccountRows({
            s1: session({ droverUsage: usage(10, [{ name: 'spare', headroom: 40, loggedIn: true }]) }),
        });
        expect(row).toEqual({ name: 'spare', headroom: 40, loggedIn: true });
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

// The wrist buzz, DROVE-62. A publish reaches a sleeping watch app only "on
// next launch" — whenever Clay next opens it — so an ordinary publish cannot
// buzz anything. The wake spends one of a small daily budget to launch the
// watch app in the background, and the whole question here is which publishes
// are worth one.
describe('waking the wrist', () => {
    const gate = (id: string): DroverGate => ({
        id,
        title: 'Question',
        reason: '',
        preview: '',
        kind: 'question',
        createdAt: new Date().toISOString(),
    });
    const live = (id: string, active: boolean): DroverSession => ({ id, title: id, active });

    it('wakes for a gate that was not there before', () => {
        expect(
            deservesAWake({ gates: [], sessions: [] }, { gates: [gate('s1:r1')], sessions: [] }),
        ).toBe(true);
    });

    it('does not wake for a gate already on the wall', () => {
        const gates = [gate('s1:r1')];
        expect(deservesAWake({ gates, sessions: [] }, { gates, sessions: [] })).toBe(false);
    });

    it('wakes when a running session stops, and not when a stopped one stays stopped', () => {
        expect(
            deservesAWake(
                { gates: [], sessions: [live('a', true)] },
                { gates: [], sessions: [live('a', false)] },
            ),
        ).toBe(true);
        expect(
            deservesAWake(
                { gates: [], sessions: [live('a', false)] },
                { gates: [], sessions: [live('a', false)] },
            ),
        ).toBe(false);
    });

    // The budget is the reason this is a question at all: a wake on every
    // publish would be drained by the 60s heartbeat before lunch.
    it('does not wake on a heartbeat, or on a subagent count moving', () => {
        vi.useFakeTimers();
        try {
            mocks.reachable = false;
            mocks.sessions = { s1: session({ path: '/a', running: true, subagents: 1 }) };
            start();
            expect(mocks.published).toHaveLength(1);
            expect(mocks.woken).toHaveLength(0);

            vi.advanceTimersByTime(60_000);
            expect(mocks.published).toHaveLength(2);
            expect(mocks.woken).toHaveLength(0);

            mocks.sessions = { s1: session({ path: '/a', running: true, subagents: 4 }) };
            mocks.onStorage!();
            expect(mocks.published).toHaveLength(3);
            expect(mocks.woken).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    // The first publish of a run has nothing to compare against, so every gate
    // on it reads as new. Waking there would spend the budget on a wall that
    // was already up — and buy no buzz, because the watch filters gates older
    // than its own freshness window.
    it('does not wake for the wall that was already up when the feed started', () => {
        mocks.reachable = false;
        mocks.sessions = {
            s1: session({ path: '/a', requests: { r1: { tool: 'Bash', arguments: { command: 'ls' } } } }),
        };
        start();
        expect(mocks.published).toHaveLength(1);
        expect(mocks.woken).toHaveLength(0);
    });

    it('wakes with the same snapshot it published, so the watch has one apply', () => {
        mocks.reachable = false;
        mocks.sessions = { s1: session({ path: '/a' }) };
        start();
        expect(mocks.woken).toHaveLength(0);

        mocks.sessions = {
            s1: session({ path: '/a', requests: { r1: { tool: 'Bash', arguments: { command: 'ls' } } } }),
        };
        mocks.onStorage!();
        expect(mocks.published).toHaveLength(2);
        expect(mocks.woken).toHaveLength(1);
        expect(mocks.woken[0]).toBe(mocks.published[1]);
    });

    // Reachable means the watch app is frontmost and publish's own sendMessage
    // has already landed. A background launch of a screen someone is holding
    // up is the one case where the budget buys nothing.
    it('does not spend a wake on a watch that is already looking', () => {
        mocks.reachable = true;
        mocks.sessions = { s1: session({ path: '/a' }) };
        start();
        mocks.sessions = {
            s1: session({ path: '/a', requests: { r1: { tool: 'Bash', arguments: { command: 'ls' } } } }),
        };
        mocks.onStorage!();
        expect(mocks.published).toHaveLength(2);
        expect(mocks.woken).toHaveLength(0);
    });

    // A budget of 0 means the wrist cannot be woken (no complication on a
    // face, or the day's 50 spent). The native call would be downgraded to a
    // plain transfer the application context already covers, so the feed
    // skips it and says so, which is the only record of why the wrist stayed
    // silent (DROVE-86).
    it('skips the wake and logs the budget when no wakes are left today', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            mocks.reachable = false;
            mocks.wakes = 0;
            mocks.sessions = { s1: session({ path: '/a' }) };
            start();
            mocks.sessions = {
                s1: session({ path: '/a', requests: { r1: { tool: 'Bash', arguments: { command: 'ls' } } } }),
            };
            mocks.onStorage!();
            expect(mocks.published).toHaveLength(2);
            expect(mocks.woken).toHaveLength(0);
            const lines = log.mock.calls.map((c) => String(c[0]));
            expect(lines.some((l) => l.includes('wake skipped') && l.includes('wake budget 0/50 today'))).toBe(true);
        } finally {
            log.mockRestore();
        }
    });

    it('still wakes while budget remains, and says nothing', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            mocks.reachable = false;
            mocks.wakes = 37;
            mocks.sessions = { s1: session({ path: '/a' }) };
            start();
            mocks.sessions = {
                s1: session({ path: '/a', requests: { r1: { tool: 'Bash', arguments: { command: 'ls' } } } }),
            };
            mocks.onStorage!();
            expect(mocks.woken).toHaveLength(1);
            expect(log.mock.calls.some((c) => String(c[0]).includes('wake skipped'))).toBe(false);
        } finally {
            log.mockRestore();
        }
    });
});

describe('the open session\'s transcript (DROVE-91)', () => {
    function userMessage(id: string, text: string, createdAt: number) {
        return { kind: 'user-text', id, localId: null, createdAt, text };
    }
    function agentMessage(id: string, text: string, createdAt: number) {
        return { kind: 'agent-text', id, localId: null, createdAt, text };
    }
    /** Newest first, as the store holds them. */
    function messages(...chronological: unknown[]) {
        return { messages: [...chronological].reverse() };
    }
    const flush = async () => {
        await vi.advanceTimersByTimeAsync(250);
    };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends nothing until the watch says which session it opened', async () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1)) };
        start();
        mocks.onStorage!();
        await flush();
        expect(mocks.transcripts).toHaveLength(0);
        expect(mocks.published[0].transcript).toBeUndefined();
    });

    it('on open, loads the session on the phone and sends every row', async () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1), agentMessage('a1', 'hello', 2)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        expect(mocks.visible).toHaveBeenCalledWith('s1');
        await flush();
        expect(mocks.transcripts).toHaveLength(1);
        const delta = mocks.transcripts[0];
        expect(delta.kind).toBe('transcript');
        expect(delta.sessionId).toBe('s1');
        expect(delta.ids).toEqual(['u1', 'a1']);
        expect(delta.rows.map((r) => [r.kind, r.text])).toEqual([['user', 'hi'], ['assistant', 'hello']]);
        expect(delta.streaming).toBe(false);
    });

    it('a burst of store changes is one delta carrying the latest rows', async () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        // Thirty changes over 300ms: one send lands inside the burst, at the
        // 250ms mark, and one more after it settles. Never thirty.
        for (let i = 0; i < 30; i++) {
            mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1), agentMessage('a1', 'x'.repeat(i + 1), 2)) };
            mocks.onStorage!();
            await vi.advanceTimersByTimeAsync(10);
        }
        expect(mocks.transcripts).toHaveLength(1);
        await flush();
        expect(mocks.transcripts).toHaveLength(2);
        const last = mocks.transcripts[1];
        expect(last.rows.map((r) => r.id)).toEqual(['a1']);
        expect(last.rows[0].text).toBe('x'.repeat(30));
    });

    it('a delta after the first carries only what changed', async () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1), agentMessage('a1', 'hello', 2)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        await flush();
        mocks.sessionMessages = {
            s1: messages(userMessage('u1', 'hi', 1), agentMessage('a1', 'hello', 2), agentMessage('a2', 'and more', 3)),
        };
        mocks.onStorage!();
        await flush();
        expect(mocks.transcripts).toHaveLength(2);
        expect(mocks.transcripts[1].ids).toEqual(['u1', 'a1', 'a2']);
        expect(mocks.transcripts[1].rows.map((r) => r.id)).toEqual(['a2']);
    });

    it('marks the newest assistant row and the transcript streaming while the turn runs', async () => {
        mocks.sessions = { s1: session({ path: '/a', thinking: true }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1), agentMessage('a1', 'hello', 2)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        await flush();
        const delta = mocks.transcripts[0];
        expect(delta.streaming).toBe(true);
        expect(delta.rows[1].streaming).toBe(true);
        expect(delta.rows[0].streaming).toBeUndefined();
        // The turn ending is a delta of its own, with no rows to carry.
        mocks.sessions = { s1: session({ path: '/a', thinking: false }) };
        mocks.onStorage!();
        await flush();
        expect(mocks.transcripts[1].streaming).toBe(false);
        expect(mocks.transcripts[1].rows.map((r) => r.id)).toEqual(['a1']);
    });

    it('trims a long reply to 500 characters with the phone tail', async () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        mocks.sessionMessages = { s1: messages(agentMessage('a1', 'z'.repeat(3000), 1)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        await flush();
        const text = mocks.transcripts[0].rows[0].text;
        expect(text.startsWith('z'.repeat(500))).toBe(true);
        expect(text.endsWith('more on the phone')).toBe(true);
        expect(text.length).toBeLessThan(540);
    });

    it('an unreachable watch is not sent a delta, and gets everything once it is back', async () => {
        mocks.reachable = false;
        mocks.sessions = { s1: session({ path: '/a' }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        await flush();
        expect(mocks.transcripts).toHaveLength(0);
        mocks.reachable = true;
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1), agentMessage('a1', 'hello', 2)) };
        mocks.onStorage!();
        await flush();
        expect(mocks.transcripts).toHaveLength(1);
        expect(mocks.transcripts[0].rows.map((r) => r.id)).toEqual(['u1', 'a1']);
    });

    it('the published snapshot carries the open session\'s rows for a watch launched later', async () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        mocks.onRefresh!();
        const snapshot = mocks.published[mocks.published.length - 1];
        expect(snapshot.transcript?.sessionId).toBe('s1');
        expect(snapshot.transcript?.rows.map((r) => r.id)).toEqual(['u1']);
    });

    it('a change in another session builds nothing', async () => {
        mocks.sessions = { s1: session({ path: '/a' }), s2: session({ path: '/b' }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1)), s2: messages(userMessage('x', 'other', 1)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        await flush();
        mocks.sessionMessages = { ...mocks.sessionMessages, s2: messages(userMessage('x', 'other', 1), userMessage('y', 'more', 2)) };
        mocks.onStorage!();
        await flush();
        expect(mocks.transcripts).toHaveLength(1);
    });

    it('closing the transcript stops the rows, and the next snapshot drops them', async () => {
        mocks.sessions = { s1: session({ path: '/a' }) };
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1)) };
        start();
        mocks.onOpened!({ sessionId: 's1' });
        await flush();
        mocks.onOpened!({});
        mocks.sessionMessages = { s1: messages(userMessage('u1', 'hi', 1), agentMessage('a1', 'hello', 2)) };
        mocks.onStorage!();
        await flush();
        expect(mocks.transcripts).toHaveLength(1);
        mocks.onRefresh!();
        expect(mocks.published[mocks.published.length - 1].transcript).toBeUndefined();
    });
});
