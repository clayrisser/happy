import type { FlexStyle } from './flexFrames';
import {
    MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
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
 *                     add       the `+`, 39
 *                     gap       6
 *                     capsule   permission | auto-accept ‖ read-aloud ‖
 *                               effort ‖ model, 39 tall, 28 per glyph segment
 *                     gap       6
 *                     spacer    flex 1, the row's only slack
 *                     mic       39
 *                     gap       6
 *                     primary   send / stop, 39
 *
 * THE ACTION ROW HOLDS FOUR THINGS SINCE DROVE-284 — read-aloud's disc joined
 * the capsule — and the gaps are CHILDREN rather than the row's `gap` property.
 * That is not stylistic. The row needs a fixed 6 in three places and flexible
 * slack in exactly one, and a row-level `gap` applies to every boundary
 * including both sides of the spacer, which would have put 12 between the
 * capsule and the mic at the width where the row is fullest. A gap with a width is a child the layout engine resolves
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
 * `+`, the session controls, read-aloud, the mic and send.
 *
 * AND READ-ALOUD HAS SINCE MOVED AGAIN, into the capsule (DROVE-284): "Add the
 * reading mode whatever thing to the group and keep it all on the same row as
 * send and +." Its rim is one control shorter for it and the composer is one
 * row on every phone again.
 *
 * That is a reversal of DROVE-196 and worth naming as one. What it does NOT
 * reverse is DROVE-206's "the boss should not be in the message box": boss
 * mode is not a control here, it is read-aloud's long press, and read-aloud is
 * one thing rather than the two-identities-in-one-spot that ticket was about.
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
 * The button row: the `+` at the leading end, send at the trailing end, the
 * session capsule beside the `+` (DROVE-236) and the mic beside send.
 *
 * READ-ALOUD IS NOT ON IT ANY MORE (DROVE-284). Clay: "Add the reading mode
 * whatever thing to the group and keep it all on the same row as send and +."
 * It is a segment of the capsule now, which is what buys the single row back on
 * every phone.
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
        // NOT SQUARE SINCE DROVE-284. The capsule is still the row's height and
        // a glyph segment is `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH` wide —
        // the widest whole point the 375 floor affords now that the name is
        // 12pt, never under the glyph's measured ink plus `controlGap` either
        // side. Four of them at a disc's width is what forced the second row
        // Clay rejected; DROVE-284 cut them to the ink and Clay has since
        // ruled that over-tight (“spread them out”).
        width: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
        height: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
        alignItems: 'center',
    };
}

/** Any disc on that row. They are the same object at three places. */
export function resolveComposerBubbleDiscGeometry(): ComposerBubbleStyle {
    return resolveMobileComposerActionGeometry('primary') as ComposerBubbleStyle;
}

/**
 * The bubble's MATERIAL, as the props `MobileGlassSurface` reads (DROVE-328).
 *
 * Beside the geometry for the same reason the geometry is here: so the spec
 * that mounts the bubble's host (`composerGlassSurfaces.test.ts`) mounts it
 * with what `AgentInput` draws, rather than a restatement that drifts. It is
 * real Liquid Glass (DROVE-153), `regular` because `clear` draws close to
 * nothing over a black chat, and INTERACTIVE (DROVE-266) because that is the
 * one prop that makes `UIGlassEffect` lens and swell under a finger; without it
 * every control inside the bubble fakes its press.
 *
 * What is NOT here is anything about clipping. An interactive surface swells,
 * and `MobileGlassSurface` decides last that it is never clipped (DROVE-202).
 * DROVE-266 threaded a `pressTarget={false}` through to keep the card clipped
 * anyway, and Clay photographed the result: the bubble mid-swell with its
 * borders cut at the resting frame. Nothing inside the bubble needs the clip
 * on the material, and the spec above measures that rather than asserting it.
 */
export function resolveComposerBubbleSurface() {
    return {
        nativeEffect: true,
        material: 'liquid',
        glassEffectStyle: 'regular',
        intensity: 92,
        interactive: true,
    } as const;
}

export const COMPOSER_BUBBLE_GEOMETRY = resolveComposerBubbleGeometry();
export const COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY = resolveComposerBubbleTextRowGeometry();
export const COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY = resolveComposerBubbleActionRowGeometry();
export const COMPOSER_BUBBLE_SPACER_GEOMETRY = resolveComposerBubbleSpacerGeometry();
export const COMPOSER_BUBBLE_GAP_GEOMETRY = resolveComposerBubbleGapGeometry();
export const COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY = resolveComposerBubbleSessionCapsuleGeometry();
export const COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY = resolveComposerBubbleSessionSegmentGeometry();
export const COMPOSER_BUBBLE_DISC_GEOMETRY = resolveComposerBubbleDiscGeometry();
export const COMPOSER_BUBBLE_SURFACE = resolveComposerBubbleSurface();
