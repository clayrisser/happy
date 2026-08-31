import type { FlexStyle } from './flexFrames';
import {
    MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
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
 *     actionRow     row, alignItems centre, the `+` then a spacer then send
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
 * WHAT IS IN THE BUBBLE AND WHAT IS NOT. Inside: things that act on the
 * message being composed, so the `+` and send. Outside on the control row:
 * things that act on the session, so permission mode, effort, model, speaker
 * and mic. That is DROVE-196's "the second row buttons should sit outside the
 * speech bubble" and DROVE-206's "the boss should not be in the message box
 * but the plus should be" both kept intact, and it is what the Messages
 * reference does: no session-shaped control is in its bubble either.
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
 */
export function resolveComposerBubbleGeometry(): ComposerBubbleStyle {
    return {
        flexDirection: 'column',
        alignItems: 'stretch',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        padding: MOBILE_COMPOSER_METRICS.bubbleInset,
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
 * The button row: the `+` at the leading end, send at the trailing end.
 *
 * As tall as the discs and no taller, so the air around them is the bubble's
 * padding rather than a number of their own. `alignItems: 'center'` is what
 * three passes of arithmetic were standing in for, and it holds at any height
 * this row is ever given.
 *
 * A `flex: 1` spacer separates the two rather than `justifyContent:
 * 'space-between'`, so zen mode — which draws no `+` — still puts send at the
 * trailing end instead of sliding it to the leading one.
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

/** The spacer that holds send against the trailing end whatever else is drawn. */
export function resolveComposerBubbleSpacerGeometry(): ComposerBubbleStyle {
    return { flex: 1 };
}

/** Either disc on that row. They are the same object at two ends. */
export function resolveComposerBubbleDiscGeometry(): ComposerBubbleStyle {
    return resolveMobileComposerActionGeometry('primary') as ComposerBubbleStyle;
}

export const COMPOSER_BUBBLE_GEOMETRY = resolveComposerBubbleGeometry();
export const COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY = resolveComposerBubbleTextRowGeometry();
export const COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY = resolveComposerBubbleActionRowGeometry();
export const COMPOSER_BUBBLE_SPACER_GEOMETRY = resolveComposerBubbleSpacerGeometry();
export const COMPOSER_BUBBLE_DISC_GEOMETRY = resolveComposerBubbleDiscGeometry();
