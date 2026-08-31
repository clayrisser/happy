import { MOBILE_COMPOSER_METRICS } from './agentInputLayout';

/**
 * The strip under the composer card, and who is allowed to sit in it
 * (DROVE-157).
 *
 * Clay circled the red recording banner and drew an arrow down: "I think the
 * little red audio thing should go down into this section." The banner used
 * to render INSIDE the composer card, above the text field, so the moment he
 * started talking the card grew by the banner's height, the dock's measured
 * box grew with it, and the transcript jumped. Every sentence cost him his
 * place in the chat.
 *
 * So the banner moves under the card, into the strip the status row already
 * owns (DROVE-82), and it goes there as an ABSOLUTELY POSITIONED overlay. An
 * absolutely positioned child contributes no height, which is what makes the
 * fix a layout guarantee rather than two numbers that have to keep agreeing:
 * the dock cannot move when a recording starts, whatever the banner is drawn
 * like. The status row stays mounted underneath, covered for the duration, so
 * its subscription, its ticking timer and its two sheets are not torn down
 * and rebuilt every time the mic opens.
 *
 * The status row is DELIBERATELY REPLACED while recording, not moved aside.
 * It is 11pt text on one line and there is no second line to give it; a
 * dictation lasts seconds, and the thing worth reading in those seconds is
 * the mic, not the quota.
 *
 * DROVE-142 owns what the banner SAYS (no words, colour plus mark plus
 * trailing glyph). This module owns only where it sits and how tall the strip
 * is. DROVE-153 is reworking the card's material and arrangement above this
 * line; nothing here reaches inside the card.
 *
 * DROVE-196 moved the `+` up beside send and the control row out from under
 * the card, and this file's box did not move a point for it. That is the
 * guarantee working: the strip is 6 + 18 whatever is above it, so the dock's
 * arithmetic and the banner's overlay both survived the card being rebuilt.
 */

/**
 * Air between the composer's furniture and whatever the strip holds.
 *
 * The same 6pt gap that separates every other pair of things in the composer
 * (`MOBILE_COMPOSER_METRICS.controlGap`): the `+` from the bubble, the bubble
 * from the control row, one control from the next. Since DROVE-196 what is
 * directly above this is the control row rather than the card's bottom edge,
 * and the row keeps its own 8pt clear under itself
 * (`COMPOSER_CONTROLS_BOTTOM_GAP`), so the status text sits 14pt below the
 * lowest control exactly as it did when the row was inside the card.
 */
export const COMPOSER_STRIP_PADDING_TOP = MOBILE_COMPOSER_METRICS.controlGap;

/**
 * Floor for the strip's content row. The status row's 11pt text is shorter
 * than this, so the strip is a fixed 24pt in practice, which is the number
 * agentDockLayout.test.ts has been measuring the dock against all along.
 */
export const COMPOSER_STRIP_MIN_HEIGHT = 18;

export const COMPOSER_STRIP_HEIGHT = COMPOSER_STRIP_PADDING_TOP + COMPOSER_STRIP_MIN_HEIGHT;

/**
 * The banner's own top inset inside the strip. Slightly tighter than the
 * status row's, because a filled bar wants to read as attached to the card it
 * belongs to, where a line of text wants air.
 */
export const RECORDING_BANNER_INSET_TOP = 4;

/** 20pt of red. Enough for a dot, a clock, a level strip and a glyph. */
export const RECORDING_BANNER_HEIGHT = COMPOSER_STRIP_HEIGHT - RECORDING_BANNER_INSET_TOP;

export interface RecordingBannerFrame {
    position: 'absolute';
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/**
 * Where the banner is pinned. `position: 'absolute'` is the load-bearing
 * part: change it and the composer starts moving the transcript again.
 *
 * Left and right are the shell inset, which is the composer's outer gutter:
 * the bar runs from the `+`'s leading edge to the bubble's trailing rim, so it
 * is exactly as wide as the composer above it. That claim used to be aspiration
 * rather than fact, because the card spanned the whole dock and carried the
 * gutter inside itself; DROVE-196 moved the gutter out onto the composer line
 * and the control row, and the two now really are the same width.
 */
export const RECORDING_BANNER_FRAME: RecordingBannerFrame = {
    position: 'absolute',
    left: MOBILE_COMPOSER_METRICS.shellInset,
    right: MOBILE_COMPOSER_METRICS.shellInset,
    top: RECORDING_BANNER_INSET_TOP,
    bottom: 0,
};

export type ComposerStripOccupant = 'status' | 'recording';

/** What the reader is actually looking at in the strip right now. */
export function resolveComposerStripOccupant(recordingActive: boolean): ComposerStripOccupant {
    return recordingActive ? 'recording' : 'status';
}

/**
 * How tall the strip is.
 *
 * The whole point of the ticket is the first clause: with a status row there,
 * the answer does not depend on `recordingActive` at all. The second clause
 * is the one edge worth stating out loud. A session with nothing to say
 * renders no status row and no strip, so a recording started on THAT session
 * does open 24pt that was not there before. There is no way around it: the
 * banner has to be visible somewhere. It costs 24pt instead of the banner's
 * old 48, and only on a session with no connection, no quota and no live
 * turn.
 */
export function resolveComposerStripHeight(
    recordingActive: boolean,
    statusRowRendered: boolean,
): number {
    if (statusRowRendered) {
        return COMPOSER_STRIP_HEIGHT;
    }
    return recordingActive ? COMPOSER_STRIP_HEIGHT : 0;
}
