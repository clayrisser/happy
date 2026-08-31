import { cueDurationMs, type AudioCueSpec } from './audioCues';

/**
 * Cues rendered as sound, in JavaScript (DROVE-112).
 *
 * No asset files and no Swift. Two reasons, and the second is the one that
 * decided it. A .wav per cue would be a binary blob per sound in a repo with
 * eleven live lanes, and every change to a rhythm would be a re-record rather
 * than a diff. And Clay has said he does not want a TestFlight build right
 * now, so anything that needed a native tone generator would not reach his
 * phone at all: this ships in the JS bundle and arrives over the air.
 *
 * Sixteen-bit mono PCM at 16 kHz, which is far more than a sine at 200 Hz to
 * 1.8 kHz needs and keeps every cue well under a few tens of kilobytes.
 *
 * The envelope matters more than it looks. A tone that starts and stops at
 * full amplitude clicks, and a click is exactly the wrong texture for a sound
 * whose whole job is to be unobtrusive, so each beat fades in and out over a
 * few milliseconds.
 */

export const cueSampleRate = 16_000;
/** Fade in and out of each beat. Long enough to kill the click, short enough to keep the attack. */
const envelopeMs = 6;

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
}

/**
 * The cue's samples, in -1..1, at `gain` overall loudness.
 *
 * Separate from the WAV wrapper so the shape can be asserted directly: the
 * spec checks that a gap really is silence and that a beat really does start
 * and end near zero.
 */
export function renderCueSamples(spec: AudioCueSpec, gain: number): Float32Array {
    const level = Math.max(0, Math.min(1, gain));
    const total = Math.max(1, Math.round((cueDurationMs(spec) / 1000) * cueSampleRate));
    const samples = new Float32Array(total);
    const envelope = Math.max(1, Math.round((envelopeMs / 1000) * cueSampleRate));
    let cursor = 0;
    for (let index = 0; index < spec.beats.length; index++) {
        if (index > 0) cursor += Math.round((spec.gapMs / 1000) * cueSampleRate);
        const beat = spec.beats[index];
        const length = Math.round((beat.ms / 1000) * cueSampleRate);
        // Per-beat loudness (DROVE-182): the heartbeat's agent ticks are
        // quieter than its thump, and both live in one figure.
        const beatLevel = level * Math.max(0, Math.min(1, beat.gain ?? 1));
        for (let i = 0; i < length && cursor + i < total; i++) {
            const fade = Math.min(1, Math.min(i, length - 1 - i) / envelope);
            samples[cursor + i] = beatLevel * fade * Math.sin((2 * Math.PI * beat.hz * i) / cueSampleRate);
        }
        cursor += length;
    }
    return samples;
}

/** A RIFF/WAVE file around `renderCueSamples`, ready to hand to a player. */
export function renderCueWav(spec: AudioCueSpec, gain: number): Uint8Array {
    const samples = renderCueSamples(spec, gain);
    const dataBytes = samples.length * 2;
    const bytes = new Uint8Array(44 + dataBytes);
    writeAscii(bytes, 0, 'RIFF');
    writeUint32(bytes, 4, 36 + dataBytes);
    writeAscii(bytes, 8, 'WAVE');
    writeAscii(bytes, 12, 'fmt ');
    writeUint32(bytes, 16, 16);
    writeUint16(bytes, 20, 1);
    writeUint16(bytes, 22, 1);
    writeUint32(bytes, 24, cueSampleRate);
    writeUint32(bytes, 28, cueSampleRate * 2);
    writeUint16(bytes, 32, 2);
    writeUint16(bytes, 34, 16);
    writeAscii(bytes, 36, 'data');
    writeUint32(bytes, 40, dataBytes);
    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        // Asymmetric on purpose: 16-bit PCM runs -32768..32767, and scaling the
        // positive side by 32768 wraps a full-scale sample to the deepest
        // negative one, which is the loudest click the format can make.
        const value = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
        writeUint16(bytes, 44 + i * 2, value < 0 ? value + 0x10000 : value);
    }
    return bytes;
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64, written out rather than borrowed.
 *
 * `btoa` is not on React Native's global and Buffer is a polyfill this app
 * does not carry into every entry point. The input is a few tens of kilobytes
 * once per cue per launch, so the loop is not worth optimising.
 */
export function base64Encode(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += base64Alphabet[a >> 2];
        out += base64Alphabet[((a & 0x03) << 4) | (b >> 4)];
        out += i + 1 < bytes.length ? base64Alphabet[((b & 0x0f) << 2) | (c >> 6)] : '=';
        out += i + 2 < bytes.length ? base64Alphabet[c & 0x3f] : '=';
    }
    return out;
}
