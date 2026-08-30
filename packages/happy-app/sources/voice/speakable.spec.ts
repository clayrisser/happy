import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { speakableChunks, splitIntoSentences, stripToSpeakableProse } from './speakable';

function agentText(text: string, isThinking = false): Message {
    return {
        kind: 'agent-text',
        id: 'm1',
        localId: null,
        createdAt: 1,
        text,
        ...(isThinking ? { isThinking: true } : {}),
    } as Message;
}

describe('stripToSpeakableProse', () => {
    it('drops fenced code and keeps the prose either side', () => {
        const out = stripToSpeakableProse([
            'Here is the fix.',
            '```ts',
            'const x = 1;',
            'console.log(x);',
            '```',
            'That should do it.',
        ].join('\n'));
        expect(out).toBe('Here is the fix.\nThat should do it.');
    });

    it('drops tilde fences too', () => {
        const out = stripToSpeakableProse('Before.\n~~~\nraw\n~~~\nAfter.');
        expect(out).toBe('Before.\nAfter.');
    });

    it('drops an unterminated fence to the end rather than reading the code', () => {
        const out = stripToSpeakableProse('Look:\n```\nls -la\nrm -rf /');
        expect(out).toBe('Look:');
    });

    it('drops indented code but keeps nested bullets', () => {
        const out = stripToSpeakableProse([
            'Steps:',
            '    someCode();',
            '    - a nested point',
        ].join('\n'));
        expect(out).toBe('Steps:\na nested point');
    });

    it('drops tables whole', () => {
        const out = stripToSpeakableProse([
            'Results:',
            '| file | lines |',
            '| --- | --- |',
            '| a.ts | 10 |',
            'Done.',
        ].join('\n'));
        expect(out).toBe('Results:\nDone.');
    });

    it('keeps short word-shaped inline code and drops bare URLs', () => {
        // Measured on 4000 real assistant blocks: dropping every inline span
        // left "11 in, 2 in" where the filenames used to be, which is worse to
        // listen to than the filenames.
        const out = stripToSpeakableProse('Run `pnpm test` and see https://example.com/x for more');
        expect(out).toBe('Run pnpm test and see for more');
    });

    it('still drops inline code that is a command or a blob', () => {
        expect(stripToSpeakableProse('Try `git reset --hard && pnpm i` first'))
            .toBe('Try first');
        expect(stripToSpeakableProse('The rule `.pflash.on{opacity:1}` went'))
            .toBe('The rule went');
    });

    it('keeps the space in front of a dotfile it decided to say', () => {
        expect(stripToSpeakableProse('Check the `.env` file')).toBe('Check the .env file');
    });

    it('flattens a stray table pipe left mid-sentence', () => {
        expect(stripToSpeakableProse('Either keep it | or delete the div'))
            .toBe('Either keep it, or delete the div');
    });

    it('keeps a link label and loses the href', () => {
        expect(stripToSpeakableProse('See [the design](https://example.com/d) first'))
            .toBe('See the design first');
    });

    it('strips heading, list, quote and emphasis markers', () => {
        const out = stripToSpeakableProse([
            '## Summary',
            '- **first** point',
            '2. second point',
            '> quoted line',
        ].join('\n'));
        expect(out).toBe('Summary\nfirst point\nsecond point\nquoted line');
    });

    it('drops horizontal rules and blank lines', () => {
        expect(stripToSpeakableProse('One.\n\n---\n\nTwo.')).toBe('One.\nTwo.');
    });
});

describe('splitIntoSentences', () => {
    it('splits on sentence terminators', () => {
        expect(splitIntoSentences('One thing. Two things! Three?'))
            .toEqual(['One thing.', 'Two things!', 'Three?']);
    });

    it('treats a newline as a hard boundary', () => {
        expect(splitIntoSentences('first point\nsecond point'))
            .toEqual(['first point', 'second point']);
    });

    it('does not split inside a version number', () => {
        expect(splitIntoSentences('Upgraded to 1.2.3 today.'))
            .toEqual(['Upgraded to 1.2.3 today.']);
    });

    it('does not split inside a filename', () => {
        expect(splitIntoSentences('I edited sync.ts and then storage.ts here.'))
            .toEqual(['I edited sync.ts and then storage.ts here.']);
    });

    it('does not split on e.g. or i.e.', () => {
        expect(splitIntoSentences('Some tools, e.g. grep, are noisy.'))
            .toEqual(['Some tools, e.g. grep, are noisy.']);
        expect(splitIntoSentences('It is scoped, i.e. one session only.'))
            .toEqual(['It is scoped, i.e. one session only.']);
    });

    it('does not split on etc. or vs. mid sentence', () => {
        expect(splitIntoSentences('Logs, diffs, etc. are skipped.'))
            .toEqual(['Logs, diffs, etc. are skipped.']);
    });

    it('does not split inside an ellipsis', () => {
        expect(splitIntoSentences('Hold on... it is still running.'))
            .toEqual(['Hold on... it is still running.']);
    });

    it('does not split on a lone initial', () => {
        expect(splitIntoSentences('Reviewed by J. Smith this morning.'))
            .toEqual(['Reviewed by J. Smith this morning.']);
    });

    it('keeps a closing quote with its sentence', () => {
        expect(splitIntoSentences('He said "done." Then he left.'))
            .toEqual(['He said "done."', 'Then he left.']);
    });

    it('force-cuts a run with no punctuation so speech starts', () => {
        const long = 'word '.repeat(120).trim();
        const parts = splitIntoSentences(long);
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) {
            expect(part.length).toBeLessThanOrEqual(220);
        }
        expect(parts.join(' ')).toBe(long);
    });

    it('emits nothing for empty prose', () => {
        expect(splitIntoSentences('')).toEqual([]);
        expect(splitIntoSentences('   \n  ')).toEqual([]);
    });
});

describe('speakableChunks', () => {
    it('speaks assistant prose', () => {
        expect(speakableChunks(agentText('All set. Tests pass.')))
            .toEqual(['All set.', 'Tests pass.']);
    });

    it('says nothing for thinking', () => {
        expect(speakableChunks(agentText('*weighing the options*', true))).toEqual([]);
    });

    it('says nothing for a user message', () => {
        const user: Message = {
            kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hello',
        } as Message;
        expect(speakableChunks(user)).toEqual([]);
    });

    it('says nothing for a tool call', () => {
        const tool: Message = {
            kind: 'tool-call',
            id: 't1',
            localId: null,
            createdAt: 1,
            children: [],
            tool: {
                name: 'Edit', state: 'completed', input: { file: 'a.ts' },
                createdAt: 1, startedAt: 1, completedAt: 2, description: 'Edit a.ts',
            },
        } as Message;
        expect(speakableChunks(tool)).toEqual([]);
    });

    it('says nothing for a message that is only a code block', () => {
        expect(speakableChunks(agentText('```sh\nrm -rf node_modules\n```'))).toEqual([]);
    });

    it('speaks the prose around a diff without reading the diff', () => {
        const chunks = speakableChunks(agentText([
            'I removed the paywall call.',
            '',
            '```diff',
            '-  presentPaywall("voice_must_pay");',
            '+  // gone (DROVE-30)',
            '```',
            '',
            'Nothing else changed.',
        ].join('\n')));
        expect(chunks).toEqual(['I removed the paywall call.', 'Nothing else changed.']);
    });
});
