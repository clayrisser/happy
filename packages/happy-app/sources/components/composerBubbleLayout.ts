import type { FlexFrame, FlexStyle } from './flexFrames';
import { getGlassSurfaceOverflow } from './glassInteractionPolicy';
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
 *                     capsule   permission ‖ read-aloud ‖ effort ‖ model,
 *                               39 tall, 27 per glyph segment
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
        // THE ROW IS A SURFACE NOW, SO IT HAS A SHAPE (DROVE-343). It is the
        // bubble's press target, which means it swells, and a rectangle
        // swelling inside a 30pt-rounded shell would show its corners crossing
        // the shell's arc. `shellRadius - bubbleInset` is the shell's own arc
        // offset inward by the padding between them — the concentric radius,
        // derived rather than picked, so the two curves stay parallel at every
        // text height.
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius - MOBILE_COMPOSER_METRICS.bubbleInset,
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
 * The session capsule inside the row: permission, read-aloud, effort and the
 * model's name (DROVE-236, DROVE-284). DROVE-281's auto-accept bolt sat in it
 * too, touching the padlock, until DROVE-331 sent it back to the sheet.
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
        // 27, the glyph's measured ink plus `controlGap` either side plus the
        // one point of air Clay granted that DROVE-320 left standing. It was
        // the widest whole point the 375 floor afforded while four of them
        // shared the row; DROVE-331 took the bolt and handed its 27 to the
        // name, so the floor affords more than this now and this is the ink
        // rule, not the ceiling. Four of them at a disc's width is what forced
        // the second row Clay rejected; DROVE-284 cut them to the ink and Clay
        // has since ruled that over-tight (“spread them out”).
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
 * THE BUBBLE'S MATERIAL, AND WHAT IT NO LONGER ANSWERS (DROVE-328, DROVE-343).
 *
 * Beside the geometry for the same reason the geometry is here: so the spec
 * that mounts the bubble's host (`composerGlassSurfaces.test.ts`) mounts it
 * with what `AgentInput` draws, rather than a restatement that drifts. It is
 * real Liquid Glass (DROVE-153), `regular` because `clear` draws close to
 * nothing over a black chat.
 *
 * `interactive` IS NOT IN HERE ANY MORE, AND THAT IS THE TICKET. DROVE-266 put
 * it on this surface so the composer would stop faking its presses, and it
 * worked: `UIGlassEffect.isInteractive` is a property of the effect VIEW, so
 * the whole bubble lenses and swells under a finger. It is also why the bubble
 * swells when the finger is on the `+` or on a segment of the session capsule,
 * which is what Clay filed: "whenever I push a button from that group, the
 * input box should not also have that touch effect. The input box should only
 * get the touch effect when I'm touching where the text is."
 *
 * There is no per-region switch on the effect. Its interaction sees every
 * touch delivered inside its `contentView`, and every control in the composer
 * mounts there. So the press moved rather than being filtered: the SHELL is
 * calm glass, and the bubble's press target is the text row, which carries
 * `COMPOSER_BUBBLE_TEXT_ROW_SURFACE` below. Every other press in the composer
 * already belongs to a surface of its own — the discs since DROVE-266, the
 * capsule since DROVE-343 — so nothing is left for the shell to answer.
 *
 * WHAT THE BARE GLYPHS LOSE, said plainly. Send and the mic at rest have no
 * surface (DROVE-254, DROVE-264) and drew the bubble's swell. With the shell
 * calm they fall back to `BubblePressable`'s own pressed state, which is the
 * response they have on every phone without the material. That is the cost of
 * the ruling and it is the right side of it: a press on send is a press on a
 * CONTROL, and the whole ticket is that a control press must not move the
 * field.
 */
export function resolveComposerBubbleSurface() {
    return {
        nativeEffect: true,
        material: 'liquid',
        glassEffectStyle: 'regular',
        intensity: 92,
        interactive: false,
    } as const;
}

/**
 * The bubble shell's OVERFLOW, which is still `visible` (DROVE-202, DROVE-328,
 * DROVE-343).
 *
 * `MobileGlassSurface` forces this on a surface it knows is INTERACTIVE, and
 * the shell is not one any more, so the composer states it here — through
 * `getGlassSurfaceOverflow`, the function that owns the rule, never a literal.
 * This is not the `pressTarget` escape hatch DROVE-328 deleted: that flag asked
 * the primitive to CLIP a surface on the material, and this asks it to clip
 * nothing there, which is what DROVE-202 ruled in the first place.
 *
 * It matters more now than it did, not less. The shell holds three surfaces
 * that swell past their resting frames — the text row, the `+`, the capsule —
 * and `overflow: 'hidden'` on an `ExpoView` becomes `clipsToBounds` on the view
 * the effect is pinned to, so a clipped shell would cut all three at the
 * bubble's edge. That is DROVE-328's photograph, one level out.
 *
 * AND IT TAKES THE ARGUMENT RATHER THAN ASSUMING IT. Off the material the flat
 * card is the only thing rounding what it holds, and there is no swell to cut,
 * so it still clips — the second half of `getGlassSurfaceOverflow` that
 * DROVE-202 left standing on purpose. The caller reads the material it is
 * actually on; a resolver that hard-coded `true` here would square the
 * fallback card's corners on every phone without Liquid Glass.
 */
export function resolveComposerBubbleSurfaceStyle(drawsNativeGlass: boolean) {
    return { overflow: getGlassSurfaceOverflow(drawsNativeGlass) } as const;
}

/**
 * THE BUBBLE'S PRESS TARGET: the text row, and only the text row (DROVE-343).
 *
 * Clay: "The input box should only get the touch effect when I'm touching
 * where the text is." So the interactive glass is the frame the text is in.
 * The material is the same one the shell wears — the same `liquid`, the same
 * `regular` — because a nested glass effect over the shell's own has nothing
 * left to refract and draws as nothing, which is exactly what is wanted here:
 * invisible at rest, and the platform's own lens and swell under a finger.
 *
 * That is DROVE-254's finding used rather than fought. It filed "this blends
 * in which is annoying" about the session capsule, and it was right, because a
 * capsule has to read as an OBJECT. The text row must not read as an object at
 * all; it is the field's own area. Blending in is the requirement.
 */
export function resolveComposerBubbleTextRowSurface() {
    return {
        nativeEffect: true,
        material: 'liquid',
        glassEffectStyle: 'regular',
        intensity: 92,
        interactive: true,
    } as const;
}

/**
 * WHAT A FINGER CAN LAND ON IN THE COMPOSER, resolved from the layout rather
 * than from an offset anybody worked out (DROVE-343).
 *
 * Three surfaces answer a touch with the platform's own press, and the whole
 * of Clay's ticket is which one answers where:
 *
 *   `textRow`         the bubble's press target
 *   `sessionCapsule`  the group, one surface for its four segments (DROVE-169)
 *   `add`             the `+` disc (DROVE-266)
 *
 * They are FRAMES in the resolved tree, so "the bubble's press target excludes
 * the group's hit rect" is a fact the layout engine produces rather than a
 * number a spec restates. `composerBubbleLayout.spec.ts` resolves the tree and
 * asks this function where a point lands; if the text row ever grew under the
 * capsule, or the capsule moved inside the text row, the three cases would
 * disagree and the spec would fail. Nothing here computes an offset, which is
 * DROVE-214's rule reaching the press as well as the geometry.
 *
 * Send and the mic are deliberately NOT here. They have no surface of their
 * own (DROVE-254, DROVE-264), so a press on them reaches no material and the
 * answer is `null` — a fact worth asserting rather than a gap.
 */
export type ComposerPressTarget = 'textRow' | 'sessionCapsule' | 'add';

export const COMPOSER_PRESS_TARGETS: readonly ComposerPressTarget[] = [
    'textRow',
    'sessionCapsule',
    'add',
];

function containsPoint(frame: FlexFrame, point: { x: number; y: number }): boolean {
    return point.x >= frame.x
        && point.x <= frame.x + frame.width
        && point.y >= frame.y
        && point.y <= frame.y + frame.height;
}

/**
 * Which surface answers a press at this point, or `null` where none does.
 *
 * Deepest match wins, so a point inside `modeSegment` reports the capsule that
 * holds it: one interactive surface for a grouped control (DROVE-169), and the
 * segment under the finger is a press INSIDE that surface, not a surface of its
 * own.
 */
export function resolveComposerPressTarget(
    frame: FlexFrame,
    point: { x: number; y: number },
): ComposerPressTarget | null {
    if (!containsPoint(frame, point)) {
        return null;
    }
    for (const child of frame.children) {
        const deeper = resolveComposerPressTarget(child, point);
        if (deeper) {
            return deeper;
        }
    }
    return (COMPOSER_PRESS_TARGETS as readonly string[]).includes(frame.name)
        ? frame.name as ComposerPressTarget
        : null;
}

/**
 * Whether the three press targets overlap anywhere in the resolved tree.
 *
 * The other half of the same guarantee: `resolveComposerPressTarget` says
 * where a given point lands, and this says that no point can land in two of
 * them at once. If the bubble's press target ever grew back over the group's
 * hit rect, this is what would catch it, whatever sample points a spec
 * happened to pick.
 */
export function composerPressTargetsAreDisjoint(frame: FlexFrame): boolean {
    const found: FlexFrame[] = [];
    const walk = (node: FlexFrame) => {
        if ((COMPOSER_PRESS_TARGETS as readonly string[]).includes(node.name)) {
            found.push(node);
        }
        node.children.forEach(walk);
    };
    walk(frame);
    return found.every((a, i) => found.slice(i + 1).every((b) => (
        a.x + a.width <= b.x
        || b.x + b.width <= a.x
        || a.y + a.height <= b.y
        || b.y + b.height <= a.y
    )));
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
export const COMPOSER_BUBBLE_TEXT_ROW_SURFACE = resolveComposerBubbleTextRowSurface();
