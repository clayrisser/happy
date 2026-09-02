import { describe, expect, it } from 'vitest';
import {
    droverFileEntryAllowedKeys,
    droverFileImageAllowedKeys,
    droverFileImageUri,
    droverFileReadLeaks,
    droverFilesListLeaks,
    droverPaneLeaks,
    redactTextCounting,
} from './files';

// The suite's planted marker, the same one the drover's tests/files.bats
// hides in its fixture tree (DROVE-274's contract). Nothing real is in here.
const planted = 'sk-ant-FIXTURESECRET330';

const listing = () => ({
    root: '/Users/clay/Projects/bitspur/happy',
    path: 'packages',
    entries: [
        { name: 'happy-app', type: 'directory', size: null, modified: 1, refused: false },
        { name: '.env', type: 'file', size: 12, modified: 1, refused: true },
    ],
    readAt: 1_700_000_000_000,
});

describe('a listing carries only what the phone needs to draw a row', () => {
    it('passes the shape the drover builds', () => {
        expect(droverFilesListLeaks(listing())).toEqual([]);
    });

    it('names an extra key on an entry, because that is how a path leaks', () => {
        const bad = listing();
        (bad.entries[0] as Record<string, unknown>).absolutePath = '/Users/clay/x';
        expect(droverFilesListLeaks(bad)).toEqual([
            `listing.entries[0].absolutePath is not one of ${droverFileEntryAllowedKeys.join(', ')}`,
        ]);
    });

    it('refuses a name that is more than one segment', () => {
        // The phone joins names onto the root it holds. A producer handing it
        // `../.ssh` would be handing it a path to resolve, and it must not.
        const bad = listing();
        bad.entries[0].name = '../.ssh';
        expect(droverFilesListLeaks(bad)).toContain('listing.entries[0].name is not a single path segment');
    });

    it('says when the listing is not a listing at all', () => {
        expect(droverFilesListLeaks(null)).toContain('listing is not an object');
        expect(droverFilesListLeaks({ root: '/x', path: '', readAt: 1 })).toContain('listing.entries is not a list');
    });
});

describe('a read and a pane are checked the same way', () => {
    it('passes a read and a pane of the declared shape', () => {
        expect(droverFileReadLeaks({
            root: '/x', path: 'a.ts', content: 'hi', size: 2, truncated: false, binary: false, redacted: 0, readAt: 1,
        })).toEqual([]);
        expect(droverPaneLeaks({ sessionId: 's', pane: '%3', lines: ['a', 'b'], redacted: 0, capturedAt: 1 })).toEqual([]);
    });

    it('refuses a read that grew a field', () => {
        expect(droverFileReadLeaks({
            root: '/x', path: 'a.ts', content: 'hi', size: 2, truncated: false, binary: false, redacted: 0, readAt: 1, absolutePath: '/x/a.ts',
        })).toEqual(['file.absolutePath is not one of root, path, content, size, truncated, binary, image, redacted, readAt']);
    });

    it('refuses a pane whose lines are not text', () => {
        expect(droverPaneLeaks({ sessionId: 's', pane: '%3', lines: [1], redacted: 0, capturedAt: 1 }))
            .toContain('pane.lines is not a list of strings');
    });
});

/** A real 1x1 PNG, so the shape under test is a shape that decodes. */
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const imageRead = (image: unknown) => ({
    root: '/x', path: 'docs/shot.png', content: null, size: 68,
    truncated: false, binary: true, image, redacted: 0, readAt: 1,
});

describe('a picture the daemon read (DROVE-366)', () => {
    it('passes an image of the declared shape', () => {
        expect(droverFileReadLeaks(imageRead({ mediaType: 'image/png', base64: onePixelPng }))).toEqual([]);
    });

    it('still passes a read that carries no image at all', () => {
        expect(droverFileReadLeaks(imageRead(null))).toEqual([]);
        const withoutKey = imageRead(null) as Record<string, unknown>;
        delete withoutKey.image;
        expect(droverFileReadLeaks(withoutKey)).toEqual([]);
    });

    it('refuses an extra key INSIDE the image, which the top-level pass cannot see', () => {
        expect(droverFileReadLeaks(imageRead({
            mediaType: 'image/png', base64: onePixelPng, absolutePath: '/Users/clay/docs/shot.png',
        }))).toEqual([`file.image.absolutePath is not one of ${droverFileImageAllowedKeys.join(', ')}`]);
    });

    it('refuses a media type the phone was never told about', () => {
        expect(droverFileReadLeaks(imageRead({ mediaType: 'image/svg+xml', base64: onePixelPng })))
            .toContain('file.image.mediaType is not one of image/png, image/jpeg, image/gif, image/webp');
        expect(droverFileReadLeaks(imageRead({ mediaType: 'text/plain', base64: onePixelPng })))
            .toContain('file.image.mediaType is not one of image/png, image/jpeg, image/gif, image/webp');
    });

    it('refuses bytes that are not base64', () => {
        expect(droverFileReadLeaks(imageRead({ mediaType: 'image/png', base64: '' })))
            .toContain('file.image.base64 is not bytes');
        // A path where the bytes should be is the shape worth naming.
        expect(droverFileReadLeaks(imageRead({ mediaType: 'image/png', base64: '/Users/clay/shot.png' })))
            .toContain('file.image.base64 is not base64');
        expect(droverFileReadLeaks(imageRead({ mediaType: 'image/png', base64: `data:image/png;base64,${onePixelPng}` })))
            .toContain('file.image.base64 is not base64');
    });
});

describe('droverFileImageUri', () => {
    it('builds a data uri an Image can draw', () => {
        expect(droverFileImageUri(imageRead({ mediaType: 'image/png', base64: onePixelPng }) as never))
            .toBe(`data:image/png;base64,${onePixelPng}`);
    });

    it('is null for every way there is nothing to draw', () => {
        // Not an image, an image over the daemon's cap, and no read at all.
        expect(droverFileImageUri({
            root: '/x', path: 'a.ts', content: 'hi', size: 2, truncated: false, binary: false, redacted: 0, readAt: 1,
        })).toBeNull();
        expect(droverFileImageUri(imageRead(null) as never)).toBeNull();
        expect(droverFileImageUri(null)).toBeNull();
        expect(droverFileImageUri(undefined)).toBeNull();
    });

    it('will not build a uri for a media type outside the set', () => {
        expect(droverFileImageUri(imageRead({ mediaType: 'image/svg+xml', base64: onePixelPng }) as never)).toBeNull();
    });
});

describe('the net under the drover', () => {
    it('changes nothing on clean text and says so', () => {
        expect(redactTextCounting('const x = 1;\n')).toEqual({ text: 'const x = 1;\n', count: 0 });
    });

    it('catches a planted key and counts it', () => {
        const out = redactTextCounting(`export const key = "${planted}";\n`);
        expect(out.text).not.toContain('FIXTURESECRET');
        expect(out.text).toContain('[redacted]');
        expect(out.count).toBe(1);
    });

    it('counts only what it added, not markers the drover already put there', () => {
        const out = redactTextCounting(`a = "[redacted]"\nb = "${planted}"\n`);
        expect(out.count).toBe(1);
        expect(out.text.split('[redacted]').length - 1).toBe(2);
    });
});
