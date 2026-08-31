import { describe, expect, it } from 'vitest';
import { base64Encode, cueSampleRate, renderCueSamples, renderCueWav } from './cueTone';
import { audioCues, cueDurationMs, cueSpec } from './audioCues';

function ascii(bytes: Uint8Array, at: number, length: number): string {
    return String.fromCharCode(...bytes.slice(at, at + length));
}

function readUint32(bytes: Uint8Array, at: number): number {
    return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
}

describe('cue tones', () => {
    it('renders a cue as long as the table says it is', () => {
        const spec = cueSpec('waitingQuestion');
        const samples = renderCueSamples(spec, 1);
        expect(samples.length).toBe(Math.round((cueDurationMs(spec) / 1000) * cueSampleRate));
    });

    it('leaves the gap between two beats silent, so two beats are two sounds', () => {
        const spec = cueSpec('waitingQuestion');
        const samples = renderCueSamples(spec, 1);
        const gapStart = Math.round((spec.beats[0].ms / 1000) * cueSampleRate) + 5;
        const gapEnd = gapStart + Math.round((spec.gapMs / 1000) * cueSampleRate) - 10;
        for (let i = gapStart; i < gapEnd; i++) expect(samples[i]).toBe(0);
    });

    it('fades each beat in and out, because a click is the wrong texture', () => {
        const samples = renderCueSamples(cueSpec('working'), 1);
        expect(Math.abs(samples[0])).toBeLessThan(0.05);
        expect(Math.abs(samples[samples.length - 1])).toBeLessThan(0.05);
        const loudest = samples.reduce((most, value) => Math.max(most, Math.abs(value)), 0);
        expect(loudest).toBeGreaterThan(0.5);
    });

    it('scales with gain and is silent at zero', () => {
        const loud = renderCueSamples(cueSpec('working'), 1);
        const quiet = renderCueSamples(cueSpec('working'), 0.25);
        const peak = (values: Float32Array) => values.reduce((most, value) => Math.max(most, Math.abs(value)), 0);
        expect(peak(quiet)).toBeLessThan(peak(loud));
        expect(peak(renderCueSamples(cueSpec('working'), 0))).toBe(0);
    });

    it('never leaves a sample outside the range 16-bit PCM can carry', () => {
        for (const spec of audioCues) {
            for (const value of renderCueSamples(spec, 1)) {
                expect(value).toBeGreaterThanOrEqual(-1);
                expect(value).toBeLessThanOrEqual(1);
            }
        }
    });

    it('writes a WAV header a player will accept', () => {
        const spec = cueSpec('agentStart');
        const wav = renderCueWav(spec, 0.5);
        expect(ascii(wav, 0, 4)).toBe('RIFF');
        expect(ascii(wav, 8, 4)).toBe('WAVE');
        expect(ascii(wav, 12, 4)).toBe('fmt ');
        expect(ascii(wav, 36, 4)).toBe('data');
        expect(readUint32(wav, 24)).toBe(cueSampleRate);
        expect(readUint32(wav, 4)).toBe(wav.length - 8);
        expect(readUint32(wav, 40)).toBe(wav.length - 44);
    });

    it('keeps every cue small enough to render and cache without thought', () => {
        for (const spec of audioCues) expect(renderCueWav(spec, 1).length).toBeLessThan(64_000);
    });

    it('encodes base64 the way an encoder does, padding included', () => {
        const bytes = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));
        expect(base64Encode(bytes('any carnal pleasure.'))).toBe('YW55IGNhcm5hbCBwbGVhc3VyZS4=');
        expect(base64Encode(bytes('any carnal pleasure'))).toBe('YW55IGNhcm5hbCBwbGVhc3VyZQ==');
        expect(base64Encode(bytes('any carnal pleasur'))).toBe('YW55IGNhcm5hbCBwbGVhc3Vy');
        expect(base64Encode(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe('//79');
    });

    it('round-trips through base64 without losing a byte', () => {
        const wav = renderCueWav(cueSpec('skipAhead'), 0.7);
        const decoded = Uint8Array.from(Buffer.from(base64Encode(wav), 'base64'));
        expect(decoded.length).toBe(wav.length);
        expect([...decoded.slice(0, 64)]).toEqual([...wav.slice(0, 64)]);
    });
});
