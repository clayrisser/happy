/**
 * What a background wake of the watch is spent on, and the record of every
 * one (DROVE-391).
 *
 * Clay's day of 50 wakes was gone before the first real question: every
 * session leaving `running` was woken for, and the background push path woke
 * for anything unclaimed with no budget check. These pin the one rule both
 * paths now share, and the ledger that says afterwards what happened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return disk.get(key); }
        set(key: string, value: string) { disk.set(key, value); }
        delete(key: string) { disk.delete(key); }
        clearAll() { disk.clear(); }
    },
}));

import {
    decideWristWake,
    endWakeStretch,
    noteWakeRefused,
    noteWakeSpent,
    resetWakeLedger,
    wakeLedger,
    wakeLedgerLines,
    wakeStretchMs,
    wakeStretchOpen,
    type WristWakeStatus,
} from './droverWakeLedger';

/** Local noon, so the local day is the same one wherever the test runs. */
const noon = new Date(2026, 8, 2, 12, 0, 0).getTime();
const nextNoon = new Date(2026, 8, 3, 12, 0, 0).getTime();

const closed: WristWakeStatus = { activated: true, reachable: false, wakes: 12, complicationEnabled: true };
const gate = ['s1:r1'];

beforeEach(() => {
    disk.clear();
    resetWakeLedger();
});

describe('what a wake is spent on', () => {
    it('spends for a gate needing an answer on a closed watch app', () => {
        expect(decideWristWake({ status: closed, cues: gate, deserving: true, now: noon })).toEqual({ spend: true });
    });

    it('carries nothing, for nothing', () => {
        const verdict = decideWristWake({ status: closed, cues: [], deserving: false, now: noon });
        expect(verdict).toMatchObject({ spend: false, carried: true, why: 'none' });
    });

    // The burner. 300 dead sessions going quiet overnight was up to 300
    // launches nobody felt. A stop is still a cue: a reachable watch diffs it
    // off the publish, and the record advances so nothing carries it twice.
    it('does not wake for a session stopping, and counts it carried', () => {
        const verdict = decideWristWake({ status: closed, cues: ['finished:a'], deserving: false, now: noon });
        expect(verdict).toMatchObject({ spend: false, carried: true, why: 'session-stop' });
        expect(wakeLedger(noon).refused).toBe(0);
        expect(wakeLedger(noon).used).toBe(0);
    });

    it('wakes for the gate in a change that also carries a stop', () => {
        expect(
            decideWristWake({ status: closed, cues: ['finished:a', 's1:r1'], deserving: true, now: noon }),
        ).toEqual({ spend: true });
    });

    // Reachable means the watch app is frontmost and publish's own sendMessage
    // has already reached it. A launch of a screen someone is holding up buys
    // nothing, and the raised wrist has read the wall, so the stretch ends.
    it('does not wake a watch app that is open, and closes the stretch', () => {
        expect(decideWristWake({ status: closed, cues: gate, deserving: true, now: noon })).toEqual({ spend: true });
        expect(wakeStretchOpen(noon + 1000)).toBe(true);
        const verdict = decideWristWake({
            status: { ...closed, reachable: true }, cues: ['s1:r2'], deserving: true, now: noon + 1000,
        });
        expect(verdict).toMatchObject({ spend: false, carried: true, why: 'reachable' });
        expect(wakeStretchOpen(noon + 2000)).toBe(false);
    });

    // With haptic off the watch would not buzz on arrival either, so the
    // launch buys nothing. Carried: the application context has it.
    it('does not wake with haptic off, carries the cue, and writes it down', () => {
        const verdict = decideWristWake({ status: closed, cues: gate, deserving: false, now: noon });
        expect(verdict).toMatchObject({ spend: false, carried: true, why: 'haptic-off' });
        expect(wakeLedger(noon).refused).toBe(1);
        expect(wakeLedger(noon).lastRefused).toEqual({ at: noon, reason: 'haptic-off' });
    });
});

/**
 * The two causes that used to share one sentence, plus the moment before the
 * link is up, each said as itself. None of these count as carried: nobody
 * felt the cue, so the claim goes back and a later path may try again.
 */
describe('why a wake was refused', () => {
    it('says the link has not activated, never a spent budget', () => {
        const verdict = decideWristWake({
            status: { activated: false, reachable: false }, cues: gate, deserving: true, now: noon,
        });
        expect(verdict).toMatchObject({ spend: false, carried: false, why: 'link' });
        expect(verdict.spend === false && verdict.line).toContain('not activated');
        expect(verdict.spend === false && verdict.line).not.toContain('budget');
    });

    it('says the complication is on no face, and nothing about the budget', () => {
        const verdict = decideWristWake({
            status: { ...closed, wakes: 0, complicationEnabled: false }, cues: gate, deserving: true, now: noon,
        });
        expect(verdict).toMatchObject({ spend: false, carried: false, why: 'no-face' });
        expect(verdict.spend === false && verdict.line).toContain('complication is on no watch face');
        expect(verdict.spend === false && verdict.line).not.toContain('budget');
        expect(wakeLedger(noon).lastRefused?.reason).toBe('no-face');
    });

    it('says the budget is spent when the complication is on a face', () => {
        const verdict = decideWristWake({
            status: { ...closed, wakes: 0, complicationEnabled: true }, cues: gate, deserving: true, now: noon,
        });
        expect(verdict).toMatchObject({ spend: false, carried: false, why: 'budget' });
        expect(verdict.spend === false && verdict.line).toBe('wake budget 0/50 today');
        expect(wakeLedger(noon).lastRefused?.reason).toBe('budget');
    });

    // A binary before build 22 reports no complication state. 0 there is
    // still 0, and it reads as the budget line the session info screen and
    // Console already agree on (DROVE-86).
    it('reads 0 as the budget on a build that cannot tell', () => {
        const verdict = decideWristWake({
            status: { activated: true, reachable: false, wakes: 0 }, cues: gate, deserving: true, now: noon,
        });
        expect(verdict).toMatchObject({ spend: false, carried: false, why: 'budget' });
    });

    it('spends on a build that reports no budget at all', () => {
        expect(
            decideWristWake({ status: { activated: true, reachable: false }, cues: gate, deserving: true, now: noon }),
        ).toEqual({ spend: true });
    });
});

/**
 * One wake per unreachable stretch. A second gate inside it rides the
 * application context, which the watch reads when the first wake's launch
 * (or Clay) opens it; the watch's own freshness window means a late launch
 * for an old gate would not buzz anyway.
 */
describe('one wake per stretch', () => {
    it('opens the stretch on the verdict, before the launch returns', () => {
        expect(decideWristWake({ status: closed, cues: gate, deserving: true, now: noon })).toEqual({ spend: true });
        expect(wakeStretchOpen(noon)).toBe(true);
    });

    it('folds a second gate into the first wake', () => {
        expect(decideWristWake({ status: closed, cues: gate, deserving: true, now: noon })).toEqual({ spend: true });
        noteWakeSpent('gate', noon);
        const second = decideWristWake({ status: closed, cues: ['s1:r2'], deserving: true, now: noon + 60_000 });
        expect(second).toMatchObject({ spend: false, carried: true, why: 'stretch' });
        expect(second.spend === false && second.line).toContain('1 min ago');
        expect(wakeLedger(noon).used).toBe(1);
        expect(wakeLedger(noon).refused).toBe(1);
        expect(wakeLedger(noon).lastRefused?.reason).toBe('stretch');
    });

    it('spends again once the cooldown has run', () => {
        expect(decideWristWake({ status: closed, cues: gate, deserving: true, now: noon })).toEqual({ spend: true });
        noteWakeSpent('gate', noon);
        expect(
            decideWristWake({ status: closed, cues: ['s1:r2'], deserving: true, now: noon + wakeStretchMs }),
        ).toEqual({ spend: true });
    });

    it('spends again once the watch has been seen reachable', () => {
        expect(decideWristWake({ status: closed, cues: gate, deserving: true, now: noon })).toEqual({ spend: true });
        noteWakeSpent('gate', noon);
        endWakeStretch(noon + 1000);
        expect(
            decideWristWake({ status: closed, cues: ['s1:r2'], deserving: true, now: noon + 2000 }),
        ).toEqual({ spend: true });
    });

    // The native side turned the launch down, so nothing was coalesced into.
    it('closes the stretch a downgraded launch opened', () => {
        expect(decideWristWake({ status: closed, cues: gate, deserving: true, now: noon })).toEqual({ spend: true });
        noteWakeRefused('downgraded', noon);
        expect(wakeStretchOpen(noon + 1000)).toBe(false);
        expect(
            decideWristWake({ status: closed, cues: ['s1:r2'], deserving: true, now: noon + 1000 }),
        ).toEqual({ spend: true });
        expect(wakeLedger(noon).lastRefused?.reason).toBe('downgraded');
    });

    // A Playground tap spends on purpose and must not silence the next real
    // gate behind it.
    it('does not let the demo open a stretch', () => {
        noteWakeSpent('demo', noon);
        expect(wakeStretchOpen(noon)).toBe(false);
        expect(decideWristWake({ status: closed, cues: gate, deserving: true, now: noon + 1000 })).toEqual({ spend: true });
        expect(wakeLedger(noon).used).toBe(1);
        expect(wakeLedger(noon).lastSpent).toEqual({ at: noon, reason: 'demo' });
    });
});

describe('the ledger', () => {
    it('counts every spend and refusal with its last reason and time', () => {
        noteWakeSpent('gate', noon);
        noteWakeSpent('demo', noon + 1000);
        noteWakeRefused('no-face', noon + 2000);
        const ledger = wakeLedger(noon + 3000);
        expect(ledger.used).toBe(2);
        expect(ledger.refused).toBe(1);
        expect(ledger.lastSpent).toEqual({ at: noon + 1000, reason: 'demo' });
        expect(ledger.lastRefused).toEqual({ at: noon + 2000, reason: 'no-face' });
    });

    it('starts over on the next local day', () => {
        noteWakeSpent('gate', noon);
        expect(wakeLedger(noon).used).toBe(1);
        expect(wakeLedger(nextNoon).used).toBe(0);
        expect(wakeLedger(nextNoon).lastSpent).toBeUndefined();
    });

    it('survives an unreadable record', () => {
        disk.set('drover-wake-ledger-v1', '{not json');
        expect(wakeLedger(noon)).toEqual({ day: '2026-09-02', used: 0, refused: 0 });
    });

    it('prints one fragment a line for the row', () => {
        noteWakeSpent('gate', noon);
        noteWakeRefused('no-face', noon + 60_000);
        const clock = (at: number) => (at === noon ? '09:41' : '09:42');
        expect(wakeLedgerLines(wakeLedger(noon + 60_000), clock)).toEqual([
            '1 of 50',
            'last: a gate, 09:41',
            'refused: complication on no face, 09:42',
        ]);
        expect(wakeLedgerLines(wakeLedger(nextNoon), clock)).toEqual(['0 of 50']);
    });

    it('can be dropped', () => {
        noteWakeSpent('gate', noon);
        resetWakeLedger();
        expect(wakeLedger(noon).used).toBe(0);
    });
});
