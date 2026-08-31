import { describe, expect, it } from 'vitest';
import { composeDictation, joinDictation } from './dictationDraft';

describe('joinDictation', () => {
    it('puts the words alone into an empty composer', () => {
        expect(joinDictation('', 'run the tests')).toBe('run the tests');
    });

    it('separates the words from existing text with one space', () => {
        expect(joinDictation('fix the build', 'then run the tests')).toBe('fix the build then run the tests');
    });

    it('does not double a space the base already ends with', () => {
        expect(joinDictation('fix the build ', 'now')).toBe('fix the build now');
    });

    it('keeps a newline the base ends with', () => {
        expect(joinDictation('first line\n', 'second line')).toBe('first line\nsecond line');
    });

    it('trims what the recogniser sent', () => {
        expect(joinDictation('a', '  b  ')).toBe('a b');
    });

    it('gives the base back untouched when nothing was heard', () => {
        expect(joinDictation('typed so far ', '')).toBe('typed so far ');
        expect(joinDictation('typed so far ', '   ')).toBe('typed so far ');
    });
});

describe('composeDictation', () => {
    it('shows the latest partial, not the sum of them', () => {
        expect(composeDictation('', ['run', 'run the', 'run the tests'])).toBe('run the tests');
    });

    it('revises in place when a later partial rewrites earlier words', () => {
        expect(composeDictation('', ['right the tests', 'write the tests'])).toBe('write the tests');
    });

    it('keeps the base under every revision', () => {
        expect(composeDictation('please', ['open', 'open the file'])).toBe('please open the file');
        expect(composeDictation('please', ['open the file', 'open the'])).toBe('please open the');
    });

    it('is the base alone before the first partial', () => {
        expect(composeDictation('please', [])).toBe('please');
    });
});
