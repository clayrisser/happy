import { MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import { STATUS_ROW_ROW_HEIGHT, STATUS_ROW_TEXT_LINE_HEIGHT } from './agentDockLayout';

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
 * guarantee working: the strip is 6 over the status text's line whatever is
 * above it, so the dock's arithmetic and the banner's overlay both survived
 * the card being rebuilt.
 *
 * WHAT THE OVERLAY DID NOT BUY (DROVE-221). Absolute positioning stops the
 * BANNER adding height. It says nothing about the band the banner is pinned
 * inside, and that band was written down twice: as the status row's own box
 * here, and as a `minHeight` this module handed the recording wrapper. The two
 * disagreed by 4pt, so the composer moved anyway and the guarantee read as
 * kept while the bug was live. There is one number now, `COMPOSER_STRIP_BOX`,
 * and both states read it.
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
 * The band's content row: the 11pt status text's line box, which is also the
 * tallest thing the row can draw (the context ring is 14 as well).
 *
 * It is `STATUS_ROW_TEXT_LINE_HEIGHT`, imported rather than written down
 * again, because that is the number the whole dock's landmark table is built
 * on (`agentDockLayout`, "30 the status text's top, 36 the strip's top edge").
 */
export const COMPOSER_STRIP_CONTENT_HEIGHT = STATUS_ROW_TEXT_LINE_HEIGHT;

/**
 * THE BAND. One number, and both occupants read it (DROVE-221).
 *
 * Clay: "the red bar that transforms when I'm talking is a little bit taller
 * than what it's replacing, so the chat and buttons move by a few pixels."
 *
 * Measured, it was 20pt at rest and 24pt with the mic open, a 4pt jump:
 *
 *  - AT REST the band is the status row's own box, and that box is
 *    `paddingTop: 6` over a 14pt line. React Native's `minHeight` is a
 *    BORDER-box constraint, so the 18 the row also carried was never binding:
 *    max(18, 6 + 14) is 20.
 *  - WITH THE MIC OPEN the band was whatever `COMPOSER_STRIP_HEIGHT` said, and
 *    it said `PADDING_TOP + MIN_HEIGHT` = 6 + 18 = 24. That sum counts the
 *    padding twice: once as itself and once inside the min it is added to.
 *
 * So the 4pt was dead air opened at the TOP of the band the moment he spoke,
 * and DROVE-219 had just hung the chat's bottom fade off the dock's measured
 * height, which took the fade up with it.
 *
 * The bar itself never wanted those 4pt. Pinned `top: 4, bottom: 0` in a 24pt
 * band it drew from 16 to 36 above the screen edge; the resting band is 16 to
 * 36 exactly. So the band is the resting height, the inset goes to zero, and
 * the bar draws in precisely the pixels it always did while everything above
 * it stops moving.
 *
 * `STATUS_ROW_ROW_HEIGHT` is the same 6-over-14, and it is what
 * `resolveStatusStripBandHeight` and `resolveComposerButtonFloor` have always
 * measured the dock against. This is not a second constant that agrees with
 * it; it IS it. Do not re-derive it here from `COMPOSER_STRIP_PADDING_TOP`,
 * because that is how the two drifted apart the first time.
 */
export const COMPOSER_STRIP_HEIGHT = STATUS_ROW_ROW_HEIGHT;

/**
 * The band's box, as a style. Exported so the status row and the recording
 * banner's wrapper cannot spell it differently: the resting state and the
 * recording state are the same box with different content in it.
 *
 * `minHeight` rather than `height`, so a larger accessibility type size grows
 * the band instead of clipping it. It grows the same way in both states,
 * because the status row stays MOUNTED under the banner (DROVE-157) and is
 * what sets the height in both.
 */
export const COMPOSER_STRIP_BOX = {
    paddingTop: COMPOSER_STRIP_PADDING_TOP,
    minHeight: COMPOSER_STRIP_HEIGHT,
} as const;

/**
 * The banner's own top inset inside the band, and it is zero.
 *
 * It was 4, which read as "a filled bar wants less air than a line of text".
 * That was true of the picture and false of the box: the 4 was measured
 * against a band that was 4pt too tall, so the two cancelled and the bar
 * landed right while the band did not. The air above the bar is the control
 * row's own 8pt clearance (`COMPOSER_CONTROLS_BOTTOM_GAP`), which is the same
 * clearance everything else in this strip sits under.
 */
export const RECORDING_BANNER_INSET_TOP = 0;

/** 20pt of red. Enough for a dot, a clock, a level strip and a glyph. */
export const RECORDING_BANNER_HEIGHT = COMPOSER_STRIP_HEIGHT - RECORDING_BANNER_INSET_TOP;

/**
 * The air the level strip leaves above and below itself inside the pill.
 *
 * Small on purpose. The strip is the only thing in the row that wants height,
 * and DROVE-383 is about it having had far too little: it was handed 12 of the
 * pill's 20 points and drew a row of dots. Two points of clearance is enough
 * to keep a full-scale bar off the capsule's curve.
 */
export const RECORDING_WAVE_INSET = 2;

/**
 * How tall the level strip is: the pill's inner height.
 *
 * DERIVED, not chosen. The pill's own height does not move for this — that is
 * `RECORDING_BANNER_HEIGHT` and DROVE-157 / DROVE-221 are both about what
 * happens when it drifts — so the strip is what the pill already has, minus
 * its clearance, and it changes only if the pill does.
 */
export const RECORDING_WAVE_HEIGHT = RECORDING_BANNER_HEIGHT - RECORDING_WAVE_INSET * 2;

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
 * Left and right are the shell inset, which is the composer's outer gutter, so
 * the bar is exactly as wide as the composer above it. That claim used to be
 * aspiration rather than fact, because the card spanned the whole dock and
 * carried the gutter inside itself; DROVE-196 moved the gutter out onto the
 * composer line and the control row, and the two really became the same width.
 *
 * DROVE-206 made it simpler still without moving a number. The bar used to run
 * from the `+`'s leading edge to the bubble's trailing rim, which was two
 * different things at the two ends; the `+` is inside the field now, so both
 * ends are the bubble's own rims and the bar is the card's width literally.
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
 * does open `COMPOSER_STRIP_HEIGHT` that was not there before. There is no way
 * around it: the banner has to be visible somewhere. It costs 20pt instead of
 * the banner's old 48, and only on a session with no connection, no quota and
 * no live turn.
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
