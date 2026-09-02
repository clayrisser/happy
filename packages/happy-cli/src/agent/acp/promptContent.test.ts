import { describe, expect, it } from 'vitest';

import { buildAcpPromptBlocks, pathToFileUri } from './promptContent';

const staged = [{ path: '/tmp/harness/abc123-shot.png', mimeType: 'image/png' as const, bytes: 42 }];

describe('buildAcpPromptBlocks', () => {
    it('sends one text block when nothing is attached', () => {
        expect(buildAcpPromptBlocks({ text: 'hello' })).toEqual([
            { type: 'text', text: 'hello' },
        ]);
    });

    it('carries the image itself when the agent advertised promptCapabilities.image', () => {
        const blocks = buildAcpPromptBlocks({
            text: 'what is this',
            images: [{ base64: 'QUJD', mimeType: 'image/png', name: 'shot.png' }],
        });

        // Image first, so the words that follow can refer to it.
        expect(blocks).toEqual([
            { type: 'image', mimeType: 'image/png', data: 'QUJD' },
            { type: 'text', text: 'what is this' },
        ]);
    });

    it('sends an image-only turn with no empty text block', () => {
        const blocks = buildAcpPromptBlocks({
            text: '   ',
            images: [{ base64: 'QUJD', mimeType: 'image/jpeg', name: 'shot.jpg' }],
        });

        expect(blocks).toEqual([
            { type: 'image', mimeType: 'image/jpeg', data: 'QUJD' },
        ]);
    });

    it('names the path in the words AND links it when the agent takes no images', () => {
        const blocks = buildAcpPromptBlocks({ text: 'look', staged });

        expect(blocks[0]).toEqual({
            type: 'text',
            text: 'look\n\nAn image was attached from the phone. Read it from this path before answering:\n[Image 1: /tmp/harness/abc123-shot.png]',
        });
        expect(blocks[1]).toEqual({
            type: 'resource_link',
            uri: 'file:///tmp/harness/abc123-shot.png',
            name: 'abc123-shot.png',
            mimeType: 'image/png',
        });
    });

    it('still names the path when the turn carried no words', () => {
        const blocks = buildAcpPromptBlocks({ text: '', staged });

        expect((blocks[0] as { text: string }).text).toContain('/tmp/harness/abc123-shot.png');
        expect(blocks).toHaveLength(2);
    });

    it('never mixes inline bytes with a disk path for the same turn', () => {
        const blocks = buildAcpPromptBlocks({
            text: 'x',
            images: [{ base64: 'QUJD', mimeType: 'image/png', name: 'a.png' }],
            staged,
        });

        expect(blocks.some((b) => b.type === 'resource_link')).toBe(false);
    });
});

describe('pathToFileUri', () => {
    it('escapes each segment of an absolute path', () => {
        expect(pathToFileUri('/tmp/a b/c#1.png')).toBe('file:///tmp/a%20b/c%231.png');
    });
});
