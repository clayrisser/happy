import { describe, expect, it } from 'vitest';
import { chunkStreamed } from './sentenceStream';

/**
 * A reply as it streams: each entry is the text so far, growing by a few
 * tokens at a time, the way a token stream lands.
 */
const stream = [
    'The tests',
    'The tests pass now',
    'The tests pass now. Two files',
    'The tests pass now. Two files changed, e.g.',
    'The tests pass now. Two files changed, e.g. the reducer',
    'The tests pass now. Two files changed, e.g. the reducer and its spec. Nothing',
    'The tests pass now. Two files changed, e.g. the reducer and its spec. Nothing else moved.',
];

describe('chunkStreamed', () => {
    it('speaks only whole sentences and holds the unfinished tail', () => {
        const seen: string[][] = stream.map((text) => chunkStreamed(text, false).complete);
        expect(seen[0]).toEqual([]);
        expect(seen[1]).toEqual([]);
        expect(seen[2]).toEqual(['The tests pass now.']);
        // "e.g." at the edge of the stream is not a sentence end.
        expect(seen[3]).toEqual(['The tests pass now.']);
        expect(seen[4]).toEqual(['The tests pass now.']);
        expect(seen[5]).toEqual(['The tests pass now.', 'Two files changed, e.g. the reducer and its spec.']);
        expect(seen[6]).toEqual([
            'The tests pass now.',
            'Two files changed, e.g. the reducer and its spec.',
            'Nothing else moved.',
        ]);
    });

    it('reports the pending tail so the reader can flush it when the message ends', () => {
        expect(chunkStreamed(stream[1], false)).toEqual({ complete: [], pending: 'The tests pass now' });
        expect(chunkStreamed(stream[5], false).pending).toBe('Nothing');
        expect(chunkStreamed(stream[6], false).pending).toBeNull();
    });

    it('speaks the tail as it stands once the message is final', () => {
        expect(chunkStreamed('The tests pass now. Two files', true)).toEqual({
            complete: ['The tests pass now.', 'Two files'],
            pending: null,
        });
    });

    it('waits for the word after a full stop before cutting on an unlisted abbreviation', () => {
        expect(chunkStreamed('Ask Sgt. pepper about it.', false).complete).toEqual(['Ask Sgt. pepper about it.']);
        expect(chunkStreamed('Ask the sergeant. Pepper knows.', false).complete).toEqual(['Ask the sergeant.', 'Pepper knows.']);
    });

    it('keeps a closing quote or bracket with its sentence', () => {
        expect(chunkStreamed('He said "done." Then left', false)).toEqual({
            complete: ['He said "done."'],
            pending: 'Then left',
        });
        expect(chunkStreamed('It works (mostly).', false).pending).toBeNull();
    });

    it('does not sit on a run that has no punctuation at all', () => {
        const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
        const chunks = chunkStreamed(long, false);
        expect(chunks.complete.length).toBeGreaterThan(0);
        expect(chunks.pending).not.toBeNull();
        expect([...chunks.complete, chunks.pending].join(' ')).toBe(long);
    });

    it('has nothing to say for empty text', () => {
        expect(chunkStreamed('', false)).toEqual({ complete: [], pending: null });
    });
});
