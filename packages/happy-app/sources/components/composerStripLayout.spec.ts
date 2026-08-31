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
import { resolveDockInset } from './agentDockLayout';

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
