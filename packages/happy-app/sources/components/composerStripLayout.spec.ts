import { describe, expect, it } from 'vitest';
import { micOutcome } from '@/voice/micButton';
import {
    MOBILE_COMPOSER_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT,
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerControlRowGeometry,
    resolveMobileComposerHeight,
    resolveMobileComposerLineGeometry,
} from './agentInputLayout';
import {
    COMPOSER_STRIP_BOX,
    COMPOSER_STRIP_CONTENT_HEIGHT,
    COMPOSER_STRIP_HEIGHT,
    COMPOSER_STRIP_PADDING_TOP,
    RECORDING_BANNER_FRAME,
    RECORDING_BANNER_HEIGHT,
    RECORDING_BANNER_INSET_TOP,
    resolveComposerStripHeight,
    resolveComposerStripOccupant,
} from './composerStripLayout';
import {
    COMPOSER_CONTROLS_BOTTOM_GAP,
    DOCK_CONTENT_BOTTOM_PADDING,
    HOME_INDICATOR_KEEP_OUT,
    STATUS_ROW_ROW_HEIGHT,
    STATUS_ROW_TEXT_LINE_HEIGHT,
    resolveComposerButtonFloor,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveStatusRowBottomGap,
    resolveStatusRowTapFloor,
    resolveTranscriptBottomScrim,
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
        // The block is the bubble plus its furniture and nothing else. If the
        // banner is ever put back above the text field, this is the number
        // that grows. DROVE-214 put the `+` and send on a row inside the
        // bubble, so the bubble is 85 rather than 44 and the block is 143; the
        // decomposition around it did not change.
        expect(composerBlockHeight).toBe(
            MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT
            + MOBILE_COMPOSER_METRICS.controlGap
            + MOBILE_COMPOSER_METRICS.actionRowHeight
            + MOBILE_COMPOSER_METRICS.controlsBottomGap,
        );
        expect(composerBlockHeight).toBe(143);
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
        expect(COMPOSER_STRIP_CONTENT_HEIGHT).toBe(14);
        expect(COMPOSER_STRIP_HEIGHT).toBe(20);
        expect(resolveComposerStripHeight(true, true)).toBe(resolveComposerStripHeight(false, true));

        // And the bar is the bubble's own two rims, whatever is inside it.
        // DROVE-214 made the bubble two rows and 46pt taller and DROVE-236
        // took 5 of that back off its floor; the strip's box is unchanged
        // through both, which is the guarantee this test exists for.
        expect(MOBILE_COMPOSER_BASE_HEIGHT).toBe(143);
    });

    it('leaves the bar tall enough to hold the dot, clock, level and glyph', () => {
        expect(RECORDING_BANNER_HEIGHT).toBe(COMPOSER_STRIP_HEIGHT - RECORDING_BANNER_INSET_TOP);
        expect(RECORDING_BANNER_HEIGHT).toBeGreaterThanOrEqual(18);
    });

    it('keeps the strip the 20pt the dock arithmetic was measured against', () => {
        // The dock's landmark table is 6pt of padding over the status text's
        // 14pt line box, and this is that, not a second constant that agrees
        // with it. The `+` in the sum is asserted so the padding cannot be
        // counted twice again (DROVE-221).
        expect(COMPOSER_STRIP_HEIGHT).toBe(STATUS_ROW_ROW_HEIGHT);
        expect(STATUS_ROW_ROW_HEIGHT).toBe(COMPOSER_STRIP_PADDING_TOP + STATUS_ROW_TEXT_LINE_HEIGHT);
        expect(COMPOSER_STRIP_HEIGHT).toBe(20);
    });

    /**
     * DROVE-196 rebuilt everything above this strip and the strip did not move
     * a point. That is the DROVE-157 guarantee doing its job, so it is asserted
     * rather than assumed.
     */
    it('survives the control row leaving the card without changing its box', () => {
        expect(COMPOSER_STRIP_PADDING_TOP).toBe(MOBILE_COMPOSER_METRICS.controlGap);
        expect(COMPOSER_STRIP_CONTENT_HEIGHT).toBe(14);
        expect(COMPOSER_STRIP_HEIGHT).toBe(20);

        // The status text still sits 14pt below the lowest control: 8 of the
        // row's own clearance, then this strip's 6. It was 8 of card padding
        // and the same 6 before the row moved out.
        expect(MOBILE_COMPOSER_METRICS.controlsBottomGap + COMPOSER_STRIP_PADDING_TOP).toBe(14);
        expect(MOBILE_COMPOSER_METRICS.controlsBottomGap)
            .toBe(MOBILE_COMPOSER_METRICS.shellPaddingBottom);
    });
});

/**
 * The band is one box and speaking only changes what is in it (DROVE-221).
 *
 * Clay: "the red bar that transforms when I'm talking is a little bit taller
 * than what it's replacing, so the chat and buttons move by a few pixels."
 *
 * Both boxes, measured rather than nudged:
 *
 *   status row, at rest     20pt   paddingTop 6 over a 14pt line box
 *   recording wrapper       24pt   COMPOSER_STRIP_HEIGHT, when it was 6 + 18
 *   difference               4pt
 *
 * The 4 came from adding `COMPOSER_STRIP_PADDING_TOP` to a `minHeight` that
 * already contained it. React Native's `minHeight` is a BORDER-box constraint,
 * so the row's own 18 was never binding and its real height was 6 + 14. That
 * is what `borderBoxHeight` below models: the arithmetic the bug was made of
 * is the thing under test, not a restatement of the constant.
 *
 * DROVE-157 made the banner absolute so it could not add height, and that held.
 * What it could not cover is the band the banner is pinned INSIDE, which was
 * written down twice and disagreed. So this suite asks the question of the
 * band rather than of the banner.
 */
describe('the band is a constant and the mic only changes its contents', () => {
    /**
     * React Native's box model. `minHeight` includes padding, which is the
     * whole of the bug: `{ paddingTop: 6, minHeight: 18 }` around a 14pt line
     * is 20 tall, and 6 + 18 is not a height any box ever had.
     */
    function borderBoxHeight(
        box: { paddingTop: number; minHeight: number },
        contentHeight: number,
    ): number {
        return Math.max(box.minHeight, box.paddingTop + contentHeight);
    }

    /**
     * The band as AgentInput renders it: the status row's own box, with the
     * recording wrapper's floor under it while the mic is open. The row stays
     * MOUNTED under the banner (DROVE-157), so it is what sets the height in
     * both states.
     */
    function bandHeight(
        recordingActive: boolean,
        contentHeight = COMPOSER_STRIP_CONTENT_HEIGHT,
    ): number {
        const row = borderBoxHeight(COMPOSER_STRIP_BOX, contentHeight);
        return recordingActive ? Math.max(COMPOSER_STRIP_BOX.minHeight, row) : row;
    }

    it('measures the same band with the mic open and with it shut', () => {
        expect(bandHeight(false)).toBe(20);
        expect(bandHeight(true)).toBe(20);
        expect(bandHeight(true) - bandHeight(false)).toBe(0);
    });

    it('names the 4pt that used to be there, so it cannot come back quietly', () => {
        // The old pair, spelled out: the row's box, and a wrapper floor built
        // by adding the padding to a min that already held it.
        expect(borderBoxHeight({ paddingTop: 6, minHeight: 18 }, 14)).toBe(20);
        expect(6 + 18).toBe(24);
        expect(24 - 20).toBe(4);
        // And the floor the wrapper reads today, which is the row's own.
        expect(COMPOSER_STRIP_BOX.minHeight).toBe(20);
        expect(COMPOSER_STRIP_BOX.paddingTop).toBe(6);
    });

    it('holds even when the content is taller, because one box sets both', () => {
        // Larger accessibility type grows the band. It grows it identically in
        // both states, which is the property that matters: not that the number
        // is 20, but that the two states cannot differ.
        for (const contentHeight of [10, 14, 18, 22, 30]) {
            expect(bandHeight(true, contentHeight)).toBe(bandHeight(false, contentHeight));
        }
    });

    it('lets the bar fill the band exactly, in the pixels it already drew', () => {
        // Pinned top 4 / bottom 0 in a 24pt band the bar ran from 16 to 36
        // above the screen edge. The resting band is 16 to 36. So the inset
        // goes to zero and the bar does not move; only the dead air above it
        // is gone.
        expect(RECORDING_BANNER_INSET_TOP).toBe(0);
        expect(RECORDING_BANNER_HEIGHT).toBe(COMPOSER_STRIP_HEIGHT);
        const bottom = resolveStatusRowBottomGap(34);
        expect(bottom).toBe(16);
        expect(bottom + RECORDING_BANNER_HEIGHT).toBe(36);
        expect(bottom + bandHeight(true)).toBe(36);
    });

    /**
     * The four moments the ticket asks about, and one more at each end.
     *
     * A resting pair would have passed before this ticket as well, because the
     * banner has always been absolute. What was wrong was the wrapper the band
     * measured, so every step is checked against the same three consumers: the
     * dock's measured box, the inset the inverted chat list reserves, and
     * DROVE-219's bottom fade, which hangs off that box and so drags any jump
     * up the screen with it.
     */
    describe('across the whole gesture, not just the two resting states', () => {
        const safeAreaBottom = 34;
        const steps = [
            { name: 'before the mic opens', recording: false, latched: false, cancelArmed: false, sendArmed: false, outcome: 'undecided' },
            { name: 'the mic opens, outcome not yet decided', recording: true, latched: false, cancelArmed: false, sendArmed: false, outcome: 'undecided' },
            { name: 'the press resolves to a hold, so the lift sends', recording: true, latched: false, cancelArmed: false, sendArmed: true, outcome: 'send' },
            { name: 'the finger slides off, so the lift cancels', recording: true, latched: false, cancelArmed: true, sendArmed: true, outcome: 'cancel' },
            { name: 'a tap latches it, so a tap stops it', recording: true, latched: true, cancelArmed: false, sendArmed: false, outcome: 'stop' },
            { name: 'the lift sends and the mic closes', recording: false, latched: false, cancelArmed: false, sendArmed: false, outcome: 'undecided' },
        ] as const;

        /** The dock's own measured box, which is what `onLayout` reports. */
        function dockBox(recording: boolean): number {
            return composerBlockHeight + bandHeight(recording) + DOCK_CONTENT_BOTTOM_PADDING;
        }

        const restingBox = dockBox(false);

        for (const step of steps) {
            it(`does not move the dock when ${step.name}`, () => {
                // The outcome is a content change and nothing else: it picks a
                // colour and a glyph, and the glyph's slot is fixed width.
                expect(micOutcome({
                    latched: step.latched,
                    cancelArmed: step.cancelArmed,
                    sendArmed: step.sendArmed,
                })).toBe(step.outcome);

                const box = dockBox(step.recording);
                expect(box).toBe(restingBox);
                expect(resolveDockInset({ dockHeight: box, safeAreaBottom, floatingDock: true }))
                    .toBe(resolveDockInset({
                        dockHeight: restingBox,
                        safeAreaBottom,
                        floatingDock: true,
                    }));
                // DROVE-219's fade is hung off the same measured height, so a
                // band that jumped took the fade with it.
                expect(resolveTranscriptBottomScrim(box, safeAreaBottom))
                    .toEqual(resolveTranscriptBottomScrim(restingBox, safeAreaBottom));
            });
        }

        it('leaves the composer buttons on the floor the dock table names', () => {
            // 44 from the screen edge, in every state. It was 48 with the mic
            // open, which is the same 4pt read from the other end.
            expect(resolveComposerButtonFloor(safeAreaBottom)).toBe(44);
            expect(resolveStatusRowBottomGap(safeAreaBottom)
                + bandHeight(true)
                + COMPOSER_CONTROLS_BOTTOM_GAP).toBe(44);
            expect(resolveStatusRowBottomGap(safeAreaBottom)
                + bandHeight(false)
                + COMPOSER_CONTROLS_BOTTOM_GAP).toBe(44);
        });
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
