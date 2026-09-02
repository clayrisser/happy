/**
 * Firing a wrist cue from the phone's Playground (DROVE-222).
 *
 * Clay tapped a haptic row expecting the WATCH to buzz and the phone buzzed
 * instead, so the two things pinned here are: the cue leaves for the wrist by
 * the live path, and a wrist that cannot be reached comes back as a refusal
 * with words on it rather than as anything that could be mistaken for success.
 * There is no phone fallback in this module to test the absence of — that is
 * the design, and the screen prints `demoBuzzLine` for every path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DroverSnapshot } from 'drover-watch';

const mocks = vi.hoisted(() => ({
    published: [] as DroverSnapshot[],
    woken: [] as DroverSnapshot[],
    logs: [] as string[],
    available: true,
    paired: true,
    installed: true,
    reachable: true,
    wakes: undefined as number | undefined,
    /** WCSession.isComplicationEnabled; undefined is a binary before build 22 (DROVE-391). */
    complication: undefined as boolean | undefined,
    publishes: true,
    wakeSpent: true,
}));

// The wake ledger is on disk (DROVE-391); back react-native-mmkv with a map.
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return disk.get(key); }
        set(key: string, value: string) { disk.set(key, value); }
        delete(key: string) { disk.delete(key); }
        clearAll() { disk.clear(); }
    },
}));

vi.mock('drover-watch', () => ({
    isDroverWatchAvailable: () => mocks.available,
    getDroverWatchStatus: () => ({
        supported: true,
        activated: true,
        paired: mocks.paired,
        installed: mocks.installed,
        reachable: mocks.reachable,
        ...(mocks.wakes === undefined ? {} : { wakes: mocks.wakes }),
        ...(mocks.complication === undefined ? {} : { complicationEnabled: mocks.complication }),
    }),
    publishDroverSnapshot: (snapshot: DroverSnapshot) => {
        if (!mocks.publishes) return Promise.resolve(false);
        mocks.published.push(snapshot);
        return Promise.resolve(true);
    },
    wakeDroverWatch: (snapshot: DroverSnapshot) => {
        mocks.woken.push(snapshot);
        return Promise.resolve(mocks.wakeSpent);
    },
}));

// The feed reaches the store, which reaches React Native. The buzz only wants
// "what is on the wrist right now", so each collector answers empty.
vi.mock('./droverWatchFeed', () => ({
    collectAccountRows: () => [],
    collectAccounts: () => [],
    collectGates: () => [],
    collectSessions: () => [],
    collectTranscript: () => null,
}));

vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
}));

vi.mock('./droverDemo', () => ({
    demoLog: (line: string) => mocks.logs.push(line),
}));

import { buzzDroverWatch, demoBuzzLine, demoFinishStageMs } from './droverDemoBuzz';
import { resetWakeLedger, wakeLedger, wakeStretchOpen } from './droverWakeLedger';
import { wristCues } from '@/utils/wristCues';

const cue = (name: string) => wristCues.find((c) => c.cue === name)!;

beforeEach(() => {
    vi.useFakeTimers();
    mocks.published = [];
    mocks.woken = [];
    mocks.logs = [];
    mocks.available = true;
    mocks.paired = true;
    mocks.installed = true;
    mocks.reachable = true;
    mocks.wakes = 40;
    mocks.complication = undefined;
    mocks.publishes = true;
    mocks.wakeSpent = true;
    disk.clear();
    resetWakeLedger();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('a gate cue, fired at the wrist', () => {
    it('leaves as one demo gate of the cue\'s wire kind, on the real path', async () => {
        const outcome = await buzzDroverWatch(cue('question'));
        expect(outcome).toEqual({ ok: true, how: 'reachable' });
        expect(mocks.published).toHaveLength(1);
        expect(mocks.published[0].gates).toHaveLength(1);
        expect(mocks.published[0].gates[0].kind).toBe('question');
        expect(mocks.published[0].gates[0].id.startsWith('demo:')).toBe(true);
    });

    it('withdraws the card again once the wrist has had time to play', async () => {
        await buzzDroverWatch(cue('permission'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.published).toHaveLength(2);
        expect(mocks.published[1].gates).toHaveLength(0);
    });

    it('asks before spending a wake on a closed watch app, and says so', async () => {
        mocks.reachable = false;
        const outcome = await buzzDroverWatch(cue('needsYou'));
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.why).toContain('spend one background wake');
        expect(mocks.woken).toHaveLength(0);
    });

    it('spends one when the row asks for it', async () => {
        mocks.reachable = false;
        const outcome = await buzzDroverWatch(cue('needsYou'), true);
        expect(outcome).toEqual({ ok: true, how: 'wake' });
        expect(mocks.woken).toHaveLength(1);
    });

    it('reports a spent budget rather than a buzz', async () => {
        mocks.reachable = false;
        mocks.wakes = 0;
        const outcome = await buzzDroverWatch(cue('needsYou'), true);
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.why).toContain('no wakes left today');
        expect(mocks.woken).toHaveLength(0);
    });

    // The two causes of a dead budget, told apart (DROVE-391). The row Clay
    // read said both in one sentence, and the fix for one is on the watch
    // while the fix for the other is tomorrow.
    it('says the complication is on no face, and nothing about the budget', async () => {
        mocks.reachable = false;
        mocks.wakes = 0;
        mocks.complication = false;
        const outcome = await buzzDroverWatch(cue('needsYou'), true);
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.why).toContain('complication is on no watch face');
        expect(outcome.ok === false && outcome.why).not.toContain('no wakes left');
        expect(mocks.woken).toHaveLength(0);
    });

    it('says the budget is spent when the complication is on a face, and nothing about the face', async () => {
        mocks.reachable = false;
        mocks.wakes = 0;
        mocks.complication = true;
        const outcome = await buzzDroverWatch(cue('needsYou'), true);
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.why).toContain('no wakes left today');
        expect(outcome.ok === false && outcome.why).not.toContain('complication');
    });

    // Counted like a real one, so "N of 50 used today" is honest about what
    // this phone spent; without a stretch, so the next real gate is not
    // folded into a Playground tap.
    it('puts a spent wake on the ledger without opening a stretch', async () => {
        mocks.reachable = false;
        expect(await buzzDroverWatch(cue('needsYou'), true)).toEqual({ ok: true, how: 'wake' });
        expect(wakeLedger().used).toBe(1);
        expect(wakeLedger().lastSpent?.reason).toBe('demo');
        expect(wakeStretchOpen()).toBe(false);
    });

    it('counts nothing when the launch was not spent', async () => {
        mocks.reachable = false;
        mocks.wakeSpent = false;
        const outcome = await buzzDroverWatch(cue('needsYou'), true);
        expect(outcome.ok).toBe(false);
        expect(wakeLedger().used).toBe(0);
    });
});

/**
 * The cue with no gate behind it (DROVE-222). WristCueDiff only emits
 * `finished` for a session that WAS active and is not, so the phone stages
 * exactly that pair rather than inventing a second way in.
 */
describe('"Session finished", fired at the wrist', () => {
    it('publishes one demo session running, then the same id stopped', async () => {
        const promise = buzzDroverWatch(cue('finished'));
        await vi.advanceTimersByTimeAsync(demoFinishStageMs);
        expect(await promise).toEqual({ ok: true, how: 'reachable' });
        expect(mocks.published).toHaveLength(2);
        const [first, second] = mocks.published;
        expect(first.sessions).toHaveLength(1);
        expect(first.sessions[0].active).toBe(true);
        expect(second.sessions[0].active).toBe(false);
        expect(second.sessions[0].id).toBe(first.sessions[0].id);
        expect(first.gates).toHaveLength(0);
    });

    it('takes the demo session back off the wrist afterwards', async () => {
        const promise = buzzDroverWatch(cue('finished'));
        await vi.advanceTimersByTimeAsync(demoFinishStageMs);
        await promise;
        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.published).toHaveLength(3);
        expect(mocks.published[2].sessions).toHaveLength(0);
    });

    it('is not cut in half by the withdraw the previous tap left behind', async () => {
        // Play-all fires five cues inside the 4s linger. An earlier withdraw
        // landing between the running and the stopped publish would make the
        // session vanish instead of stop, and the wrist would stay silent.
        await buzzDroverWatch(cue('permission'));
        await vi.advanceTimersByTimeAsync(3000);
        const promise = buzzDroverWatch(cue('finished'));
        await vi.advanceTimersByTimeAsync(demoFinishStageMs);
        await promise;
        // The gate, then the session running, then the session stopped. No
        // empty snapshot anywhere in between.
        expect(mocks.published).toHaveLength(3);
        expect(mocks.published[1].sessions[0].active).toBe(true);
        expect(mocks.published[2].sessions[0].active).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.published).toHaveLength(4);
        expect(mocks.published[3].sessions).toHaveLength(0);
    });

    it('refuses on a closed watch app instead of staging half of it', async () => {
        mocks.reachable = false;
        const outcome = await buzzDroverWatch(cue('finished'));
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.why).toContain('open the Drover watch app');
        expect(mocks.published).toHaveLength(0);
    });
});

describe('a wrist that is not there', () => {
    it('says there is no watch module on this build', async () => {
        mocks.available = false;
        for (const spec of wristCues) {
            const outcome = await buzzDroverWatch(spec);
            expect(outcome).toEqual({ ok: false, why: 'no watch module on this build' });
        }
        expect(mocks.published).toHaveLength(0);
    });

    it('says nothing is paired with Drover on it, for every cue', async () => {
        mocks.installed = false;
        for (const spec of wristCues) {
            const outcome = await buzzDroverWatch(spec);
            expect(outcome).toEqual({ ok: false, why: 'no watch with Drover installed is paired' });
        }
        expect(mocks.published).toHaveLength(0);
    });

    it('reports a publish that did not leave the phone', async () => {
        mocks.publishes = false;
        const outcome = await buzzDroverWatch(cue('question'));
        expect(outcome).toEqual({ ok: false, why: 'the phone could not publish to the watch' });
    });
});

/**
 * The row's words. Every unhappy path prints the refusal itself, so there is
 * no phrasing a reader could take for a buzz that happened.
 */
describe('what the row says after a tap', () => {
    it('prints the refusal verbatim', () => {
        expect(demoBuzzLine({ ok: false, why: 'the watch app is not open' })).toBe('the watch app is not open');
    });

    it('distinguishes a wake from an open watch app', () => {
        expect(demoBuzzLine({ ok: true, how: 'wake' })).toBe('Sent with a background wake');
        expect(demoBuzzLine({ ok: true, how: 'reachable' })).toBe('Sent; the watch app was open');
    });
});
