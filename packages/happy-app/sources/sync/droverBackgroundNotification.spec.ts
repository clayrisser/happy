import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DroverSnapshot } from 'drover-watch';

/**
 * The background half of the wrist relay (DROVE-224).
 *
 * This task runs in its OWN JS context — a headless launch that never mounts
 * the React tree — so the only thing it shares with the foreground feed is the
 * ledger on disk. That is exactly what these pin: a cue the feed already
 * carried is published and not woken for, and a cue nobody has carried is.
 */

const mocks = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    gates: [] as { id: string; kind: string }[],
    watchSessions: [] as { id: string; title: string; active: boolean }[],
    published: [] as DroverSnapshot[],
    woken: [] as DroverSnapshot[],
    wakeSpent: true,
    wakes: 12 as number | undefined,
    /** WCSession.isComplicationEnabled; undefined is a binary before build 22 (DROVE-391). */
    complication: undefined as boolean | undefined,
    /** The watch app is frontmost. Closed unless a test says otherwise: that is what a wake is for. */
    reachable: false,
    publishOk: true,
    // The phone widget rides this same wake (DROVE-260).
    widgetFaces: [] as Record<string, unknown>[],
}));

const disk = new Map<string, string>();
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return disk.get(key); }
        set(key: string, value: string) { disk.set(key, value); }
        delete(key: string) { disk.delete(key); }
        clearAll() { disk.clear(); }
    },
}));

// The module registers a TaskManager task at import; neither native module
// exists under vitest, and only `republishWatchSnapshot` is under test here.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-notifications', () => ({
    BackgroundNotificationTaskResult: { Failed: 0, NewData: 1, NoData: 2 },
    registerTaskAsync: () => Promise.resolve(),
}));
vi.mock('expo-task-manager', () => ({ defineTask: () => {} }));

vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessions: mocks.sessions }) },
}));

vi.mock('./droverWatchFeed', () => ({
    collectGates: () => mocks.gates,
    collectSessions: () => mocks.watchSessions,
    collectAccounts: () => [],
}));

// The wake rule reads each new gate's delivery to know whether it is
// announced on haptic (DROVE-72). A gate with no event wakes as before.
vi.mock('./droverGates', () => ({
    collectGateEntries: () => mocks.gates.map((gate) => ({ gate })),
}));

vi.mock('drover-watch', () => ({
    isDroverWatchAvailable: () => true,
    getDroverWatchStatus: () => ({
        supported: true, activated: true, paired: true, installed: true, reachable: mocks.reachable,
        ...(mocks.wakes === undefined ? {} : { wakes: mocks.wakes }),
        ...(mocks.complication === undefined ? {} : { complicationEnabled: mocks.complication }),
    }),
    publishDroverSnapshot: (snapshot: DroverSnapshot) => {
        if (mocks.publishOk) mocks.published.push(snapshot);
        return Promise.resolve(mocks.publishOk);
    },
    wakeDroverWatch: (snapshot: DroverSnapshot) => {
        if (mocks.wakeSpent) mocks.woken.push(snapshot);
        return Promise.resolve(mocks.wakeSpent);
    },
    // The phone widget's half of the same wake (DROVE-260). It is a separate
    // surface with a separate container, and the point of the tests below is
    // that it does not depend on the wrist's half succeeding.
    isDroverWidgetAvailable: () => true,
    writeDroverWidgetFace: (face: Record<string, unknown>) => {
        mocks.widgetFaces.push(face);
        return Promise.resolve(true);
    },
}));

const { republishWatchSnapshot } = await import('./droverBackgroundNotification');
const {
    claimWristCues,
    rememberWristRelayState,
    resetWristRelay,
    wristRelayLine,
    wristRelayState,
} = await import('./droverWristRelay');
const { resetWakeLedger, wakeLedger } = await import('./droverWakeLedger');

beforeEach(() => {
    disk.clear();
    resetWristRelay();
    resetWakeLedger();
    mocks.sessions = { s1: {} };
    mocks.gates = [];
    mocks.watchSessions = [];
    mocks.published = [];
    mocks.woken = [];
    mocks.wakeSpent = true;
    mocks.wakes = 12;
    mocks.complication = undefined;
    mocks.reachable = false;
    mocks.publishOk = true;
    mocks.widgetFaces = [];
});

describe('the background republish', () => {
    // An empty store is "not hydrated yet", not "nothing is pending".
    it('publishes nothing on a cold launch with no sessions', async () => {
        mocks.sessions = {};
        expect(await republishWatchSnapshot()).toBe(false);
        expect(mocks.published).toHaveLength(0);
    });

    /**
     * THE WIDGET DOES NOT DEPEND ON A WATCH (DROVE-260).
     *
     * This wake is the push the whole widget freshness argument rests on — the
     * CLI sends it exactly when the gate set changes — and the two surfaces
     * share nothing but the wake. A widget that only got written when a WATCH
     * publish also succeeded would go dark for anyone without one, which is
     * most people who would install it, and it would go dark silently.
     */
    it('writes the widget face even when the watch publish fails', async () => {
        mocks.publishOk = false;
        mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
        expect(await republishWatchSnapshot()).toBe(false);
        expect(mocks.published).toHaveLength(0);
        expect(mocks.widgetFaces).toHaveLength(1);
        expect(mocks.widgetFaces[0].count).toBe(1);
    });

    // An unhydrated store must not clear the widget for the same reason it
    // must not clear the wrist: it would wipe the gate the wake announced.
    it('writes no widget face on a cold launch with no sessions', async () => {
        mocks.sessions = {};
        expect(await republishWatchSnapshot()).toBe(false);
        expect(mocks.widgetFaces).toHaveLength(0);
    });

    it('carries a gate nobody has carried yet', async () => {
        mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(mocks.published).toHaveLength(1);
        expect(mocks.woken).toHaveLength(1);
        expect(wristRelayState().gates).toEqual(['s1:r1']);
    });

    // The event arriving as he backgrounds the app: the feed carried it a
    // second earlier, then the silent wake push launched this. ONE buzz.
    it('publishes without waking for a cue the feed already carried', async () => {
        claimWristCues(['s1:r1']);
        rememberWristRelayState({ gates: [{ id: 's1:r1' }], sessions: [] });
        mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(mocks.published).toHaveLength(1);
        expect(mocks.woken).toHaveLength(0);
    });

    // A gate-resolved wake carries nothing. It used to spend a background
    // launch anyway, out of a budget the next real gate needs.
    it('spends no wake when a gate went away', async () => {
        rememberWristRelayState({ gates: [{ id: 's1:r1' }], sessions: [] });
        mocks.gates = [];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(mocks.published).toHaveLength(1);
        expect(mocks.woken).toHaveLength(0);
    });

    // THE BURNER (DROVE-391). This path woke for any unclaimed cue, and a
    // silent push lands for every session stop, so 300 dead sessions going
    // quiet overnight were up to 300 launches nobody felt. A stop is still
    // carried: the record advances and nothing carries it twice. Until
    // DROVE-391 the woken count here read 1.
    it('carries a session that was running and stopped without spending a wake', async () => {
        rememberWristRelayState({ gates: [], sessions: [{ id: 'a', active: true }] });
        mocks.watchSessions = [{ id: 'a', title: 'a', active: false }];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(mocks.published).toHaveLength(1);
        expect(mocks.woken).toHaveLength(0);
        expect(claimWristCues(['finished:a'])).toEqual([]);
        expect(wristRelayState().running).toEqual([]);
        expect(wakeLedger().refused).toBe(0);
    });

    // Reachable means the watch app is frontmost and publish's own
    // sendMessage has reached it. This path never checked (DROVE-391).
    it('publishes without waking when the watch app is open', async () => {
        mocks.reachable = true;
        mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(mocks.published).toHaveLength(1);
        expect(mocks.woken).toHaveLength(0);
        expect(wristRelayState().gates).toEqual(['s1:r1']);
    });

    it('folds a second gate into the wake already spent this stretch', async () => {
        mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(mocks.woken).toHaveLength(1);
        mocks.gates = [{ id: 's1:r1', kind: 'permission' }, { id: 's1:r2', kind: 'question' }];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(mocks.published).toHaveLength(2);
        expect(mocks.woken).toHaveLength(1);
        expect(wristRelayState().gates).toEqual(['s1:r1', 's1:r2']);
        expect(wakeLedger().used).toBe(1);
        expect(wakeLedger().refused).toBe(1);
    });

    it('says the complication is on no face rather than a spent budget', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            mocks.wakes = 0;
            mocks.complication = false;
            mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
            expect(await republishWatchSnapshot()).toBe(true);
            expect(mocks.woken).toHaveLength(0);
            expect(claimWristCues(['s1:r1'])).toEqual(['s1:r1']);
            expect(wristRelayLine()).toContain('complication is on no watch face');
            expect(wristRelayLine()).not.toContain('wake budget');
            expect(wakeLedger().lastRefused?.reason).toBe('no-face');
        } finally {
            log.mockRestore();
        }
    });

    it('spends no wake at all on a budget of 0, and says so', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            mocks.wakes = 0;
            mocks.complication = true;
            mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
            expect(await republishWatchSnapshot()).toBe(true);
            expect(mocks.woken).toHaveLength(0);
            expect(wristRelayLine()).toContain('wake budget 0/50 today');
            expect(wristRelayState().gates).toEqual([]);
        } finally {
            log.mockRestore();
        }
    });

    // A cue nobody felt stays carryable, and the refusal is on record rather
    // than only in a Console nobody reads back from a background launch.
    it('gives the claim back and says why when the wake was not spent', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            mocks.wakeSpent = false;
            mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
            expect(await republishWatchSnapshot()).toBe(true);
            expect(mocks.woken).toHaveLength(0);
            expect(claimWristCues(['s1:r1'])).toEqual(['s1:r1']);
            expect(wristRelayLine()).toContain('wake budget 12/50 today');
            expect(wristRelayLine()).toContain('a push may still reach the wrist');
            expect(wristRelayState().gates).toEqual([]);
            expect(wakeLedger().lastRefused?.reason).toBe('downgraded');
        } finally {
            log.mockRestore();
        }
    });

    it('counts a spent wake on the ledger', async () => {
        mocks.gates = [{ id: 's1:r1', kind: 'permission' }];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(wakeLedger().used).toBe(1);
        expect(wakeLedger().lastSpent?.reason).toBe('gate');
    });
});
