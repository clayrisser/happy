import { describe, expect, it } from 'vitest';

import {
    humanizeKey,
    isInlineValue,
    isPathLike,
    longTextChars,
    rawJson,
    structuredRows,
    structuredRowsOmitting,
    structuredValue,
} from './structuredFields';

describe('structuredRows', () => {
    // The exact SendMessage input Clay screenshotted for DROVE-51: six keys,
    // two of them repeats.
    const sendMessage = {
        to: 'a1214f40893dc2f14',
        summary: 'Do not publish; I merge and publish from BASED-113',
        message: 'Do NOT publish from your worktree. Every agent\'s OTA is built from its own lane, so whichever publishes last wipes the others\' fixes off the channel. Finish your ticket comment and handoff, then stop.',
        type: 'message',
        recipient: 'a1214f40893dc2f14',
        content: 'Do NOT publish from your worktree. Every agent\'s OTA is built from its own lane, so whichever publishes last wipes the others\' fixes off the channel. Finish your ticket comment and handoff, then stop.',
    };

    it('collapses two keys that carry the same value into one row', () => {
        const rows = structuredRows(sendMessage);
        expect(rows.map((row) => row.key)).toEqual(['to', 'summary', 'message', 'type']);
        expect(rows[0].aliases).toEqual(['recipient']);
        expect(rows[2].aliases).toEqual(['content']);
    });

    it('marks a long string as a block to fold and a short one as inline', () => {
        const rows = structuredRows(sendMessage);
        expect(rows[1].value).toEqual({ kind: 'text', text: sendMessage.summary, long: false });
        expect(rows[2].value).toMatchObject({ kind: 'text', long: true });
    });

    it('does not collapse two booleans or two numbers that happen to match', () => {
        const rows = structuredRows({ '-n': true, '-i': true, '-A': 3, '-B': 3 });
        expect(rows).toHaveLength(4);
        expect(rows[0].value).toEqual({ kind: 'boolean', value: true });
        expect(rows[2].value).toEqual({ kind: 'number', text: '3' });
    });

    it('renders an array as list items', () => {
        const rows = structuredRows({ allowed_domains: ['a.com', 'b.com'] });
        expect(rows[0].label).toBe('allowed domains');
        expect(rows[0].value).toEqual({
            kind: 'list',
            items: [
                { kind: 'text', text: 'a.com', long: false },
                { kind: 'text', text: 'b.com', long: false },
            ],
        });
    });

    it('folds a nested object one level and flattens anything deeper to compact text', () => {
        const rows = structuredRows({
            mr: { iid: 227, state: 'opened', author: { username: 'clayrisser' } },
        });
        const value = rows[0].value;
        expect(value.kind).toBe('object');
        if (value.kind !== 'object') return;
        expect(value.rows.map((row) => row.key)).toEqual(['iid', 'state', 'author']);
        expect(value.rows[0].value).toEqual({ kind: 'number', text: '227' });
        // Two levels down is where the card stops laying things out; the third
        // level reads as JSON text rather than growing the card sideways.
        const author = value.rows[2].value;
        expect(author.kind).toBe('object');
        if (author.kind !== 'object') return;
        expect(author.rows[0].value).toEqual({ kind: 'text', text: 'clayrisser', long: false });
    });

    it('keeps a long string a text block, at the top level and one level down, never JSON', () => {
        const long = 'x'.repeat(300) + '\nsecond line';
        const rows = structuredRows({ prompt: long, nested: { message: long } });
        expect(rows[0].value).toEqual({ kind: 'text', text: long, long: true });
        const nested = rows[1].value;
        expect(nested.kind).toBe('object');
        if (nested.kind !== 'object') return;
        expect(nested.rows[0].value).toEqual({ kind: 'text', text: long, long: true });
    });

    it('recognises file paths', () => {
        const rows = structuredRows({ file_path: '/Users/clayrisser/.claude-accounts/jamrizzi/uploads/x/IMG_0273.jpg' });
        expect(rows[0].label).toBe('file path');
        expect(rows[0].value.kind).toBe('path');
    });

    it('opens a JSON string into rows, as a Workflow args field is', () => {
        const rows = structuredRows({ args: '{"date":"2026-08-28","findings":[{"key":"phone-inert-card"}]}' });
        const value = rows[0].value;
        expect(value.kind).toBe('object');
        if (value.kind !== 'object') return;
        expect(value.rows[0]).toMatchObject({ key: 'date', value: { kind: 'text', text: '2026-08-28' } });
        expect(value.rows[1].value.kind).toBe('list');
    });

    it('treats null, empty strings, empty arrays and empty objects as empty', () => {
        const rows = structuredRows({ a: null, b: '', c: [], d: {} });
        expect(rows.every((row) => row.value.kind === 'empty')).toBe(true);
    });

    it('still yields a row for a non-object input rather than dropping it', () => {
        expect(structuredRows('just text')).toEqual([
            { key: '', label: '', aliases: [], value: { kind: 'text', text: 'just text', long: false } },
        ]);
        expect(structuredRows(undefined)).toEqual([]);
    });
});

describe('humanizeKey', () => {
    it('turns snake_case and camelCase into lowercase words', () => {
        expect(humanizeKey('file_path')).toBe('file path');
        expect(humanizeKey('resumeFromRunId')).toBe('resume from run id');
        expect(humanizeKey('subagent_type')).toBe('subagent type');
        expect(humanizeKey('to')).toBe('to');
    });
});

describe('isPathLike', () => {
    it('accepts absolute, home and relative paths and rejects prose', () => {
        expect(isPathLike('/Users/clayrisser/x.ts')).toBe(true);
        expect(isPathLike('~/Projects/bitspur/happy')).toBe(true);
        expect(isPathLike('./scripts/run.sh')).toBe(true);
        expect(isPathLike('C:\\Users\\x')).toBe(true);
        expect(isPathLike('/ not a path')).toBe(false);
        expect(isPathLike('a1214f40893dc2f14')).toBe(false);
        expect(isPathLike('/')).toBe(false);
    });
});

describe('structuredValue', () => {
    it('marks multi-line text as long even when short', () => {
        expect(structuredValue('a\nb')).toEqual({ kind: 'text', text: 'a\nb', long: true });
    });
});

describe('rawJson', () => {
    it('pretty-prints objects and passes strings through', () => {
        expect(rawJson({ a: 1 })).toBe('{\n  "a": 1\n}');
        expect(rawJson('x')).toBe('x');
    });
});

describe('isInlineValue', () => {
    // What the card asks of every value: does this sit next to its label, or
    // does it need a block underneath? Nested objects, arrays and long strings
    // are the three that need the block, and they are what a generic card gets
    // wrong when it just prints JSON.
    it('keeps short scalars on the label line', () => {
        expect(isInlineValue({ kind: 'text', text: 'message', long: false })).toBe(true);
        expect(isInlineValue({ kind: 'path', path: '/tmp/x' })).toBe(true);
        expect(isInlineValue({ kind: 'number', text: '3' })).toBe(true);
        expect(isInlineValue({ kind: 'boolean', value: false })).toBe(true);
        expect(isInlineValue({ kind: 'empty' })).toBe(true);
    });

    it('gives a long string, a list and a nested object a block of their own', () => {
        const long = structuredRows({ message: 'x'.repeat(longTextChars + 1) })[0].value;
        const list = structuredRows({ todos: ['a', 'b'] })[0].value;
        const nested = structuredRows({ mr: { iid: 227 } })[0].value;
        expect(long).toMatchObject({ kind: 'text', long: true });
        expect(isInlineValue(long)).toBe(false);
        expect(list.kind).toBe('list');
        expect(isInlineValue(list)).toBe(false);
        expect(nested.kind).toBe('object');
        expect(isInlineValue(nested)).toBe(false);
    });
});

describe('structuredRowsOmitting', () => {
    // A dedicated card writes some fields in its own hand; the rest still have
    // to show up, or the card would be dropping input.
    it('drops the keys the card already wrote and keeps everything else', () => {
        const rows = structuredRowsOmitting(
            { to: 'a1', summary: 'S', message: 'M', type: 'message', recipient: 'a1', content: 'M' },
            ['to', 'recipient', 'message', 'content', 'summary'],
        );
        expect(rows.map((row) => row.key)).toEqual(['type']);
    });

    it('still collapses duplicates among the keys it keeps', () => {
        const rows = structuredRowsOmitting({ a: 'same', b: 'same', c: 'other' }, []);
        expect(rows.map((row) => row.key)).toEqual(['a', 'c']);
        expect(rows[0].aliases).toEqual(['b']);
    });

    it('passes a non-object input straight through', () => {
        expect(structuredRowsOmitting('bare', ['x'])).toEqual([
            { key: '', label: '', aliases: [], value: { kind: 'text', text: 'bare', long: false } },
        ]);
    });
});
