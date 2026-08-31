import { describe, expect, it } from 'vitest';
import { MOBILE_COMPOSER_METRICS, resolveMobileComposerHeight } from './agentInputLayout';
import {
    COMPOSER_STRIP_HEIGHT,
    COMPOSER_STRIP_MIN_HEIGHT,
    COMPOSER_STRIP_PADDING_TOP,
    RECORDING_BANNER_FRAME,
    RECORDING_BANNER_HEIGHT,
    RECORDING_BANNER_INSET_TOP,
    resolveComposerStripHeight,
    resolveComposerStripOccupant,
} from './composerStripLayout';
import {
    DOCK_CONTENT_BOTTOM_PADDING,
    HOME_INDICATOR_KEEP_OUT,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveStatusRowBottomGap,
    resolveStatusRowTapFloor,
} from './agentDockLayout';

/** One line of typing, no attachments: the card Clay is looking at. */
const cardHeight = resolveMobileComposerHeight(MOBILE_COMPOSER_METRICS.inputLineHeight);

function dockHeight(recordingActive: boolean, statusRowRendered = true): number {
    return cardHeight + resolveComposerStripHeight(recordingActive, statusRowRendered);
}

describe('the layout does not move when a recording starts', () => {
    it('keeps the strip the same height whether or not the mic is open', () => {
        expect(resolveComposerStripHeight(true, true)).toBe(resolveComposerStripHeight(false, true));
    });

    it('keeps the whole dock the same height, so the transcript stays put', () => {
        expect(dockHeight(true)).toBe(dockHeight(false));
        expect(resolveDockInset({
            dockHeight: dockHeight(true),
            safeAreaBottom: 34,
            floatingDock: true,
        })).toBe(resolveDockInset({
            dockHeight: dockHeight(false),
            safeAreaBottom: 34,
            floatingDock: true,
        }));
    });

    it('never lets the banner into the card that the input and buttons size', () => {
        // The card is input plus chrome and nothing else. If the banner is
        // ever put back above the text field, this is the number that grows.
        expect(cardHeight).toBe(
            MOBILE_COMPOSER_METRICS.shellPaddingTop
            + MOBILE_COMPOSER_METRICS.inputMinHeight
            + MOBILE_COMPOSER_METRICS.actionRowHeight
            + MOBILE_COMPOSER_METRICS.shellPaddingBottom,
        );
    });

    it('opens the strip only when a silent session has a recording to show', () => {
        expect(resolveComposerStripHeight(false, false)).toBe(0);
        expect(resolveComposerStripHeight(true, false)).toBe(COMPOSER_STRIP_HEIGHT);
    });
});

describe('where the recording banner lives', () => {
    it('puts it in the strip, not in the card', () => {
        expect(resolveComposerStripOccupant(true)).toBe('recording');
        expect(resolveComposerStripOccupant(false)).toBe('status');
    });

    it('pins it absolutely, which is what stops it adding height', () => {
        expect(RECORDING_BANNER_FRAME.position).toBe('absolute');
        expect(RECORDING_BANNER_FRAME.bottom).toBe(0);
        expect(RECORDING_BANNER_FRAME.top).toBe(RECORDING_BANNER_INSET_TOP);
    });

    it('makes the bar exactly as wide as the composer card above it', () => {
        expect(RECORDING_BANNER_FRAME.left).toBe(MOBILE_COMPOSER_METRICS.shellInset);
        expect(RECORDING_BANNER_FRAME.right).toBe(MOBILE_COMPOSER_METRICS.shellInset);
    });

    it('leaves the bar tall enough to hold the dot, clock, level and glyph', () => {
        expect(RECORDING_BANNER_HEIGHT).toBe(COMPOSER_STRIP_HEIGHT - RECORDING_BANNER_INSET_TOP);
        expect(RECORDING_BANNER_HEIGHT).toBeGreaterThanOrEqual(18);
    });

    it('keeps the strip the 24pt the dock arithmetic was measured against', () => {
        expect(COMPOSER_STRIP_HEIGHT).toBe(COMPOSER_STRIP_PADDING_TOP + COMPOSER_STRIP_MIN_HEIGHT);
        expect(COMPOSER_STRIP_HEIGHT).toBe(24);
    });
});

/**
 * Where the strip actually LANDS, measured from the screen edge up (DROVE-194).
 *
 * Clay photographed the composer with 34pt of black under it and asked why his
 * accounts and limits were gone. They were not off-screen and not clipped.
 * The strip was exactly here, drawing nothing. But "is it off the bottom" is
 * the first question anyone asks about a missing bottom row, and until this
 * spec existed the only way to answer it was to count pixels in a screenshot.
 *
 * The dock is an absolutely positioned overlay at `bottom: dockBottomOffset`
 * that grows UPWARD, so the strip cannot be pushed off the edge by anything
 * above it. What this pins is the other direction: that the whole strip is
 * inside the box the chat list reserves, and that its text stops above the
 * home indicator on a phone that has one.
 */
describe('the strip sits inside the dock, above the safe area', () => {
    /** With an indicator, and with a home button, which is the case the cap must not break. */
    for (const safeAreaBottom of [34, 0]) {
        const box = dockHeight(false) + DOCK_CONTENT_BOTTOM_PADDING;
        const inset = resolveDockInset({ dockHeight: box, safeAreaBottom, floatingDock: true });
        /** Screen edge to the bottom of the status row's text. */
        const stripBottom = resolveStatusRowBottomGap(safeAreaBottom);
        /** Screen edge to the top of the strip's box, which is the card's bottom edge. */
        const stripTop = stripBottom + COMPOSER_STRIP_HEIGHT;

        it(`keeps the whole strip on screen at safeArea.bottom ${safeAreaBottom}`, () => {
            expect(stripBottom).toBeGreaterThan(0);
            expect(stripTop).toBeGreaterThan(stripBottom);
            // Inside the band the inverted list holds clear, so nothing the
            // chat draws can land on top of the row.
            expect(inset).toBeGreaterThanOrEqual(stripTop);
            // And inside the dock's own measured box: the strip is a child of
            // it, not something hanging below its frame.
            expect(box - resolveDockBottomOffset(safeAreaBottom, true))
                .toBeGreaterThanOrEqual(COMPOSER_STRIP_HEIGHT);
        });

        it(`keeps the row's taps off the home indicator at safeArea.bottom ${safeAreaBottom}`, () => {
            const floor = resolveStatusRowTapFloor(safeAreaBottom);
            expect(floor).toBeGreaterThanOrEqual(safeAreaBottom > 0 ? HOME_INDICATOR_KEEP_OUT : 0);
            expect(floor).toBeLessThan(stripBottom);
        });
    }
});
