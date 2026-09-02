import { describe, expect, it } from 'vitest';
import {
    imageViewerContent,
    imageViewerEmptyMessage,
    imageViewerStage,
} from './imageViewer';

describe('imageViewerStage', () => {
    it('fills the window, so the picture is sized in points and not in percent', () => {
        expect(imageViewerStage({ width: 393, height: 852 })).toEqual({ width: 393, height: 852 });
    });

    it('refuses a window with no width, rather than drawing a zero-wide picture', () => {
        // The black screen: the stage resolved to zero and the Image was laid
        // out inside it anyway. A null box draws nothing at all instead.
        expect(imageViewerStage({ width: 0, height: 852 })).toBeNull();
    });

    it('refuses a window with no height', () => {
        expect(imageViewerStage({ width: 393, height: 0 })).toBeNull();
    });

    it('refuses an unmeasured window', () => {
        expect(imageViewerStage({ width: Number.NaN, height: 852 })).toBeNull();
        expect(imageViewerStage({ width: 393, height: Number.POSITIVE_INFINITY })).toBeNull();
    });
});

describe('imageViewerContent', () => {
    it('shows a picture it has a source for', () => {
        expect(imageViewerContent('data:image/png;base64,iVBORw0KGgo=')).toEqual({
            kind: 'image',
            uri: 'data:image/png;base64,iVBORw0KGgo=',
        });
    });

    it('says so when there is no source, instead of opening onto black', () => {
        expect(imageViewerContent(undefined)).toEqual({
            kind: 'empty',
            message: imageViewerEmptyMessage,
        });
        expect(imageViewerContent(null)).toEqual({
            kind: 'empty',
            message: imageViewerEmptyMessage,
        });
    });

    it('treats a blank source as no source', () => {
        expect(imageViewerContent('')).toEqual({ kind: 'empty', message: imageViewerEmptyMessage });
        expect(imageViewerContent('   ')).toEqual({ kind: 'empty', message: imageViewerEmptyMessage });
    });

    it('keeps the message to one fragment', () => {
        expect(imageViewerEmptyMessage).toBe('Not on this phone');
        expect(imageViewerEmptyMessage).not.toMatch(/[.!?]/);
    });
});
