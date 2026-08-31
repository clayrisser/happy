/**
 * ComposerSheet's body height (DROVE-158).
 *
 * The bug these pin down: Add context is a heading and three tiles, roughly
 * 130pt of content, and it came back on the phone with the tile labels sliced
 * through, dead space under them, and a scroll bar. A three tile sheet has no
 * business scrolling, so the two cases here are a short sheet fitting exactly
 * and a long one scrolling at the cap.
 */
import { describe, expect, it } from 'vitest';
import {
    composerSheetBody,
    composerSheetCap,
    composerSheetMaxHeight,
} from './composerSheetLayout';

/** A 6.7" iPhone. */
const windowHeight = 852;

/** Heading, 10pt of gap and an 88pt tile row inside the body's padding. */
const addContextHeight = 130;

describe('composerSheetCap', () => {
    it('is the default cap on a phone, because 70% of the window is more', () => {
        expect(composerSheetCap({ windowHeight })).toBe(composerSheetMaxHeight);
    });

    it('shrinks to 70% of a short window rather than pushing the sheet off the top', () => {
        expect(composerSheetCap({ windowHeight: 400 })).toBe(280);
    });

    it('honours a caller that asked for more, still under the window share', () => {
        expect(composerSheetCap({ maxHeight: 460, windowHeight })).toBe(460);
        expect(composerSheetCap({ maxHeight: 460, windowHeight: 500 })).toBe(350);
    });

    it('honours a caller that asked for less', () => {
        expect(composerSheetCap({ maxHeight: 180, windowHeight })).toBe(180);
    });
});

describe('composerSheetBody', () => {
    it('gives a short sheet exactly its content and no scroll', () => {
        const body = composerSheetBody({ contentHeight: addContextHeight, windowHeight });
        expect(body).toEqual({ cap: 320, height: addContextHeight, scrolls: false });
    });

    it('scrolls a long sheet at the cap, and the cap holds', () => {
        const body = composerSheetBody({ contentHeight: 900, windowHeight });
        expect(body).toEqual({ cap: 320, height: 320, scrolls: true });
    });

    it('scrolls a long sheet at the window share when the window is the smaller limit', () => {
        const body = composerSheetBody({ contentHeight: 900, maxHeight: 460, windowHeight: 500 });
        expect(body).toEqual({ cap: 350, height: 350, scrolls: true });
    });

    it('fits content that lands exactly on the cap', () => {
        expect(composerSheetBody({ contentHeight: 320, windowHeight })).toEqual({
            cap: 320,
            height: 320,
            scrolls: false,
        });
    });

    it('does not turn a fitted sheet into a scrolling one over a subpixel', () => {
        // Layout comes back in device pixels over the scale, so a sheet that
        // is exactly the cap reports 320.33.
        expect(composerSheetBody({ contentHeight: 320.33, windowHeight }).scrolls).toBe(false);
        expect(composerSheetBody({ contentHeight: 321, windowHeight }).scrolls).toBe(true);
    });

    it('leaves the height unset for the frame before the children have measured', () => {
        // The sheet is parked offscreen for that frame; guessing a height here
        // is what let the old shell settle short and clip its own content.
        expect(composerSheetBody({ contentHeight: null, windowHeight })).toEqual({
            cap: 320,
            height: undefined,
            scrolls: false,
        });
        expect(composerSheetBody({ contentHeight: 0, windowHeight }).height).toBeUndefined();
    });

    it('grows with the content when a list gets longer, up to the cap', () => {
        const heights = [80, 200, 319, 400].map((contentHeight) => composerSheetBody({
            contentHeight,
            windowHeight,
        }));
        expect(heights.map((body) => body.height)).toEqual([80, 200, 319, 320]);
        expect(heights.map((body) => body.scrolls)).toEqual([false, false, false, true]);
    });
});
