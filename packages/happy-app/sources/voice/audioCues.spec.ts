import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWristCueSwift } from '@/utils/wristCues';
import { ambientForGateKind, audioCues, cueDurationMs, cueSpec, workingCueFor, type AudioCueId } from './audioCues';
import { ambientCue, isWaitingCue, type CueSessionState } from './audioCueState';
import { resolveAudioCues, audioCuesDefaults, muteAudioCue } from '@/sync/settings';

/** The Swift the wrist actually plays, parsed the way wristCues.spec.ts does. */
function wristSwift() {
    return parseWristCueSwift(
        readFileSync(resolve(__dirname, '../../watch/DroverWatch/Shared/WristCue.swift'), 'utf8'),
    );
}

function state(patch: Partial<CueSessionState> = {}): CueSessionState {
    return { reading: true, working: false, pendingKinds: [], agents: 0, speaking: false, ...patch };
}

describe('the cue table', () => {
    it('has a spec for every id in the union', () => {
        // The lookup throws on a miss, so this is the exhaustiveness check the
        // type system cannot make: the union and the table are edited together.
        const ids: AudioCueId[] = [
            'working', 'waitingPermission', 'waitingQuestion', 'waitingNeedsYou', 'waitingExpiry',
            'agentStart', 'agentDone', 'agentFailed', 'toolCall', 'reply', 'skipAhead',
            'micOpen', 'micClosed', 'micRefused',
            'sessionSkipped', 'skipRefused',
        ];
        for (const id of ids) expect(cueSpec(id).id).toBe(id);
        expect(audioCues).toHaveLength(ids.length);
    });

    it('answers a press louder than it reports on an agent (DROVE-225)', () => {
        // The mic cues are the only ones that are a reply to CLAY rather than
        // news about the agent, and an acknowledgement he cannot hear is the
        // failure the ticket exists to prevent. They are the loudest rows in
        // the table, and by a margin over the tool tick that is meant to sit
        // under a sentence.
        const mic: AudioCueId[] = ['micOpen', 'micClosed', 'micRefused'];
        for (const id of mic) {
            expect(cueSpec(id).gain, id).toBeGreaterThanOrEqual(cueSpec('waitingNeedsYou').gain);
            expect(cueSpec(id).gain, id).toBeGreaterThan(cueSpec('toolCall').gain);
        }
    });

    it('answers the double press as loudly as the triple (DROVE-300)', () => {
        // The skip cues are replies to CLAY, like the mic's three, so they
        // belong in the same loud band. A skip he cannot hear is the same
        // failure as a mic he cannot hear: a press that is indistinguishable
        // from a dead button.
        for (const id of ['sessionSkipped', 'skipRefused'] as AudioCueId[]) {
            expect(cueSpec(id).gain, id).toBe(cueSpec('micRefused').gain);
        }
    });

    it('tells the mic from the skip by beat COUNT, not pitch (DROVE-300)', () => {
        // The trick that keeps a fifth and a sixth press cue from being two
        // more ways of saying the same thing. A pocket flattens pitch, so the
        // mic speaks in twos and the skip in threes and the rhythm carries it
        // with the tones thrown away.
        for (const id of ['micOpen', 'micClosed', 'micRefused'] as AudioCueId[]) {
            expect(cueSpec(id).beats).toHaveLength(2);
        }
        for (const id of ['sessionSkipped', 'skipRefused'] as AudioCueId[]) {
            expect(cueSpec(id).beats).toHaveLength(3);
        }
    });

    it('shapes each refusal as its own answer with the movement taken out', () => {
        // Not a separate invention per press: `micRefused` is `micOpen`'s two
        // beats going nowhere and `skipRefused` is `sessionSkipped`'s three
        // going nowhere. That is what makes a refusal recognisable as the
        // refusal OF something rather than as a sixth unrelated noise.
        for (const id of ['micRefused', 'skipRefused'] as AudioCueId[]) {
            expect(new Set(cueSpec(id).beats.map((beat) => beat.hz)).size, id).toBe(1);
        }
        const skipped = cueSpec('sessionSkipped').beats.map((beat) => beat.hz);
        expect(skipped[1]).toBeGreaterThan(skipped[0]);
        expect(skipped[2]).toBeGreaterThan(skipped[1]);
    });

    it('tells the three mic answers apart by shape (DROVE-225)', () => {
        // Rising, falling, and the same note twice going nowhere. Pitch is
        // the polish; a pocket flattens it and the shape survives.
        const open = cueSpec('micOpen');
        const closed = cueSpec('micClosed');
        const refused = cueSpec('micRefused');
        expect(open.beats[1].hz).toBeGreaterThan(open.beats[0].hz);
        expect(closed.beats[1].hz).toBeLessThan(closed.beats[0].hz);
        expect(refused.beats[1].hz).toBe(refused.beats[0].hz);
    });

    it('tells working from waiting by rhythm, not pitch alone', () => {
        // A pocket and a noisy room flatten pitch, so the distinction has to
        // survive with the tones thrown away. Working opens with one long
        // beat, the marker (DROVE-182); every waiting cue is short beats.
        const working = cueSpec('working');
        expect(working.beats[0].ms).toBeGreaterThan(150);
        for (const cue of audioCues.filter((entry) => isWaitingCue(entry.id))) {
            for (const beat of cue.beats) expect(beat.ms).toBeLessThan(150);
        }
    });

    it('gives each waiting cue the beat count the wrist buzzes for that gate', () => {
        // Pinned to the Swift the wrist actually plays, the way wristCues.ts
        // is: the phone and the wrist are supposed to describe the same world,
        // and a count changed on one and not the other is two vocabularies
        // pretending to be one. Count, not texture — a tone engine and a
        // taptic engine have nothing else in common.
        const swift = wristSwift();
        const pairs: [string, AudioCueId][] = [
            ['needsYou', 'waitingNeedsYou'],
            ['question', 'waitingQuestion'],
            ['permission', 'waitingPermission'],
        ];
        for (const [wrist, cue] of pairs) {
            expect(cueSpec(cue).beats.length, cue).toBe(swift.beats[wrist].length);
        }
    });

    it('spends a second beat on expiry, which the wrist says with texture', () => {
        // The one deliberate departure, written down so it is not read as
        // drift. The wrist plays expiry as a single ROUGH tap (`[.failure]`)
        // and roughness is the whole message. A sine has no roughness, so the
        // phone says the same thing with a falling pair instead.
        expect(wristSwift().beats.expiry).toEqual(['failure']);
        expect(cueSpec('waitingExpiry').beats).toHaveLength(2);
        const [first, second] = cueSpec('waitingExpiry').beats;
        expect(second.hz).toBeLessThan(first.hz);
    });

    it('reaches the same cue the wrist does from the same bus kind', () => {
        const swift = wristSwift();
        // `rawValues` also carries the WristBeat enum, so the cue names are
        // taken from the one table that only has cues in it.
        for (const name of Object.keys(swift.beats)) {
            if (name === 'finished') continue;
            expect(ambientForGateKind(swift.rawValues[name]).toLowerCase(), name)
                .toBe(`waiting${name}`.toLowerCase());
        }
    });

    it('ranks the waiting cues the way the wrist ranks its own', () => {
        expect(cueSpec('waitingNeedsYou').rank).toBeGreaterThan(cueSpec('waitingQuestion').rank);
        expect(cueSpec('waitingQuestion').rank).toBeGreaterThan(cueSpec('waitingPermission').rank);
        expect(cueSpec('waitingPermission').rank).toBeGreaterThan(cueSpec('waitingExpiry').rank);
        expect(cueSpec('waitingExpiry').rank).toBeGreaterThan(cueSpec('working').rank);
    });

    it('keeps every EVENT cue short enough to be a cue', () => {
        for (const cue of audioCues.filter((entry) => entry.kind === 'event')) {
            expect(cueDurationMs(cue)).toBeLessThanOrEqual(600);
        }
    });

    it('keeps the counting heartbeat well inside its own cadence', () => {
        // DROVE-182: the figure is a marker plus the subagent count in Morse,
        // and however many are running it has to leave clear silence inside
        // the 6s working cadence or it stops being ambient.
        for (const count of [0, 1, 2, 4, 5, 9, 10, 15, 99]) {
            const spec = cueSpec(workingCueFor(count));
            expect(cueDurationMs(spec)).toBeLessThan(3_000);
        }
        // The numbers, stated: none is 190ms, one subagent 1240ms and ten
        // 2340ms.
        expect(cueDurationMs(cueSpec(workingCueFor(0)))).toBe(190);
        expect(cueDurationMs(cueSpec(workingCueFor(1)))).toBe(1240);
        expect(cueDurationMs(cueSpec(workingCueFor(10)))).toBe(2340);
    });

    it('says the subagent count in Morse digits, most significant first', () => {
        // Five symbols a digit is the whole reason for Morse over ticks: the
        // rhythm is regular at any count, and counting eight ticks by ear is
        // not a thing anyone can do.
        const dits = (count: number) => cueSpec(workingCueFor(count)).beats
            .filter((beat) => beat.hz > 0 && beat.hz !== 196)
            .map((beat) => (beat.ms > 100 ? '-' : '.'))
            .join('');
        expect(dits(1)).toBe('.----');
        expect(dits(4)).toBe('....-');
        expect(dits(8)).toBe('---..');
        expect(dits(10)).toBe('.---------');
        expect(dits(12)).toBe('.----..---');
    });

    it('sounds none as the bare thump, with no digits at all', () => {
        // DROVE-209: the count is subagents only, so a lone session is 0, and
        // 0 in Morse is `-----`, the longest figure on the scale. Spending
        // the longest sound on the commonest state is backwards, so zero is
        // the marker alone and the silence after it says "none", which is
        // what the heartbeat was before the count existed.
        expect(cueSpec(workingCueFor(0)).beats).toEqual([{ hz: 196, ms: 190 }]);
        expect(cueDurationMs(cueSpec(workingCueFor(0))))
            .toBeLessThan(cueDurationMs(cueSpec(workingCueFor(1))));
    });

    it('passes the status row\'s agent count straight through, no offset', () => {
        // The status row counts agents only (DROVE-155) and so does this, from
        // one derivation, so the two surfaces can never differ.
        expect(workingCueFor(0)).toBe('working:0');
        expect(workingCueFor(4)).toBe('working:4');
        expect(workingCueFor(8)).toBe('working:8');
    });

    it('keeps the ticks quieter than the marker thump', () => {
        const beats = cueSpec(workingCueFor(3)).beats.filter((beat) => beat.hz > 0);
        expect(beats[0].gain ?? 1).toBe(1);
        for (const beat of beats.slice(1)) expect(beat.gain ?? 1).toBeLessThan(1);
    });

    it('counts the gaps between beats in the duration', () => {
        const spec = cueSpec('waitingQuestion');
        expect(cueDurationMs(spec)).toBe(spec.beats[0].ms + spec.gapMs + spec.beats[1].ms);
    });

    it('maps a bus gate kind onto a cue, and an unknown kind onto permission', () => {
        expect(ambientForGateKind('todo')).toBe('waitingNeedsYou');
        expect(ambientForGateKind('question')).toBe('waitingQuestion');
        expect(ambientForGateKind('permission')).toBe('waitingPermission');
        expect(ambientForGateKind('expiry')).toBe('waitingExpiry');
        // Silence is the worse failure, so a kind this build never heard of
        // still pulses. Same rule as WristCue.forGateKind.
        expect(ambientForGateKind('something-new')).toBe('waitingPermission');
    });
});

describe('the ambient state machine', () => {
    it('is silent when read-aloud is off', () => {
        expect(ambientCue(state({ reading: false, working: true }))).toBeNull();
        expect(ambientCue(state({ reading: false, pendingKinds: ['question'] }))).toBeNull();
    });

    it('pulses while working with nothing pending', () => {
        // Subagents only, so a lone session is 0 and 0 is the bare thump
        // (DROVE-209).
        expect(ambientCue(state({ working: true }))).toBe('working:0');
        expect(ambientCue(state({ working: true, agents: 4 }))).toBe('working:4');
    });

    it('is silent when idle, because silence is the correct signal', () => {
        expect(ambientCue(state())).toBeNull();
    });

    it('changes character when a gate is pending', () => {
        expect(ambientCue(state({ working: true, pendingKinds: ['question'] }))).toBe('waitingQuestion');
    });

    it('waits on Clay even when nothing is running', () => {
        // A blocked session is not idle. This is the state the product exists
        // to surface and it does not stop being it because the CLI went quiet.
        expect(ambientCue(state({ working: false, pendingKinds: ['permission'] }))).toBe('waitingPermission');
    });

    it('picks the most urgent gate when several are pending', () => {
        expect(ambientCue(state({ pendingKinds: ['permission', 'todo', 'question'] }))).toBe('waitingNeedsYou');
    });

    it('goes silent the instant speech starts, and comes back when it ends', () => {
        const working = state({ working: true, agents: 2 });
        expect(ambientCue(working)).toBe('working:2');
        expect(ambientCue({ ...working, speaking: true })).toBeNull();
        expect(ambientCue(working)).toBe('working:2');
    });

    it('is silent again once the gate is answered', () => {
        expect(ambientCue(state({ working: true, pendingKinds: ['question'] }))).toBe('waitingQuestion');
        expect(ambientCue(state({ working: true, pendingKinds: [] }))).toBe('working:0');
        expect(ambientCue(state({ working: false, pendingKinds: [] }))).toBeNull();
    });
});

describe('the cue settings', () => {
    it('fills in every field from an empty object', () => {
        expect(resolveAudioCues({ audioCues: {} })).toEqual(audioCuesDefaults);
        expect(resolveAudioCues({ audioCues: undefined as never })).toEqual(audioCuesDefaults);
    });

    it('clamps a value another app version pushed past its range', () => {
        const resolved = resolveAudioCues({ audioCues: { volume: 12, workingIntervalSeconds: 0 } });
        expect(resolved.volume).toBe(1);
        expect(resolved.workingIntervalSeconds).toBe(2);
    });

    it('drops junk out of the muted list rather than passing it to the lookup', () => {
        const resolved = resolveAudioCues({ audioCues: { muted: ['working', 'working', 7 as never] } });
        expect(resolved.muted).toEqual(['working']);
    });

    it('silences one cue and un-silences it, leaving the rest alone', () => {
        const muted = muteAudioCue({ audioCues: {} }, 'toolCall', true);
        expect(resolveAudioCues(muted).muted).toEqual(['toolCall']);
        expect(resolveAudioCues(muted).heartbeat).toBe(true);
        expect(resolveAudioCues(muteAudioCue(muted, 'toolCall', false)).muted).toEqual([]);
    });
});
