import type { FlexStyle } from './flexFrames';
import {
    MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_METRICS,
    MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT,
    resolveMobileComposerActionGeometry,
} from './agentInputLayout';

/**
 * THE CHAT BUBBLE'S LAYOUT, as styles the layout engine reads rather than
 * numbers anybody computed (DROVE-214).
 *
 * Clay, after three passes of arithmetic that were each internally correct and
 * visually wrong: "Why don't you use layout system for these things?", then
 * "probably we should put everything in the speech bubble with the buttons on
 * the bottom and the text input one row above it?"
 *
 * THE TREE, and it is the whole design:
 *
 *   bubble          column, padding `bubbleInset`, gap `controlGap`
 *     textRow       the field, full width, as tall as the text
 *     actionRow     row, alignItems centre:
 *                     add       the `+`, 36
 *                     gap       6
 *                     capsule   permission | effort | model, 36 tall
 *                     gap       6
 *                     spacer    flex 1, the row's only slack
 *                     audio     the audio-out disc, 36
 *                     gap       6
 *                     primary   send / mic / stop, 36
 *
 * THE ACTION ROW HOLDS FIVE THINGS SINCE DROVE-236, and the gaps are CHILDREN
 * rather than the row's `gap` property. That is not stylistic. The row needs a
 * fixed 6 in three places and flexible slack in exactly one, and a row-level
 * `gap` applies to every boundary including both sides of the spacer, which
 * would have put 12 between the capsule and the audio disc at the width where
 * the row is fullest. A gap with a width is a child the layout engine resolves
 * like any other, which is the opposite of the hand-placed offset this file
 * exists to refuse.
 *
 * WHY THIS DISSOLVES THE BUG RATHER THAN FIXING IT. Every earlier pass placed
 * a 36pt disc inside the row the text lives in, and that row's height is not
 * knowable: it is one line when the composer is empty and grows with every
 * wrap. So the disc had to be pinned to something, it was pinned to the
 * bottom with `position: absolute`, and the moment the field grew the discs
 * hung low and grazed the bubble's rounded corners. Measured off Clay's crop
 * at 3px/pt: the bubble drew 66pt against a 44pt model, the discs sat 10.7pt
 * below its centre, and their clearance at the corner fell from 4.7pt to under
 * 2. Three green suites never saw it, because they asserted a model of the
 * layout and the renderer's own stylesheet is where the pin lived.
 *
 * Give the buttons a row of their own and the question has no subject. The
 * text row grows; the button row cannot, because it holds no text. Nothing is
 * centred against anything variable, and `alignItems: 'center'` covers what is
 * left at any height.
 *
 * WHAT IS IN THE BUBBLE. Everything (DROVE-236).
 *
 * DROVE-196 split them: the message's controls inside, the session's outside,
 * on Clay's "the second row buttons should sit outside the speech bubble". He
 * has now drawn the opposite in red on a screenshot: an arrow from the
 * session capsule up into the bubble's empty middle beside the `+`, another
 * from the audio button up to the right rim, and an X through the mic that is
 * already in there. So the split is off. It is one bubble: text on top, then
 * `+`, the session controls, the audio button and send.
 *
 * That is a reversal of DROVE-196 and worth naming as one. What it does NOT
 * reverse is DROVE-206's "the boss should not be in the message box": boss
 * mode is not a control here, it is the audio button's long press, and the
 * audio button is one thing rather than the two-identities-in-one-spot that
 * ticket was about.
 *
 * NOTHING HERE CARRIES `position`. That is asserted, not assumed
 * (`composerBubbleLayout.spec.ts`), because a hand-placed offset is exactly
 * what shipped three times.
 */
export type ComposerBubbleStyle = FlexStyle;

/**
 * The bubble itself: a column of two rows with one padding all round.
 *
 * The padding is the discs' margin and the text's, and it is here rather than
 * on either of them because that is what a container's padding is for. Clay:
 * "margin as padding on the row".
 *
 * Not one number since DROVE-236: the floor is 4 and the other three sides are
 * 9, because the floor is the only side with no text against it.
 */
export function resolveComposerBubbleGeometry(): ComposerBubbleStyle {
    return {
        flexDirection: 'column',
        alignItems: 'stretch',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        padding: MOBILE_COMPOSER_METRICS.bubbleInset,
        // THE FLOOR IS SHALLOWER THAN THE OTHER THREE SIDES (DROVE-236). The
        // three that hold text keep the square corner's 9; the one that holds
        // two circles keeps what a circle needs, which is less, and the control
        // row under the bubble comes up by the difference. The derivation and
        // the clearance at each candidate are on `bubbleInsetBottom`.
        paddingBottom: MOBILE_COMPOSER_METRICS.bubbleInsetBottom,
        gap: MOBILE_COMPOSER_METRICS.controlGap,
    };
}

/**
 * The text row: the full interior width, and a floor of one line.
 *
 * No leading or trailing reservation, because nothing stands beside the text
 * any more. That is what deletes `inputLeadingActionPadding`,
 * `inputTrailingActionPadding`, `resolveComposerLeadingPadding` and the pinned
 * widths at 320 / 375 / 393: the caret starts at the bubble's interior edge in
 * every state, so it cannot move between empty and typed and there is nothing
 * left to pin.
 */
export function resolveComposerBubbleTextRowGeometry(): ComposerBubbleStyle {
    return {
        width: '100%',
        // The row's OWN padding lives here rather than in the renderer, so the
        // spec resolves the same box the screen draws. Splitting it was how the
        // model and the render drifted last time.
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
        paddingLeft: 0,
        paddingRight: 0,
        minHeight: MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT,
        maxHeight: MOBILE_COMPOSER_METRICS.inputMaxHeight
            + MOBILE_COMPOSER_METRICS.inputPaddingTop
            + MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    };
}

/**
 * The button row: the `+` at the leading end, send at the trailing end, and
 * since DROVE-236 the session controls and the audio button between them.
 *
 * As tall as the discs and no taller, so the air around them is the bubble's
 * padding rather than a number of their own. `alignItems: 'center'` is what
 * three passes of arithmetic were standing in for, and it holds at any height
 * this row is ever given, the capsule included: it is the same 36 as the
 * discs and therefore needs no centring at all.
 *
 * A `flex: 1` spacer holds send at the trailing end rather than
 * `justifyContent: 'space-between'`, so zen mode, which draws neither the `+`
 * nor the capsule, still puts send at the trailing end instead of sliding it
 * to the leading one.
 */
export function resolveComposerBubbleActionRowGeometry(): ComposerBubbleStyle {
    return {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        width: '100%',
        height: MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    };
}

/**
 * THE CAPSULE'S OWN ROW, on the phones too narrow to share one (DROVE-266).
 *
 * DROVE-196's layout, brought back for the widths that need it, which is what
 * DROVE-264 named as the remedy and what growing the buttons made unavoidable:
 * six objects at 39 leave 77pt for the name at 375 and 22 at 320, and the
 * longest name needs 91. The argument and the crossover are on
 * `composerCapsuleOwnRow` in sessionPillLabel.ts.
 *
 * IT IS THE ACTION ROW'S SHAPE, deliberately. Same height, same centring, same
 * full interior width, so the bubble is a column of rows that are all the same
 * kind of thing and the capsule is not centred against anything variable. What
 * it does NOT take is `flex: 1` on the capsule: the capsule still sizes to its
 * content and still shrinks through the model segment, so a short name on a
 * wide-ish phone does not draw a bar of empty glass across the bubble.
 *
 * IT SITS ABOVE THE BUTTON ROW, not below it. Send stays in the bubble's
 * bottom-trailing corner where DROVE-214 put it and where its clearance from
 * the rounded corner is measured; the capsule takes the new line between the
 * text and the buttons.
 */
export function resolveComposerBubbleCapsuleRowGeometry(): ComposerBubbleStyle {
    return {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        width: '100%',
        height: MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    };
}

/** The spacer that holds send against the trailing end whatever else is drawn. */
export function resolveComposerBubbleSpacerGeometry(): ComposerBubbleStyle {
    return { flex: 1 };
}

/**
 * One fixed gap between two controls on that row (DROVE-236).
 *
 * `controlGap`, the composer's one air gap, expressed as a child with a width
 * rather than as the row's `gap` property. The row wants a fixed 6 in three
 * places and slack in one, and `gap` cannot say that: it would gap both sides
 * of the spacer as well and cost the model's name 6pt at the width where it
 * has least (see `sessionPillLabel.ts`).
 */
export function resolveComposerBubbleGapGeometry(): ComposerBubbleStyle {
    return { width: MOBILE_COMPOSER_METRICS.controlGap };
}

/**
 * The session capsule inside the row: permission, effort and the model's name
 * (DROVE-236).
 *
 * It sizes to its CONTENT and shrinks through the model segment, which is the
 * one part of it with a width of its own. It does not take `flex: 1`: a
 * capsule that filled the middle would draw a lot of empty glass around a
 * short name on a wide phone, which is why the slack is a spacer beside it
 * rather than growth inside it.
 */
export function resolveComposerBubbleSessionCapsuleGeometry(): ComposerBubbleStyle {
    return {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        height: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    };
}

/**
 * A glyph segment inside that capsule: permission mode, or the effort gauge.
 *
 * A square, and the glyph inside it is centred by the renderer's own
 * `alignItems`/`justifyContent`. Only `alignItems` is stated here because
 * `justifyContent: 'center'` is outside what the resolver models, and a style
 * the resolver cannot read is a style a spec cannot check.
 */
export function resolveComposerBubbleSessionSegmentGeometry(): ComposerBubbleStyle {
    return {
        width: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
        height: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
        alignItems: 'center',
    };
}

/** Any disc on that row. They are the same object at three places. */
export function resolveComposerBubbleDiscGeometry(): ComposerBubbleStyle {
    return resolveMobileComposerActionGeometry('primary') as ComposerBubbleStyle;
}

export const COMPOSER_BUBBLE_GEOMETRY = resolveComposerBubbleGeometry();
export const COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY = resolveComposerBubbleTextRowGeometry();
export const COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY = resolveComposerBubbleActionRowGeometry();
export const COMPOSER_BUBBLE_CAPSULE_ROW_GEOMETRY = resolveComposerBubbleCapsuleRowGeometry();
export const COMPOSER_BUBBLE_SPACER_GEOMETRY = resolveComposerBubbleSpacerGeometry();
export const COMPOSER_BUBBLE_GAP_GEOMETRY = resolveComposerBubbleGapGeometry();
export const COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY = resolveComposerBubbleSessionCapsuleGeometry();
export const COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY = resolveComposerBubbleSessionSegmentGeometry();
export const COMPOSER_BUBBLE_DISC_GEOMETRY = resolveComposerBubbleDiscGeometry();
