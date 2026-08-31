/**
 * ComposerSheet's body height (DROVE-158, then DROVE-201).
 *
 * DROVE-158's bug: Add context is a heading and three tiles, roughly 130pt of
 * content, and it came back on the phone with the tile labels sliced through,
 * dead space under them, and a scroll bar. A three tile sheet has no business
 * scrolling, and the short sheet case here still pins that exactly.
 *
 * DROVE-201's bug is the other end. The cap was 320, or 400 for the pickers,
 * or 70% of the window, so a sheet with 500pt of content stopped half way up
 * and scrolled the rest. Clay, twice: "it should only become scrollable when
 * the sheet has filled up the whole screen." So the three cases that matter
 * are content under the old cap, content between the old cap and the screen,
 * and content past the screen.
 */
import { describe, expect, it } from 'vitest';
import {
    composerSheetBody,
    composerSheetCap,
    composerSheetFooterHeight,
    composerSheetGrabberHeight,
    composerSheetLift,
} from './composerSheetLayout';

/** A 6.7" iPhone, with its notch and its home indicator. */
const phone = { windowHeight: 852, safeAreaTop: 59, safeAreaBottom: 34 };

/** What that phone leaves the body: 852 less 59, the grabber and the footer. */
const phoneCap = 733;

/** Heading, 10pt of gap and an 88pt tile row inside the body's padding. */
const addContextHeight = 130;

/** The old ceiling, which is now just a number in a comment. */
const oldCap = 320;

describe('composerSheetCap', () => {
    it('is the screen less the status bar, the grabber and the home indicator', () => {
        expect(composerSheetCap(phone)).toBe(phoneCap);
        expect(phoneCap).toBe(
            852 - 59 - composerSheetGrabberHeight - composerSheetFooterHeight(34),
        );
    });

    it('is far more than the cap it replaces, which is the whole point', () => {
        expect(composerSheetCap(phone)).toBeGreaterThan(oldCap * 2);
    });

    it('gives a device with no safe areas the room they were taking', () => {
        const flat = composerSheetCap({ ...phone, safeAreaTop: 0, safeAreaBottom: 0 });
        expect(flat - composerSheetCap(phone)).toBe(59 + 34);
    });

    it('leaves the status bar alone: the sheet as drawn ends under it', () => {
        const sheet = composerSheetGrabberHeight
            + composerSheetCap(phone)
            + composerSheetFooterHeight(phone.safeAreaBottom);
        expect(sheet).toBe(phone.windowHeight - phone.safeAreaTop);
    });

    it('shrinks with the window rather than running off the top', () => {
        expect(composerSheetCap({ ...phone, windowHeight: 480 })).toBe(361);
    });

    it('never collapses to a sliver on a window too small to be real', () => {
        expect(composerSheetCap({ ...phone, windowHeight: 100 })).toBe(120);
    });
});

describe('composerSheetBody', () => {
    it('gives a short sheet exactly its content and no scroll (DROVE-158)', () => {
        expect(composerSheetBody({ ...phone, contentHeight: addContextHeight })).toEqual({
            cap: phoneCap,
            height: addContextHeight,
            scrolls: false,
        });
    });

    it('fits content between the old cap and the screen, which used to scroll', () => {
        const content = 520;
        expect(content).toBeGreaterThan(oldCap);
        expect(content).toBeLessThan(phoneCap);
        expect(composerSheetBody({ ...phone, contentHeight: content })).toEqual({
            cap: phoneCap,
            height: content,
            scrolls: false,
        });
    });

    it('scrolls only once the content is past the whole screen', () => {
        expect(composerSheetBody({ ...phone, contentHeight: 1200 })).toEqual({
            cap: phoneCap,
            height: phoneCap,
            scrolls: true,
        });
    });

    it('fits content that lands exactly on the screen', () => {
        expect(composerSheetBody({ ...phone, contentHeight: phoneCap })).toEqual({
            cap: phoneCap,
            height: phoneCap,
            scrolls: false,
        });
    });

    it('does not turn a fitted sheet into a scrolling one over a subpixel', () => {
        // Layout comes back in device pixels over the scale, so a sheet that
        // is exactly the cap reports 733.33.
        expect(composerSheetBody({ ...phone, contentHeight: 733.33 }).scrolls).toBe(false);
        expect(composerSheetBody({ ...phone, contentHeight: 734 }).scrolls).toBe(true);
    });

    it('leaves the height unset for the frame before the children have measured', () => {
        // The sheet is parked offscreen for that frame; guessing a height here
        // is what let the old shell settle short and clip its own content.
        expect(composerSheetBody({ ...phone, contentHeight: null })).toEqual({
            cap: phoneCap,
            height: undefined,
            scrolls: false,
        });
        expect(composerSheetBody({ ...phone, contentHeight: 0 }).height).toBeUndefined();
    });

    it('grows with the content all the way to the screen, then stops', () => {
        const heights = [80, 200, 400, 732, 900].map((contentHeight) => composerSheetBody({
            ...phone,
            contentHeight,
        }));
        expect(heights.map((body) => body.height)).toEqual([80, 200, 400, 732, phoneCap]);
        expect(heights.map((body) => body.scrolls)).toEqual([false, false, false, false, true]);
    });
});

describe('composerSheetLift', () => {
    it('rides the keyboard while there is room above the sheet', () => {
        expect(composerSheetLift({
            keyboardHeight: -300,
            windowHeight: 852,
            safeAreaTop: 59,
            sheetHeight: 300,
        })).toBe(-300);
    });

    it('stops lifting a full height sheet, so the grabber stays on screen', () => {
        expect(composerSheetLift({
            keyboardHeight: -300,
            windowHeight: 852,
            safeAreaTop: 59,
            sheetHeight: 793,
        })).toBeCloseTo(0);
    });

    it('lifts a tall sheet by whatever slack is left and no further', () => {
        expect(composerSheetLift({
            keyboardHeight: -300,
            windowHeight: 852,
            safeAreaTop: 59,
            sheetHeight: 700,
        })).toBe(-93);
    });

    it('is a no-op with the keyboard down', () => {
        expect(composerSheetLift({
            keyboardHeight: 0,
            windowHeight: 852,
            safeAreaTop: 59,
            sheetHeight: 300,
        })).toBe(0);
    });
});
