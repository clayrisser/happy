import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-native-mmkv needs a native/web backend; back it with a plain map, the
// same way droverNotificationAnswer.spec.ts does.
const store = new Map<string, string>();
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return store.get(key); }
        set(key: string, value: string) { store.set(key, value); }
        delete(key: string) { store.delete(key); }
        clearAll() { store.clear(); }
    },
}));

const {
    claimWristCues,
    noteWristRelay,
    releaseWristCues,
    rememberWristRelayState,
    resetWristRelay,
    seedWristCues,
    wristCarrierFor,
    wristCueCarried,
    wristCueIds,
    wristCueStateOf,
    wristRefusal,
    wristRelayLine,
    wristRelayNotes,
    wristRelayState,
} = await import('./droverWristRelay');

const gate = (id: string) => ({ id });
const live = (id: string, active: boolean) => ({ id, active });

beforeEach(() => {
    store.clear();
    resetWristRelay();
});

describe('wristCarrierFor', () => {
    // The whole cause Clay worked out: iOS does not forward a push to the
    // watch while the app that owns it is frontmost.
    it('says only the direct path can reach the wrist while the app is active', () => {
        expect(wristCarrierFor('active')).toBe('direct');
    });

    it('leaves the mirror possible in every other state', () => {
        expect(wristCarrierFor('background')).toBe('mirror');
        expect(wristCarrierFor('inactive')).toBe('mirror');
        expect(wristCarrierFor(undefined)).toBe('mirror');
        expect(wristCarrierFor(null)).toBe('mirror');
    });
});

describe('wristCueIds', () => {
    // The watch's own vocabulary, not a second one: WristCueDiff keys a gate
    // by its bus id and a stopped session by `finished:<sessionId>`.
    it('names a fresh gate by its bus id', () => {
        expect(wristCueIds({ gates: [], running: [] }, { gates: [gate('s1:r1')], sessions: [] }))
            .toEqual(['s1:r1']);
    });

    it('names a session that was running and stopped the way the watch does', () => {
        expect(
            wristCueIds({ gates: [], running: ['a'] }, { gates: [], sessions: [live('a', false)] }),
        ).toEqual(['finished:a']);
    });

    it('raises nothing for a gate already on the wall or a session that stayed stopped', () => {
        expect(
            wristCueIds(
                { gates: ['s1:r1'], running: [] },
                { gates: [gate('s1:r1')], sessions: [live('a', false)] },
            ),
        ).toEqual([]);
    });

    // Freshness is the WATCH's filter, against its own persisted snapshot. A
    // phone that filtered too would refuse to carry a gate the wrist would
    // have played.
    it('does not apply a freshness window of its own', () => {
        const before = { gates: [], running: [] };
        expect(wristCueIds(before, { gates: [gate('old:gate')], sessions: [] })).toEqual(['old:gate']);
    });
});

describe('wristCueStateOf', () => {
    it('keeps the gate ids and only the RUNNING sessions', () => {
        expect(
            wristCueStateOf({ gates: [gate('g1')], sessions: [live('a', true), live('b', false)] }),
        ).toEqual({ gates: ['g1'], running: ['a'] });
    });
});

describe('the carry ledger', () => {
    it('gives a cue to the first claimer and nothing to the second', () => {
        expect(claimWristCues(['s1:r1'])).toEqual(['s1:r1']);
        expect(claimWristCues(['s1:r1'])).toEqual([]);
        expect(wristCueCarried('s1:r1')).toBe(true);
    });

    it('hands back only the part of a batch nobody has carried', () => {
        claimWristCues(['a']);
        expect(claimWristCues(['a', 'b'])).toEqual(['b']);
    });

    // The feed's first publish reads the whole wall as new. Recorded rather
    // than skipped, or the next background wake would carry it instead.
    it('seeds a wall as carried without anyone owning a buzz for it', () => {
        seedWristCues(['s1:r1', 's1:r2']);
        expect(claimWristCues(['s1:r1', 's1:r2'])).toEqual([]);
    });

    // A claim is taken before the wake is spent, and the wake can be refused.
    it('gives a claim back so a refused carry can be retried', () => {
        const mine = claimWristCues(['s1:r1']);
        releaseWristCues(mine);
        expect(wristCueCarried('s1:r1')).toBe(false);
        expect(claimWristCues(['s1:r1'])).toEqual(['s1:r1']);
    });

    it('survives a fresh module, which is what a headless background launch is', async () => {
        claimWristCues(['s1:r1']);
        vi.resetModules();
        const reloaded = await import('./droverWristRelay');
        expect(reloaded.claimWristCues(['s1:r1'])).toEqual([]);
    });

    // The same 200 WristBuzzer keeps on the watch, oldest dropped first.
    it('forgets the oldest ids past its limit rather than growing forever', () => {
        claimWristCues(Array.from({ length: 210 }, (_, i) => `g${i}`));
        expect(wristCueCarried('g0')).toBe(false);
        expect(wristCueCarried('g209')).toBe(true);
    });
});

describe('the shared record of what the wrist has seen', () => {
    it('starts empty, so a fresh install carries the first gate it sees', () => {
        expect(wristRelayState()).toEqual({ gates: [], running: [] });
    });

    it('is what the next reader diffs against', () => {
        rememberWristRelayState({ gates: [gate('s1:r1')], sessions: [live('a', true)] });
        expect(wristRelayState()).toEqual({ gates: ['s1:r1'], running: ['a'] });
        expect(
            wristCueIds(wristRelayState(), { gates: [gate('s1:r1')], sessions: [live('a', false)] }),
        ).toEqual(['finished:a']);
    });
});

describe('the visible refusal', () => {
    // Silence with nothing on record is the complaint that filed the ticket.
    it('keeps the reason where a screen can read it back', () => {
        noteWristRelay('wake skipped for s1:r1: wake budget 0/50 today');
        expect(wristRelayLine()).toContain('wake budget 0/50 today');
        expect(wristRelayNotes()).toHaveLength(1);
    });

    it('keeps the newest and drops the rest rather than growing forever', () => {
        for (let i = 0; i < 14; i++) noteWristRelay(`refusal ${i}`);
        expect(wristRelayNotes()).toHaveLength(10);
        expect(wristRelayLine()).toBe('refusal 13');
    });

    it('has nothing to say when nothing was refused', () => {
        expect(wristRelayLine()).toBe(null);
    });

    // The two refusals are not the same claim. With the app open the wrist is
    // definitely silent; backgrounded, a push may still land.
    it('says the wrist is definitely silent only when no push could reach it', () => {
        expect(wristRefusal(['s1:r1'], 'direct', 'wake budget 0/50 today'))
            .toBe('wake skipped for s1:r1: wake budget 0/50 today, the app is open, so no push can reach the wrist either');
        expect(wristRefusal(['s1:r1'], 'mirror', 'wake budget 0/50 today'))
            .toBe('wake skipped for s1:r1: wake budget 0/50 today, a push may still reach the wrist');
    });

    it('counts a batch rather than listing it', () => {
        expect(wristRefusal(['a', 'b', 'c'], 'direct', 'wake budget unknown')).toContain('3 cues');
    });
});

/**
 * The wire check, in the shape wristCues.spec.ts already uses for the beats
 * (DROVE-75): the phone's cue ids are pinned to the Swift that derives them.
 *
 * It matters because the ledger's whole guarantee is that the phone and
 * WristBuzzer's own `played` list key a cue the same way. An id the watch
 * spells differently is a claim that stops nothing, and it would fail
 * silently — a double buzz, not a crash.
 */
describe('the cue ids the watch derives (WristCueDiff)', () => {
    const swift = readFileSync(
        resolve(__dirname, '../../watch/DroverWatch/Shared/WristCue.swift'),
        'utf8',
    );

    it('keys a gate by its bus id, as WristCueDiff does', () => {
        expect(swift).toContain('id: gate.id');
        expect(wristCueIds({ gates: [], running: [] }, { gates: [gate('s1:r1')], sessions: [] }))
            .toEqual(['s1:r1']);
    });

    it('keys a finished session `finished:<sessionId>`, as WristCueDiff does', () => {
        expect(swift).toContain('id: "finished:\\(session.id)"');
        expect(wristCueIds({ gates: [], running: ['a'] }, { gates: [], sessions: [live('a', false)] }))
            .toEqual(['finished:a']);
    });

    // The two conditions the Swift diff applies, restated here so a change on
    // the watch that drops one is a red test rather than a quiet divergence.
    it('raises a cue on the same two conditions the Swift does', () => {
        expect(swift).toContain('if known.contains(gate.id) { continue }');
        expect(swift).toContain('for session in next.sessions where !session.active && wasRunning.contains(session.id)');
    });

    // The watch remembers 200 played ids, oldest first. The phone's ledger
    // holds the same, so neither forgets a cue the other still knows.
    it('remembers as many cues as WristBuzzer does', () => {
        const buzzer = readFileSync(
            resolve(__dirname, '../../watch/DroverWatch/Model/WristBuzzer.swift'),
            'utf8',
        );
        const limit = buzzer.match(/playedLimit = (\d+)/);
        expect(limit).not.toBe(null);
        const size = Number(limit![1]);
        claimWristCues(Array.from({ length: size + 1 }, (_, i) => `g${i}`));
        expect(wristCueCarried('g0')).toBe(false);
        expect(wristCueCarried(`g${size}`)).toBe(true);
    });
});

describe('exactly one carry across a transition (DROVE-224)', () => {
    // The event arriving as he backgrounds the app: the foreground feed
    // carried it, then the silent wake push launches the background task,
    // which must publish and stay quiet.
    it('leaves nothing for the background task when the feed already carried it', () => {
        const before = wristRelayState();
        const after = { gates: [gate('s1:r1')], sessions: [] };
        const feedsShare = claimWristCues(wristCueIds(before, after));
        expect(feedsShare).toEqual(['s1:r1']);
        rememberWristRelayState(after);

        // The background task, in its own JS context, reading the same record.
        expect(claimWristCues(wristCueIds(wristRelayState(), after))).toEqual([]);
    });

    // The event arriving as he foregrounds it: the background task carried it,
    // then the app comes forward and the feed sees a gate that is new against
    // its own in-memory sets.
    it('leaves nothing for the feed when the background task already carried it', () => {
        const after = { gates: [gate('s1:r1')], sessions: [] };
        expect(claimWristCues(wristCueIds(wristRelayState(), after))).toEqual(['s1:r1']);
        rememberWristRelayState(after);

        // The feed's own `lastGates` is empty after a restart, so it re-derives
        // the same cue; the ledger is what stops the second buzz.
        expect(claimWristCues(wristCueIds({ gates: [], running: [] }, after))).toEqual([]);
    });

    // A gate-resolved wake carries nothing at all, and used to spend a
    // background launch anyway.
    it('carries nothing when a gate goes away', () => {
        rememberWristRelayState({ gates: [gate('s1:r1')], sessions: [] });
        expect(claimWristCues(wristCueIds(wristRelayState(), { gates: [], sessions: [] }))).toEqual([]);
    });
});
