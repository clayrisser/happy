import { describe, expect, it } from 'vitest';
import { audioCues, cueSpec, workingCueFor, type AudioCueId } from './audioCues';
import {
    amplitudeToDb,
    cueAmplitudeFor,
    cueAmplitudeWithOffset,
    cueOffsetDb,
    cueOffsetRangeDb,
    cuePeakCeiling,
    cueGainDb,
    cueUnityAmplitude,
    dbToAmplitude,
    expectedLufs,
    morseTickDb,
    sineFullScaleLufs,
    voiceReferenceLufs,
    type CueGainKey,
} from './cueLoudness';
import { renderCueSamples } from './cueTone';

/**
 * The cue loudness table, pinned (DROVE-341).
 *
 * The whole point of moving from a bare multiplier to dB against the voice is
 * that the claim becomes checkable, so these tests check the claim rather than
 * restating the numbers. The one place a literal IS repeated is the table
 * itself: a row moved there has to be moved here too, which is exactly the
 * friction wanted on a number Clay hears.
 *
 * The other half of the check is scripts/measure-cue-loudness.sh, which
 * measures the rendered wav with ffmpeg. This half is arithmetic and runs in
 * CI; that half is acoustics and runs on a machine with ffmpeg on it.
 */

function peak(values: Float32Array): number {
    return values.reduce((most, value) => Math.max(most, Math.abs(value)), 0);
}

describe('cue loudness', () => {
    it('puts a cue at 0 dB level with the voice', () => {
        // A full-scale sine measures -3 LUFS, so the amplitude that lands on
        // the voice reference is 10^((-16 + 3) / 20). Written out rather than
        // recomputed from the same expression the source uses, so a typo in
        // the source cannot agree with a typo here.
        expect(cueUnityAmplitude).toBeCloseTo(0.2239, 4);
        expect(expectedLufs(cueUnityAmplitude)).toBeCloseTo(voiceReferenceLufs, 6);
        expect(voiceReferenceLufs).toBe(-16);
        expect(sineFullScaleLufs).toBe(-3);
    });

    it('never puts a cue above the voice', () => {
        // A beep that shouts over a spoken sentence is the opposite bug, and
        // just as unpleasant. Zero is the ceiling.
        for (const [id, db] of Object.entries(cueGainDb)) {
            expect(db, id).toBeLessThanOrEqual(0);
        }
    });

    it('pins the level of every cue, in dB against the voice', () => {
        // The table, restated. Change one and change it here, on purpose.
        expect(cueGainDb).toEqual({
            micOpen: 0,
            micClosed: 0,
            micRefused: 0,
            sessionSkipped: 0,
            skipRefused: 0,
            waitingNeedsYou: 0,
            waitingQuestion: 0,
            waitingPermission: 0,
            waitingExpiry: 0,
            working: 0,
            agentStart: -2,
            agentFailed: -2,
            agentDone: -3,
            skipAhead: -4,
            reply: -5,
            toolCall: -8,
        });
        expect(morseTickDb).toBe(-7);
    });

    it('puts the heartbeat AT the voice, which is the second ask (DROVE-385)', () => {
        // DROVE-341 asked for within three dB and got two, and Clay came back:
        // "please boost the audio more so that the beeps are basically the
        // same level of loudness as the voice." So the bar is no longer a
        // band, it is the number: the ambient family sits ON the reference.
        // The old three-dB bar is still satisfied and is no longer the claim.
        expect(cueGainDb.working).toBe(0);
        for (const id of ['waitingNeedsYou', 'waitingQuestion', 'waitingPermission', 'waitingExpiry'] as const) {
            expect(cueGainDb[id], id).toBe(0);
        }
        expect(cueAmplitudeFor('working')).toBeCloseTo(cueUnityAmplitude, 12);
    });

    it('answers a press at the very top of the table', () => {
        // DROVE-225's rule, now sayable, and DROVE-300's two skip answers hold
        // to it as well: a press answer is at 0 dB, so nothing in the table is
        // louder than the answer to a press.
        const pressAnswers: CueGainKey[] = [
            'micOpen', 'micClosed', 'micRefused', 'sessionSkipped', 'skipRefused',
        ];
        for (const id of pressAnswers) {
            expect(cueGainDb[id], id).toBe(0);
        }
        // The AMBIENT family joined them at the ceiling in DROVE-385, so this
        // is no longer "the only rows at 0" — it is "nothing is above them",
        // which is the rule that was actually being defended. The strict
        // ordering that remains is against the EVENTS, and that is asserted
        // rather than implied.
        const ambient = new Set<string>([
            ...pressAnswers,
            'working', 'waitingNeedsYou', 'waitingQuestion', 'waitingPermission', 'waitingExpiry',
        ]);
        for (const [id, db] of Object.entries(cueGainDb)) {
            expect(db, id).toBeLessThanOrEqual(0);
            if (ambient.has(id)) continue;
            expect(db, id).toBeLessThan(0);
        }
    });

    it('keeps the events in the order DROVE-341 argued for, two dB higher', () => {
        // The whole table moved up by two so the heartbeat could reach the
        // voice, and the events moved WITH it: the spacing between them is the
        // argument about how much each one interrupts, and shifting it would
        // have been a second change smuggled in under the first.
        expect(cueGainDb.agentStart).toBe(cueGainDb.agentFailed);
        expect(cueGainDb.agentStart - cueGainDb.agentDone).toBe(1);
        expect(cueGainDb.agentDone - cueGainDb.skipAhead).toBe(1);
        expect(cueGainDb.skipAhead - cueGainDb.reply).toBe(1);
        expect(cueGainDb.reply - cueGainDb.toolCall).toBe(3);
        expect(cueGainDb.working - cueGainDb.agentStart).toBe(2);
    });

    it('applies the trim on top of the table, once, and clamps it', () => {
        // The trim is Clay's, not the table's (DROVE-385): the table says what
        // a cue is worth against the voice and this says how far off that his
        // ear wants it. It multiplies the table's amplitude and nothing else —
        // the volume slider is still the player's volume alone, which is what
        // stops DROVE-341's squared gain coming back in a new coat.
        expect(cueOffsetRangeDb).toEqual({ min: -12, max: 12 });
        expect(cueAmplitudeFor('working', 0)).toBeCloseTo(cueAmplitudeFor('working'), 12);
        expect(amplitudeToDb(cueAmplitudeFor('working', 6)) - amplitudeToDb(cueAmplitudeFor('working')))
            .toBeCloseTo(6, 10);
        expect(amplitudeToDb(cueAmplitudeFor('toolCall', -6)) - amplitudeToDb(cueAmplitudeFor('toolCall')))
            .toBeCloseTo(-6, 10);
        // Out of range, not a number, or missing: the table's own level.
        for (const bad of [99, -99, Number.NaN, undefined, null]) {
            const clamped = cueOffsetDb(bad as number);
            expect(clamped).toBeGreaterThanOrEqual(cueOffsetRangeDb.min);
            expect(clamped).toBeLessThanOrEqual(cueOffsetRangeDb.max);
        }
        expect(cueOffsetDb(Number.NaN)).toBe(0);
        expect(cueOffsetDb(undefined)).toBe(0);
        expect(cueOffsetDb(99)).toBe(cueOffsetRangeDb.max);
    });

    it('never renders a cue loud enough to clip, even at the top of the trim', () => {
        // A clamp inside renderCueWav turns a sine into a square, which is a
        // harsher sound arriving exactly when he asked for MORE. The unity
        // amplitude is 0.224, so +12 dB is 0.89 and the headroom is real; this
        // is what fails if a future row or a wider trim eats it.
        for (const spec of audioCues) {
            const hot = cueAmplitudeWithOffset(spec.amplitude, cueOffsetRangeDb.max);
            expect(hot, spec.id).toBeLessThanOrEqual(cuePeakCeiling);
            expect(peak(renderCueSamples(spec, hot)), spec.id).toBeLessThan(1);
        }
    });

    it('keeps the tool tick well under a spoken sentence', () => {
        // It is the one cue whose job is to be heard UNDER the voice rather
        // than beside it, and it is the quietest row by a margin.
        expect(cueGainDb.toolCall).toBeLessThanOrEqual(-8);
        for (const [id, db] of Object.entries(cueGainDb)) {
            if (id === 'toolCall') continue;
            expect(db, id).toBeGreaterThan(cueGainDb.toolCall);
        }
    });

    it('gives every cue in the table an amplitude from the table of levels', () => {
        for (const spec of audioCues) {
            const key = (spec.id === 'working' ? 'working' : spec.id) as CueGainKey;
            expect(cueGainDb[key], spec.id).toBeDefined();
            expect(spec.amplitude, spec.id).toBeCloseTo(cueAmplitudeFor(key), 12);
        }
    });

    it('gives every working count the heartbeat level, however many agents are out', () => {
        // `working:<n>` is built on demand rather than tabled, so it is the one
        // family that could drift off the table without anything noticing.
        for (const count of [0, 1, 4, 12, 99]) {
            const id = workingCueFor(count);
            expect(cueSpec(id).amplitude, id).toBeCloseTo(cueAmplitudeFor('working'), 12);
        }
    });

    it('renders each cue at the amplitude its level claims', () => {
        // The arithmetic end to end: table -> dB -> amplitude -> samples. The
        // envelope means the very peak is a shade under, so this allows a
        // fraction of a dB rather than demanding an exact hit.
        for (const spec of audioCues) {
            const measured = peak(renderCueSamples(spec, spec.amplitude));
            expect(amplitudeToDb(measured) - amplitudeToDb(spec.amplitude), spec.id)
                .toBeGreaterThan(-0.5);
            // The samples are a Float32Array, so a peak that lands exactly on
            // the amplitude comes back a few parts in a billion above it.
            expect(measured, spec.id).toBeLessThanOrEqual(spec.amplitude * (1 + 1e-6));
        }
    });

    it('keeps the Morse ticks under the marker thump, in dB (DROVE-182)', () => {
        const beats = cueSpec(workingCueFor(3)).beats.filter((beat) => beat.hz > 0);
        expect(beats[0].gain ?? 1).toBe(1);
        for (const beat of beats.slice(1)) {
            expect(beat.gain ?? 1).toBeCloseTo(dbToAmplitude(morseTickDb), 12);
        }
    });

    it('round-trips dB and amplitude', () => {
        for (const db of [0, -1, -2, -4, -6, -10, -20]) {
            expect(amplitudeToDb(dbToAmplitude(db))).toBeCloseTo(db, 10);
        }
        expect(amplitudeToDb(0)).toBe(Number.NEGATIVE_INFINITY);
        expect(amplitudeToDb(-1)).toBe(Number.NEGATIVE_INFINITY);
    });

    it('leaves no cue in the table without a level', () => {
        // The table of levels and the table of sounds are edited together, and
        // this is what fails when only one of them moves.
        const tabled = new Set<string>(audioCues.map((cue) => cue.id as AudioCueId));
        for (const key of Object.keys(cueGainDb)) expect(tabled.has(key), key).toBe(true);
        expect(Object.keys(cueGainDb).length).toBe(audioCues.length);
    });
});
