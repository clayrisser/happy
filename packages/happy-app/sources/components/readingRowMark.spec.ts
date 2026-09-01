import { describe, expect, it } from 'vitest';
import { readingRowMark, readingRowMarkLabel } from './readingRowMark';
import { audioOutButton } from './composerAudioOut';
import type { ReadingSessionState } from '@/voice/readingVoice';

const states: ReadingSessionState[] = ['off', 'reading', 'yielded', 'paused'];

describe('the reading mark on a session row (DROVE-297)', () => {
    it('draws nothing at all when reading is off', () => {
        expect(readingRowMark('off')).toBeNull();
    });

    it('tells the three states apart that the ticket names', () => {
        const off = readingRowMark('off');
        const reading = readingRowMark('reading');
        const yielded = readingRowMark('yielded');
        expect(off).toBeNull();
        expect(reading).not.toBeNull();
        expect(yielded).not.toBeNull();
        // The visible half of the rule: armed-and-silent must not look like
        // switched-off, or the behaviour is mysterious rather than legible.
        expect(reading).not.toEqual(yielded);
    });

    it('gives every drawn state a pair no other state has', () => {
        const drawn = states
            .map((state) => readingRowMark(state))
            .filter((mark): mark is NonNullable<typeof mark> => mark !== null);
        const pairs = drawn.map((mark) => `${mark.glyph}/${mark.fill}`);
        expect(new Set(pairs).size).toBe(pairs.length);
    });

    it('says whether it WILL speak with the glyph and whether it IS with the fill', () => {
        // Two carriers, one question each (DROVE-215, DROVE-236). A session
        // that will speak when its turn comes wears the speaker whether or not
        // it has the voice; only the one with the voice wears the accent.
        expect(readingRowMark('reading')?.glyph).toBe(readingRowMark('yielded')?.glyph);
        expect(readingRowMark('reading')?.fill).not.toBe(readingRowMark('yielded')?.fill);
        expect(readingRowMark('paused')?.glyph).not.toBe(readingRowMark('yielded')?.glyph);
        expect(readingRowMark('paused')?.fill).toBe(readingRowMark('yielded')?.fill);
    });

    it('invents no vocabulary the composer capsule does not already have', () => {
        // The mark on the row and the control inside the session must not come
        // to mean different things, so both read from `composerAudioOut`.
        const reading = audioOutButton({ readAloudEnabled: true });
        const paused = audioOutButton({ readAloudEnabled: true, paused: true });
        expect(readingRowMark('reading')).toMatchObject({ glyph: reading.glyph, fill: reading.fill });
        expect(readingRowMark('paused')).toMatchObject({ glyph: paused.glyph, fill: paused.fill });
        // A yield is the capsule's amber face wearing the speaker, which is
        // exactly the two faces recombined and nothing new.
        expect(readingRowMark('yielded')).toMatchObject({ glyph: reading.glyph, fill: paused.fill });
    });

    it('announces the three as three different things', () => {
        const said = states
            .map((state) => readingRowMark(state))
            .filter((mark): mark is NonNullable<typeof mark> => mark !== null)
            .map(readingRowMarkLabel);
        expect(new Set(said).size).toBe(said.length);
    });
});
