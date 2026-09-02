import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    decideWristNudge,
    parseWristNudgeSwift,
    wristAlreadyDelivered,
    wristNudgeSpec,
    wristNudges,
    type WristNudgeName,
} from './wristNudges';
import { parseWristCueSwift } from './wristCues';

/**
 * The phone's copy of the in-app vocabulary is pinned to the Swift that
 * actually buzzes (DROVE-384), the same way wristCues.spec.ts pins the gate
 * patterns. Three of these nudges are SENT by the phone, so a name changed on
 * the watch and not here is a cue the wrist silently drops.
 */
const nudgeSwift = readFileSync(
    resolve(__dirname, '../../watch/DroverWatch/Shared/WristNudge.swift'),
    'utf8',
);
const parsed = parseWristNudgeSwift(nudgeSwift);
const cueSwift = parseWristCueSwift(
    readFileSync(resolve(__dirname, '../../watch/DroverWatch/Shared/WristCue.swift'), 'utf8'),
);

const names = wristNudges.map((n) => n.nudge);

describe('the in-app nudge table', () => {
    it('names every nudge the Swift enum has, in the same order', () => {
        expect(parsed.cases.length).toBeGreaterThan(0);
        expect(names).toEqual(parsed.cases);
    });

    it('plays the beat the Swift plays', () => {
        for (const spec of wristNudges) {
            expect(parsed.beats[spec.nudge], spec.nudge).toBe(spec.beat);
        }
    });

    it('spends one beat each, which is what makes it a nudge and not a cue', () => {
        // A cue is allowed a pattern because it has to be told apart through a
        // sleeve minutes later. A nudge answers something he did a moment ago
        // while looking at the screen, so a pattern would be showing off.
        for (const spec of wristNudges) expect(typeof spec.beat).toBe('string');
    });

    it('every beat it asks for exists on the wrist', () => {
        // `rawValues` carries the WristBeat enum as well as the cues, which is
        // the one table that has every beat name in it.
        for (const spec of wristNudges) {
            expect(cueSwift.rawValues[spec.beat], spec.beat).toBe(spec.beat);
        }
    });

    it('leads a gate the way that gate leads itself', () => {
        // One vocabulary, not two. The nudge is the FIRST thing a wrist feels
        // when that gate lands; WristCue.beats is the whole of it.
        expect(wristNudgeSpec('needsYou').beat).toBe(cueSwift.beats.needsYou[0]);
        expect(wristNudgeSpec('gateArrived').beat).toBe(cueSwift.beats.permission[0]);
    });

    it('tells the opposites apart', () => {
        expect(wristNudgeSpec('answerSent').beat).not.toBe(wristNudgeSpec('answerRefused').beat);
        expect(wristNudgeSpec('readingStarted').beat).not.toBe(wristNudgeSpec('readingPaused').beat);
    });

    it('leaves the three the phone alone can see to the phone', () => {
        // Read-aloud runs on the phone even when the wrist is the speaker, so
        // these reach the watch as a `cue` message or not at all.
        const fromPhone = wristNudges.filter((n) => n.from === 'phone').map((n) => n.nudge);
        expect(fromPhone).toEqual(['readingStarted', 'readingPaused', 'readingSkipped']);
    });
});

describe('whether a nudge plays', () => {
    const on = { announceHaptic: true, frontmost: true };

    it('reads the clauses the Swift reads, in the order the Swift reads them', () => {
        // The ORDER is the policy: `demo` bypassing the channel is only
        // correct because it is read after the frontmost rule and before
        // everything else. Outcomes alone would pass with them swapped.
        expect(parsed.clauses).toEqual([
            'if !frontmost { return .hush(.notFrontmost) }',
            'if demo { return .play(nudge.beat) }',
            'if !announceHaptic { return .hush(.channelOff) }',
            'if nudge.dedupes && alreadyDelivered { return .hush(.alreadyDelivered) }',
            'return .play(nudge.beat)',
        ]);
    });

    it('plays nothing on a watch that is not on screen', () => {
        // watchOS refuses `WKInterfaceDevice.play` outright off screen. Not a
        // policy anyone gets to override, demo included.
        for (const name of names) {
            expect(decideWristNudge(name, { ...on, frontmost: false, demo: true }), name)
                .toEqual({ hush: 'notFrontmost' });
        }
    });

    it('obeys the synced haptic channel and nothing else', () => {
        for (const name of names) {
            expect(decideWristNudge(name, { ...on, announceHaptic: false }), name)
                .toEqual({ hush: 'channelOff' });
            expect(decideWristNudge(name, on), name)
                .toEqual({ play: wristNudgeSpec(name).beat });
        }
    });

    it('plays a Playground row whatever the channel says', () => {
        // A demo that plays nothing is a broken screen, not a quiet one, and
        // the channel switch is the thing he came there to compare against.
        for (const name of names) {
            expect(
                decideWristNudge(name, {
                    announceHaptic: false,
                    frontmost: true,
                    alreadyDelivered: true,
                    demo: true,
                }),
                name,
            ).toEqual({ play: wristNudgeSpec(name).beat });
        }
    });
});

describe('the todo dedupe', () => {
    it('holds a todo the push already carried', () => {
        expect(wristNudgeSpec('needsYou').dedupes).toBe(true);
        expect(parsed.dedupes).toBe('needsYou');
        expect(
            decideWristNudge('needsYou', { announceHaptic: true, frontmost: true, alreadyDelivered: true }),
        ).toEqual({ hush: 'alreadyDelivered' });
        expect(
            decideWristNudge('needsYou', { announceHaptic: true, frontmost: true, alreadyDelivered: false }),
        ).toEqual({ play: 'notification' });
    });

    it('dedupes nothing else, because nothing else can arrive twice', () => {
        // An answer leaving the watch twice is two answers, not one arrival
        // seen twice, and holding the second would swallow real feedback.
        for (const spec of wristNudges) {
            if (spec.nudge === 'needsYou') continue;
            expect(spec.dedupes, spec.nudge).toBe(false);
            expect(
                decideWristNudge(spec.nudge, { announceHaptic: true, frontmost: true, alreadyDelivered: true }),
                spec.nudge,
            ).toEqual({ play: spec.beat });
        }
    });

    it('names the ids another path won the claim for, and only those', () => {
        // The phone claims every cue id before any path carries it, so what
        // comes back from the claim is what THIS publish owns; the rest were
        // taken by the background task the silent wake push launched.
        const raised = ['s1:a', 's1:b', 'finished:s2'];
        expect(wristAlreadyDelivered(raised, ['s1:b'])).toEqual(['s1:a', 'finished:s2']);
    });

    it('names nothing when this publish won every claim', () => {
        const raised = ['s1:a', 's1:b'];
        expect(wristAlreadyDelivered(raised, raised)).toEqual([]);
        expect(wristAlreadyDelivered([], [])).toEqual([]);
    });

    it('names everything when the publish claimed nothing at all', () => {
        // The seeded first publish of a run, and every background-carried
        // arrival: the wrist must not buzz a second time for either.
        expect(wristAlreadyDelivered(['s1:a'], [])).toEqual(['s1:a']);
    });

    it('is a set membership test, not an index one', () => {
        // Order is not promised: the ledger returns the ids it did not know,
        // in whatever order they were handed in.
        expect(wristAlreadyDelivered(['a', 'b', 'c'], ['c', 'a'])).toEqual(['b']);
    });
});

describe('the wire names', () => {
    it('keeps DROVE-92 spelling alive for a watch a build behind', () => {
        // TestFlight is not OTA, so the phone can be days ahead of the watch
        // binary. `reply` is what cueWatchReplyStart has always sent.
        expect(nudgeSwift).toContain('if wire == "reply" { return .readingStarted }');
    });

    it('sends only names the watch can decode', () => {
        const decodable = new Set<string>([...parsed.cases, 'reply']);
        for (const spec of wristNudges.filter((n) => n.from === 'phone')) {
            expect(decodable.has(spec.nudge), spec.nudge).toBe(true);
        }
    });
});

const _typecheck: WristNudgeName = 'flipLanded';
void _typecheck;
