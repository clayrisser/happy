/**
 * Render every audio cue to a wav on disk, for measurement (DROVE-341).
 *
 * There are no cue ASSETS in this repo: every cue is a sine burst synthesised
 * by sources/voice/cueTone.ts, which is why the usual "normalise the files with
 * ffmpeg loudnorm and keep the originals" does not apply. The generator IS the
 * original. So this script renders what the app renders, from the same code the
 * app runs, and scripts/measure-cue-loudness.sh measures the result.
 *
 * Two files per cue:
 *
 *   <id>.wav       exactly what cuePlayer writes into the cache and plays.
 *   <id>.tone.wav  the cue's principal tone with every rest and gap removed and
 *                  the result repeated to three seconds. See toneOnly for what
 *                  "principal" leaves out and why.
 *
 * The second one exists because integrated LUFS is gated in 400 ms blocks, and
 * most cues are shorter than that -- the working thump is 190 ms. Measuring the
 * played file would report the loudness of a mostly-silent three-note pattern,
 * which is a real number about the wrong question. What has to match the voice
 * is how loud the BEEP is while it is sounding, and that is what the tone file
 * carries.
 *
 * Usage: npx tsx scripts/render-cues.ts <out-dir>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audioCues, cueSpec, workingCueFor, type AudioCueSpec } from '../sources/voice/audioCues';
import { expectedLufs } from '../sources/voice/cueLoudness';
import { cueSampleRate, renderCueSamples, renderCueWav } from '../sources/voice/cueTone';

/** Three seconds of tone gives the loudness meter seven whole gating blocks. */
const measureSeconds = 3;

/** A RIFF/WAVE wrapper, the same one cueTone writes, around arbitrary samples. */
function wavFrom(samples: Float32Array): Uint8Array {
    const spec: AudioCueSpec = {
        id: 'toolCall',
        kind: 'event',
        beats: [{ hz: 0, ms: 0 }],
        gapMs: 0,
        amplitude: 1,
        rank: 0,
        title: '',
        meaning: '',
    };
    // renderCueWav owns the header, and it is the header the player accepts, so
    // the wrapper is borrowed rather than written a second time here.
    const header = renderCueWav(spec, 0).slice(0, 44);
    const bytes = new Uint8Array(44 + samples.length * 2);
    bytes.set(header, 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 36 + samples.length * 2, true);
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), true);
    }
    return bytes;
}

/**
 * The cue's PRINCIPAL tone, looped to `measureSeconds`.
 *
 * Principal, not all of it, and the heartbeat is why. `beat.gain` shades one
 * beat against another inside a single sound -- the working pulse is a marker
 * thump followed by the subagent count in Morse, seven dB down (DROVE-182) --
 * and averaging that shading into the cue's headline level is measuring the
 * wrong thing. Six hundred milliseconds of deliberately quiet ticks pulled the
 * working figure five dB under its claim on the first run of this script, which
 * would have been read as the calibration being wrong rather than the question.
 * What the table states, and what an ear judges, is how loud the cue's loudest
 * beat is. So: the beats at the top gain, and only those.
 *
 * Rendered beat by beat rather than by trimming the finished samples, so the
 * fade at each end of each beat survives: a hard cut between two beats would
 * add a click, and a click reads to the meter as loudness that is not there.
 */
function toneOnly(spec: AudioCueSpec): Float32Array {
    const audible = spec.beats.filter((beat) => beat.hz > 0);
    if (audible.length === 0) return new Float32Array(0);
    const top = audible.reduce((most, beat) => Math.max(most, beat.gain ?? 1), 0);
    const sounding = audible.filter((beat) => (beat.gain ?? 1) === top);
    const one = renderCueSamples({ ...spec, beats: sounding, gapMs: 0 }, spec.amplitude);
    const total = Math.round(measureSeconds * cueSampleRate);
    const out = new Float32Array(total);
    for (let i = 0; i < total; i++) out[i] = one[i % one.length];
    return out;
}

function main(): void {
    const outDir = process.argv[2];
    if (!outDir) {
        process.stderr.write('usage: npx tsx scripts/render-cues.ts <out-dir>\n');
        process.exit(2);
    }
    mkdirSync(outDir, { recursive: true });

    // The table, plus one working count, because `working:<n>` is built on
    // demand and is the one family that could drift off the table unnoticed.
    const specs = [...audioCues, cueSpec(workingCueFor(3))];
    const manifest = specs.map((spec) => {
        const played = renderCueWav(spec, spec.amplitude);
        const tone = wavFrom(toneOnly(spec));
        const name = spec.id.replace(/[^a-zA-Z0-9]+/g, '-');
        writeFileSync(join(outDir, `${name}.wav`), played);
        writeFileSync(join(outDir, `${name}.tone.wav`), tone);
        return {
            id: spec.id,
            file: `${name}.tone.wav`,
            amplitude: spec.amplitude,
            expectedLufs: Number(expectedLufs(spec.amplitude).toFixed(2)),
        };
    });
    writeFileSync(join(outDir, 'cues.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`rendered ${manifest.length} cues into ${outDir}\n`);
}

main();
