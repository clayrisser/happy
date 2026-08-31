import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseWristCueSwift, wristBeatGap, wristCueDurationMs, wristCues } from './wristCues';

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

import { canBuzzWatch, demoBuzzGate } from './wristCues';

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

    it('can summon every gate cue and not the session-finished one', () => {
        expect(wristCues.filter(canBuzzWatch).map((c) => c.cue)).toEqual(['needsYou', 'question', 'permission', 'expiry']);
    });
});
