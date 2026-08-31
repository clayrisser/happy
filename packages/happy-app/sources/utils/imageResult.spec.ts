import { describe, expect, it } from 'vitest';

import { defaultImageAspect, imageAspect, imageDisplaySize, toolResultImage } from './imageResult';

describe('toolResultImage', () => {
    it('finds the image in a content-block result', () => {
        const image = toolResultImage([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ]);
        expect(image?.uri).toBe('data:image/png;base64,AAAA');
        expect(image?.mediaType).toBe('image/png');
    });

    it('finds the image in the on-disk Read result, with its natural size', () => {
        const image = toolResultImage({
            type: 'image',
            file: {
                base64: 'BBBB',
                type: 'image/jpeg',
                dimensions: { originalWidth: 1290, originalHeight: 2796 },
            },
        });
        expect(image).toEqual({
            uri: 'data:image/jpeg;base64,BBBB',
            mediaType: 'image/jpeg',
            width: 1290,
            height: 2796,
        });
    });

    it('finds the image when a Read returns its header text alongside it', () => {
        const image = toolResultImage([
            { type: 'text', text: 'screenshot.png' },
            { type: 'image', source: { type: 'url', url: 'https://example.test/a.png', media_type: 'image/png' } },
        ]);
        expect(image?.uri).toBe('https://example.test/a.png');
    });

    it('is null for text, structured, empty and error-shaped results', () => {
        expect(toolResultImage('1  const a = 1;')).toBeNull();
        expect(toolResultImage({ ok: true, count: 2 })).toBeNull();
        expect(toolResultImage('')).toBeNull();
        expect(toolResultImage(null)).toBeNull();
        expect(toolResultImage(undefined)).toBeNull();
        expect(toolResultImage(['a', 'b'])).toBeNull();
    });

    it('is null when a result carries more than one image, which the row cannot show', () => {
        expect(toolResultImage([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BB' } },
        ])).toBeNull();
    });

    it('answers a string result without parsing it, since text is never a picture', () => {
        expect(toolResultImage('{"type":"image","file":{"base64":"AA"}}')).toBeNull();
    });

    it('is null for an image block with no usable source', () => {
        expect(toolResultImage([{ type: 'image', source: { type: 'base64', data: '' } }])).toBeNull();
    });
});

describe('imageAspect', () => {
    it('is width over height when both are real', () => {
        expect(imageAspect(1600, 900)).toBeCloseTo(16 / 9);
    });

    it('falls back when the size is missing, zero, negative or not finite', () => {
        expect(imageAspect(undefined, undefined)).toBe(defaultImageAspect);
        expect(imageAspect(100, 0)).toBe(defaultImageAspect);
        expect(imageAspect(-100, 50)).toBe(defaultImageAspect);
        expect(imageAspect(Number.NaN, 50)).toBe(defaultImageAspect);
        expect(imageAspect(100, Number.POSITIVE_INFINITY)).toBe(defaultImageAspect);
    });
});

describe('imageDisplaySize', () => {
    it('fills the column and takes its height from the aspect ratio', () => {
        expect(imageDisplaySize({ containerWidth: 320, aspect: 2, maxHeight: 360 }))
            .toEqual({ width: 320, height: 160 });
    });

    it('caps a tall screenshot by height and narrows the box to match, so nothing letterboxes', () => {
        const box = imageDisplaySize({ containerWidth: 320, aspect: 1290 / 2796, maxHeight: 360 });
        expect(box).not.toBeNull();
        expect(box!.height).toBe(360);
        expect(box!.width).toBeCloseTo(360 * (1290 / 2796));
        expect(box!.width).toBeLessThan(320);
        // The box is exactly the picture's shape, which is what kills the bars.
        expect(box!.width / box!.height).toBeCloseTo(1290 / 2796);
    });

    it('never blows a small image up past its natural width', () => {
        expect(imageDisplaySize({ containerWidth: 320, aspect: 1, maxHeight: 360, maxWidth: 64 }))
            .toEqual({ width: 64, height: 64 });
    });

    it('still fills the column when the natural width is larger', () => {
        expect(imageDisplaySize({ containerWidth: 320, aspect: 1, maxHeight: 360, maxWidth: 2000 }))
            .toEqual({ width: 320, height: 320 });
    });

    it('is null before the column has been measured, so no empty frame is drawn', () => {
        expect(imageDisplaySize({ containerWidth: 0, aspect: 1, maxHeight: 360 })).toBeNull();
        expect(imageDisplaySize({ containerWidth: -10, aspect: 1, maxHeight: 360 })).toBeNull();
        expect(imageDisplaySize({ containerWidth: Number.NaN, aspect: 1, maxHeight: 360 })).toBeNull();
    });

    it('is null when the height cap is nonsense', () => {
        expect(imageDisplaySize({ containerWidth: 320, aspect: 1, maxHeight: 0 })).toBeNull();
        expect(imageDisplaySize({ containerWidth: 320, aspect: 1, maxHeight: Number.NaN })).toBeNull();
    });

    it('falls back to 4:3 rather than dividing by a broken aspect ratio', () => {
        expect(imageDisplaySize({ containerWidth: 300, aspect: 0, maxHeight: 1000 }))
            .toEqual({ width: 300, height: 300 / defaultImageAspect });
        expect(imageDisplaySize({ containerWidth: 300, aspect: Number.NaN, maxHeight: 1000 }))
            .toEqual({ width: 300, height: 300 / defaultImageAspect });
    });

    it('ignores a natural width that is zero or not finite', () => {
        expect(imageDisplaySize({ containerWidth: 320, aspect: 1, maxHeight: 360, maxWidth: 0 }))
            .toEqual({ width: 320, height: 320 });
        expect(imageDisplaySize({ containerWidth: 320, aspect: 1, maxHeight: 360, maxWidth: Number.NaN }))
            .toEqual({ width: 320, height: 320 });
    });
});
