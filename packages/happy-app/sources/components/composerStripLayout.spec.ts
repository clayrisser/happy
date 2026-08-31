import { describe, expect, it } from 'vitest';
import {
    MOBILE_COMPOSER_BASE_HEIGHT,
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerControlRowGeometry,
    resolveMobileComposerHeight,
    resolveMobileComposerLineGeometry,
} from './agentInputLayout';
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

/**
 * One line of typing, no attachments: the composer Clay is looking at. Since
 * DROVE-196 that is the bubble, the control row under it and the two gaps, not
 * one card holding all of it.
 */
const composerBlockHeight = resolveMobileComposerHeight(MOBILE_COMPOSER_METRICS.inputLineHeight);

function dockHeight(recordingActive: boolean, statusRowRendered = true): number {
    return composerBlockHeight + resolveComposerStripHeight(recordingActive, statusRowRendered);
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

    it('never lets the banner into the composer that the input and buttons size', () => {
        // The block is the field plus its furniture and nothing else. If the
        // banner is ever put back above the text field, this is the number
        // that grows. DROVE-196 rewrote the decomposition, so it is restated
        // here rather than carried over: bubble, gap, control row, and the
        // row's clearance over this strip.
        expect(composerBlockHeight).toBe(
            MOBILE_COMPOSER_METRICS.inputMinHeight
            + MOBILE_COMPOSER_METRICS.controlGap
            + MOBILE_COMPOSER_METRICS.actionRowHeight
            + MOBILE_COMPOSER_METRICS.controlsBottomGap,
        );
        expect(composerBlockHeight).toBe(102);
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

    it('makes the bar exactly as wide as the composer above it', () => {
        // The shell inset is the composer's outer gutter since DROVE-196: the
        // padding on the composer's line, and on the control row under it. The
        // banner runs rim to rim with both. Before that the card spanned the
        // whole dock and carried the gutter inside itself, so this assertion
        // was true of the number and false of the picture.
        expect(RECORDING_BANNER_FRAME.left).toBe(MOBILE_COMPOSER_METRICS.shellInset);
        expect(RECORDING_BANNER_FRAME.right).toBe(MOBILE_COMPOSER_METRICS.shellInset);
        expect(RECORDING_BANNER_FRAME.left)
            .toBe(resolveMobileComposerLineGeometry().paddingHorizontal);
        expect(RECORDING_BANNER_FRAME.left)
            .toBe(resolveMobileComposerControlRowGeometry().paddingHorizontal);
    });

    /**
     * DROVE-206 rebuilt what is above this bar at both ends of the field and
     * on the row under it, and the bar's box did not move. That is the same
     * guarantee DROVE-196 tested, asked again of a bigger change: the strip is
     * 6 over 18 whatever the composer is arranged like, so a recording still
     * cannot resize the dock or shove the transcript.
     */
    it('survives the plus moving into the field and the waveform onto the row', () => {
        expect(COMPOSER_STRIP_PADDING_TOP).toBe(6);
        expect(COMPOSER_STRIP_MIN_HEIGHT).toBe(18);
        expect(COMPOSER_STRIP_HEIGHT).toBe(24);
        expect(resolveComposerStripHeight(true, true)).toBe(resolveComposerStripHeight(false, true));

        // And the bar is now the bubble's own two rims rather than the `+`'s
        // leading edge at one end and the bubble's rim at the other, because
        // the `+` is inside the field. Same two columns, one fewer thing they
        // depend on.
        expect(MOBILE_COMPOSER_BASE_HEIGHT).toBe(102);
    });

    it('leaves the bar tall enough to hold the dot, clock, level and glyph', () => {
        expect(RECORDING_BANNER_HEIGHT).toBe(COMPOSER_STRIP_HEIGHT - RECORDING_BANNER_INSET_TOP);
        expect(RECORDING_BANNER_HEIGHT).toBeGreaterThanOrEqual(18);
    });

    it('keeps the strip the 24pt the dock arithmetic was measured against', () => {
        expect(COMPOSER_STRIP_HEIGHT).toBe(COMPOSER_STRIP_PADDING_TOP + COMPOSER_STRIP_MIN_HEIGHT);
        expect(COMPOSER_STRIP_HEIGHT).toBe(24);
    });

    /**
     * DROVE-196 rebuilt everything above this strip and the strip did not move
     * a point. That is the DROVE-157 guarantee doing its job, so it is asserted
     * rather than assumed.
     */
    it('survives the control row leaving the card without changing its box', () => {
        expect(COMPOSER_STRIP_PADDING_TOP).toBe(MOBILE_COMPOSER_METRICS.controlGap);
        expect(COMPOSER_STRIP_MIN_HEIGHT).toBe(18);
        expect(COMPOSER_STRIP_HEIGHT).toBe(24);

        // The status text still sits 14pt below the lowest control: 8 of the
        // row's own clearance, then this strip's 6. It was 8 of card padding
        // and the same 6 before the row moved out.
        expect(MOBILE_COMPOSER_METRICS.controlsBottomGap + COMPOSER_STRIP_PADDING_TOP).toBe(14);
        expect(MOBILE_COMPOSER_METRICS.controlsBottomGap)
            .toBe(MOBILE_COMPOSER_METRICS.shellPaddingBottom);
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
