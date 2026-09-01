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

vi.mock('drover-watch', () => ({
    isDroverWatchAvailable: () => true,
    getDroverWatchStatus: () => ({
        supported: true, activated: true, paired: true, installed: true, reachable: false,
        ...(mocks.wakes === undefined ? {} : { wakes: mocks.wakes }),
    }),
    describeDroverWakeBudget: (status: { wakes?: number }) =>
        typeof status.wakes === 'number' ? `wake budget ${status.wakes}/50 today` : 'wake budget unknown',
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

beforeEach(() => {
    disk.clear();
    resetWristRelay();
    mocks.sessions = { s1: {} };
    mocks.gates = [];
    mocks.watchSessions = [];
    mocks.published = [];
    mocks.woken = [];
    mocks.wakeSpent = true;
    mocks.wakes = 12;
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

    it('carries a session that was running and stopped', async () => {
        rememberWristRelayState({ gates: [], sessions: [{ id: 'a', active: true }] });
        mocks.watchSessions = [{ id: 'a', title: 'a', active: false }];
        expect(await republishWatchSnapshot()).toBe(true);
        expect(mocks.woken).toHaveLength(1);
        expect(claimWristCues(['finished:a'])).toEqual([]);
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
        } finally {
            log.mockRestore();
        }
    });
});
