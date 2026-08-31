import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    describeWristFidelity,
    parseWristCueSwift,
    wristBeatGap,
    wristCueDurationMs,
    wristCues,
} from './wristCues';

/**
 * The phone's copy of the wrist vocabulary is pinned to the Swift that
 * actually buzzes (DROVE-75). A pattern changed on the watch and not here
 * would have the demo teaching a buzz the wrist no longer makes, which is
 * worse than no demo: it is a wrong answer delivered with confidence.
 */
const swift = readFileSync(
    resolve(__dirname, '../../watch/DroverWatch/Shared/WristCue.swift'),
    'utf8',
);
const parsed = parseWristCueSwift(swift);

describe('the wrist cue table', () => {
    it('names every cue the Swift enum has, and no other', () => {
        const swiftCues = Object.keys(parsed.beats).sort();
        expect(swiftCues.length).toBeGreaterThan(0);
        expect(wristCues.map((c) => c.cue).sort()).toEqual(swiftCues);
    });

    it('plays the same beats, in the same order, as WristCue.beats', () => {
        for (const cue of wristCues) {
            expect(cue.beats, cue.cue).toEqual(parsed.beats[cue.cue]);
        }
    });

    it('ranks them as WristCue.rank does, most urgent first', () => {
        for (const cue of wristCues) {
            expect(cue.rank, cue.cue).toBe(parsed.ranks[cue.cue]);
        }
        const ranks = wristCues.map((c) => c.rank);
        expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    });

    it('titles them as WristCue.headline does', () => {
        for (const cue of wristCues) {
            expect(cue.headline, cue.cue).toBe(parsed.headlines[cue.cue]);
        }
    });

    it('uses the wire kind the Swift raw value names', () => {
        // `needsYou` is spelled `todo` on the wire, and the Swift file says
        // why: selection is by raw value, so any other spelling drops a
        // needs-you request onto the permission cue.
        for (const cue of wristCues) {
            expect(cue.wire, cue.cue).toBe(parsed.rawValues[cue.cue]);
        }
        expect(wristCues.find((c) => c.cue === 'needsYou')?.wire).toBe('todo');
    });

    it('waits the same gap between beats', () => {
        expect(parsed.beatGap).not.toBeNull();
        expect(wristBeatGap).toBe(parsed.beatGap);
    });

    it('feels different for every cue, count as well as texture', () => {
        const seen = new Set<string>();
        for (const cue of wristCues) {
            const key = cue.beats.join(',');
            expect(seen.has(key), cue.cue).toBe(false);
            seen.add(key);
        }
    });

    it('knows how long a pattern takes, so back-to-back playback can wait it out', () => {
        const three = wristCues.find((c) => c.beats.length === 3)!;
        expect(wristCueDurationMs(three)).toBe(2 * wristBeatGap * 1000);
        const one = wristCues.find((c) => c.beats.length === 1)!;
        expect(wristCueDurationMs(one)).toBe(0);
    });
});

import { demoBuzzGate, demoFinishSession, wristCueIsGate } from './wristCues';

describe('the demo buzz gate for the wrist', () => {
    it('is a fresh demo-namespaced gate of the cue\'s wire kind', () => {
        const needsYou = wristCues.find((c) => c.cue === 'needsYou')!;
        const gate = demoBuzzGate(needsYou, 1_700_000_000_000);
        expect(gate.id.startsWith('demo:')).toBe(true);
        expect(gate.kind).toBe('todo');
        expect(gate.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
        expect(gate.title).toBe('Demo · Do something');
        expect(gate.account).toBe('demo');
    });

    it('gets a new id per tap, so the wrist\'s dedupe buzzes again', () => {
        const spec = wristCues[0];
        expect(demoBuzzGate(spec, 1).id).not.toBe(demoBuzzGate(spec, 2).id);
    });

    it('names the four cues the wrist reaches through a gate', () => {
        expect(wristCues.filter(wristCueIsGate).map((c) => c.cue)).toEqual(['needsYou', 'question', 'permission', 'expiry']);
    });

    it('leaves the session-finished cue to the session builder', () => {
        expect(wristCues.filter((c) => !wristCueIsGate(c)).map((c) => c.cue)).toEqual(['finished']);
    });
});

/**
 * The other way into the wrist (DROVE-222). `finished` is not a gate kind, so
 * WristCueDiff only ever emits it for a session that WAS active and is not.
 * Both halves therefore have to carry the same id, or the watch sees one
 * session appear and a different one vanish and stays silent.
 */
describe('the demo session staged so the wrist plays "Session finished"', () => {
    it('is one demo-namespaced id, running then stopped', () => {
        const running = demoFinishSession(true, 1_700_000_000_000);
        const stopped = demoFinishSession(false, 1_700_000_000_000);
        expect(running.id).toBe(stopped.id);
        expect(running.id.startsWith('demo:')).toBe(true);
        expect(running.active).toBe(true);
        expect(stopped.active).toBe(false);
    });

    it('says on the wrist that it is a demo, and which account', () => {
        const session = demoFinishSession(true, 1);
        expect(session.title).toBe('Demo \u00b7 Session finished');
        expect(session.account).toBe('demo');
    });

    it('carries the phone\'s own words for working and stopped', () => {
        expect(demoFinishSession(true, 1).state).toBe('thinking');
        expect(demoFinishSession(false, 1).state).toBe('disconnected');
    });

    it('gets a new id per tap, so a second tap is a second stop', () => {
        expect(demoFinishSession(true, 1).id).not.toBe(demoFinishSession(true, 2).id);
    });
});

/**
 * The claim the app is allowed to make about a CLOSED watch app (DROVE-124).
 * Every row on the demo screen used to promise "the real pattern", which is
 * only ever true while the watch app is on screen.
 */
describe('what the wrist will actually feel', () => {
    const closed = { paired: true, installed: true, reachable: false, wakes: 40 };

    it('says nothing reaches a wrist when there is no wrist', () => {
        expect(describeWristFidelity(null).fidelity).toBe('none');
        expect(describeWristFidelity({ ...closed, paired: false }).fidelity).toBe('none');
        expect(describeWristFidelity({ ...closed, installed: false }).fidelity).toBe('none');
    });

    it('promises the real pattern only while the watch app is open', () => {
        expect(describeWristFidelity({ ...closed, reachable: true }).fidelity).toBe('pattern');
        expect(describeWristFidelity(closed).fidelity).toBe('systemTap');
    });

    it('does not claim a per-kind pattern the closed app cannot play', () => {
        expect(describeWristFidelity(closed).detail).toContain('watchOS');
        expect(describeWristFidelity(closed).detail).toContain('on screen');
    });

    it('names the complication when the wake budget is zero', () => {
        const dead = describeWristFidelity({ ...closed, wakes: 0 });
        expect(dead.fidelity).toBe('silent');
        expect(dead.detail).toContain('complication');
    });

    it('assumes a wake is possible on a build that cannot count them', () => {
        const noBudget = { paired: true, installed: true, reachable: false };
        expect(describeWristFidelity(noBudget).fidelity).toBe('systemTap');
    });

    it('gives every verdict something to read and something to do', () => {
        for (const status of [null, closed, { ...closed, reachable: true }, { ...closed, wakes: 0 }]) {
            const verdict = describeWristFidelity(status);
            expect(verdict.headline.length).toBeGreaterThan(0);
            expect(verdict.detail.length).toBeGreaterThan(0);
        }
    });
});
