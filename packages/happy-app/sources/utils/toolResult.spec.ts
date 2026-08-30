import { describe, expect, it } from 'vitest';

import { isEmptyToolResult, presentToolResult, toolResultText } from './toolResult';

describe('presentToolResult', () => {
    it('says empty only when there is nothing: null, undefined, blank', () => {
        expect(presentToolResult(undefined)).toEqual({ kind: 'empty' });
        expect(presentToolResult(null)).toEqual({ kind: 'empty' });
        expect(presentToolResult('   ')).toEqual({ kind: 'empty' });
        expect(presentToolResult([])).toEqual({ kind: 'empty' });
        expect(presentToolResult({})).toEqual({ kind: 'empty' });
    });

    it('shows a Read of an image as the image, from the content-block shape', () => {
        // The tool_result content Claude writes for Read on a .jpg.
        const result = [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }];
        expect(presentToolResult(result)).toEqual({
            kind: 'image',
            uri: 'data:image/jpeg;base64,AAAA',
            mediaType: 'image/jpeg',
        });
    });

    it('shows a Read of an image from the on-disk toolUseResult shape, with its size', () => {
        const result = {
            type: 'image',
            file: {
                base64: 'BBBB',
                type: 'image/png',
                originalSize: 117000,
                dimensions: { originalWidth: 1206, originalHeight: 2622, displayWidth: 920, displayHeight: 2000 },
            },
        };
        expect(presentToolResult(result)).toEqual({
            kind: 'image',
            uri: 'data:image/png;base64,BBBB',
            mediaType: 'image/png',
            width: 1206,
            height: 2622,
        });
    });

    it('shows a Read of text as the text, from both shapes', () => {
        expect(presentToolResult('1\timport x\n2\tconst y = 1')).toEqual({ kind: 'text', text: '1\timport x\n2\tconst y = 1' });
        expect(presentToolResult({ type: 'text', file: { filePath: '/a.ts', content: 'const y = 1', numLines: 1 } }))
            .toEqual({ kind: 'text', text: 'const y = 1' });
        expect(presentToolResult([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]))
            .toEqual({ kind: 'text', text: 'one\ntwo' });
    });

    it('opens a JSON result into rows, including the MCP text-block wrapper', () => {
        const hulyShow = '{\n  "identifier": "DROVE-51",\n  "title": "A tool call"\n}';
        expect(presentToolResult(hulyShow)).toEqual({ kind: 'structured', value: { identifier: 'DROVE-51', title: 'A tool call' } });
        expect(presentToolResult([{ type: 'text', text: hulyShow }]))
            .toEqual({ kind: 'structured', value: { identifier: 'DROVE-51', title: 'A tool call' } });
        expect(presentToolResult({ success: true, message: 'queued' }))
            .toEqual({ kind: 'structured', value: { success: true, message: 'queued' } });
    });

    it('keeps text and an image together when a result has both', () => {
        const result = [
            { type: 'text', text: 'Screenshot:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CC' } },
        ];
        expect(presentToolResult(result)).toEqual({
            kind: 'mixed',
            parts: [
                { kind: 'text', text: 'Screenshot:' },
                { kind: 'image', uri: 'data:image/png;base64,CC', mediaType: 'image/png' },
            ],
        });
    });

    it('does not mistake a plain array of strings for content blocks', () => {
        expect(presentToolResult(['a', 'b'])).toEqual({ kind: 'structured', value: ['a', 'b'] });
    });
});

describe('isEmptyToolResult', () => {
    it('is false for an image result block', () => {
        expect(isEmptyToolResult([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }])).toBe(false);
        expect(isEmptyToolResult('')).toBe(true);
    });
});

describe('toolResultText', () => {
    it('passes strings through and elides base64 in objects', () => {
        expect(toolResultText('boom')).toBe('boom');
        const text = toolResultText({ type: 'image', file: { base64: 'x'.repeat(5000), type: 'image/png' } });
        expect(text).toBe('[image/png]');
        const json = toolResultText({ a: 'y'.repeat(5000) });
        expect(json).toContain('(5000 chars)');
        expect(json.length).toBeLessThan(200);
    });
});
