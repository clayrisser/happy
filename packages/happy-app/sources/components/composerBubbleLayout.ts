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
 *                               39 tall, FLEX 1, 33 per glyph segment
 *                     gap       6
 *                     mic       39
 *                     gap       6
 *                     primary   send / stop, 39
 *
 * THE SLACK IS THE CAPSULE'S SINCE DROVE-353, and there is no spacer in the
 * row that draws one. It sat between the capsule and the mic taking `flex: 1`
 * while the capsule sized to its content, so every point the row had spare went
 * to a view that drew nothing and the capsule stayed at its floor beside it.
 * Clay, five times, most recently over a photograph of the padlock, the
 * speaker and the dial jammed against their hairlines: "Why is everything
 * squished here? There's extra space." The spacer survives for the one case
 * that still needs it — a row with no capsule at all — and is mounted only
 * there.
 *
 * THE ACTION ROW HOLDS FOUR THINGS SINCE DROVE-284 — read-aloud's disc joined
 * the capsule — and the gaps are CHILDREN rather than the row's `gap` property.
 * That is not stylistic. The row needs a fixed 6 in three places and flexible
 * slack in exactly one, and a row-level `gap` applies to every boundary
 * including both sides of the flexible child, which would have put 12 between
 * the capsule and the mic. A gap with a width is a child the layout engine
 * resolves like any other, which is the opposite of the hand-placed offset this
 * file exists to refuse.
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
        // NO RADIUS. The first pass at DROVE-343 gave the row a concentric
        // one, because it was a surface then and a rectangle swelling inside a
        // 30pt-rounded shell would cross its arc. The row draws nothing at rest
        // now, so a radius here rounds nothing; the shell's own arc is the only
        // curve in the bubble again.
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

/**
 * The spacer that holds send against the trailing end when NOTHING ELSE ON THE
 * ROW CAN (DROVE-353).
 *
 * It used to be mounted always, and that is the bug Clay photographed five
 * times. Two things on the row wanted the slack — the capsule, which draws
 * something, and this, which draws nothing — and `flex: 1` here with a
 * content-sized capsule handed every point of it to the one that draws
 * nothing. At 375 that is 45pt of empty band between the capsule and the mic;
 * at 430 it is 100.
 *
 * So the capsule is the row's flexible child now (see
 * `resolveComposerBubbleSessionCapsuleGeometry`) and this is mounted only when
 * there is no capsule to be it: zen mode, and Home before the dock opens. A row
 * with two `flex: 1` children would SPLIT the slack, which is the same bug at
 * half strength, so the two are mutually exclusive by construction rather than
 * by a ratio anybody tuned.
 */
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
 * IT IS THE ROW'S FLEXIBLE CHILD NOW, AND THE REASON IT WAS NOT IS THE BUG
 * (DROVE-353).
 *
 * This carried `flexShrink: 1` and no `flex`, so it sized to its CONTENT, and
 * the comment here argued the case: "a capsule that filled the middle would
 * draw a lot of empty glass around a short name on a wide phone, which is why
 * the slack is a spacer beside it rather than growth inside it."
 *
 * The premise was wrong in the only way that matters. The slack does not stop
 * existing when a spacer takes it — it becomes empty BUBBLE instead of empty
 * capsule, which is worse, because the capsule beside it is then drawn at its
 * floor. Clay, on the fifth screenshot of it: "Why is everything squished
 * here? There's extra space." Both halves of that sentence are this one
 * property.
 *
 * `flex: 1`, so the capsule's width is the row's width less the three fixed
 * discs and the three gaps, and there is no band between it and the mic at any
 * width. What the capsule then does with that width is the rest of this file
 * and `sessionPillLabel.ts`: the glyph segments take the `+`'s own clearance
 * (`MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`), the hairlines take a point each,
 * and the model's name takes the remainder — which is exactly
 * `composerModelBudget`, unchanged in form, so the give-way order DROVE-331
 * wrote still decides what the name does with it.
 *
 * The old comment's worry survives as a real one and is answered elsewhere: on
 * a wide phone with a short name the remainder IS large, and the name is
 * centred in it rather than left against the last hairline, so what the reader
 * sees is a capsule with its name in the middle rather than a name shoved to
 * one side of a long empty tail.
 */
export function resolveComposerBubbleSessionCapsuleGeometry(): ComposerBubbleStyle {
    return {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        height: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    };
}

/**
 * WHAT A WRAPPER ROUND THE CAPSULE HAS TO CARRY (DROVE-375).
 *
 * `flex: 1` above is a property of the capsule's relationship to the ROW, so it
 * only means anything while the capsule is the row's direct child. Home puts a
 * `RefusableControl` in between — a bare view carrying a shake transform, so it
 * can refuse a tap while a session is being created — and a bare view sizes to
 * its content. The capsule then had nothing to flex against: it shrank to its
 * glyphs, the model segment (`flex: 1`, `minWidth: 0`) collapsed to nothing so
 * the harness name vanished, and send was dragged off the trailing edge into
 * the middle of the row. That is DROVE-353's band again, one wrapper along.
 *
 * So a screen that must wrap the capsule spreads THIS on the wrapper, and it is
 * the capsule's own flex rather than a second `1` written down twice — a
 * wrapper's whole job here is to pass the row's slack through unchanged.
 */
export function resolveComposerControlsSlotGeometry(): ComposerBubbleStyle {
    return { flex: resolveComposerBubbleSessionCapsuleGeometry().flex };
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
        //
        // 33 SINCE DROVE-353, and it is no longer a width the row can talk
        // down. It is the capsule's 20pt glyph plus
        // `MOBILE_COMPOSER_DISC_INNER_PADDING` either side — the same air the
        // `+` keeps around its own glyph, which is Clay's rule stated as an
        // addition. `flexShrink` is deliberately absent, so a long model name
        // can never claim it back: the name gives first and gives alone.
        width: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
        height: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
        alignItems: 'center',
    };
}

/**
 * THE MODEL'S NAME: the capsule's last segment, and the only thing in it that
 * takes what is left rather than a width of its own (DROVE-353).
 *
 * `flex: 1`, which is the whole of the distribution rule inside the capsule.
 * The three glyph segments are fixed at
 * `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`, the three hairlines are a point
 * each, and this takes the remainder — so the capsule's width arrives from the
 * row, the icons take their padding off the top, and the name gets whatever
 * that leaves. `composerModelBudget` computes the same number from the other
 * direction and `composerBubbleLayout.spec.ts` makes the two agree, which is
 * what stops the model of the row and the drawn row disagreeing again.
 *
 * IT WAS THE NAME'S OWN WIDTH BEFORE, which is why the row needed a spacer at
 * all. A segment as wide as its text leaves a remainder, and a remainder needs
 * somewhere to go; the spacer was that somewhere, and it drew nothing. Now the
 * remainder is inside the capsule and the name is centred in it.
 *
 * WHAT THE NAME DOES WHEN THE REMAINDER IS TOO SMALL is unchanged and is
 * DROVE-331's order: full size, then down to `minimumFontScale`, then a tail
 * ellipsis. `composerModelPresentation` says which of the three a given phone
 * is on. Nothing here decides that — this only says the segment is the
 * remainder, which is the fact the presentation is measured against.
 */
export function resolveComposerBubbleSessionModelSegmentGeometry(): ComposerBubbleStyle {
    return {
        flex: 1,
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
 * mounts there. So `interactive` is not a constant of the surface any more: it
 * is decided per press by `resolveComposerShellInteractive` below, true only
 * while a finger is on the text row. Every other press in the composer already
 * belongs to a surface of its own — the discs since DROVE-266, the capsule
 * since DROVE-343 — so a control press leaves the shell calm and nothing is
 * left for it to answer.
 *
 * The first pass gave the text row a nested surface instead, and a surface
 * mounted at rest DRAWS at rest: Clay photographed the field as a lighter
 * panel. `resolveComposerShellInteractive` carries that whole argument.
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
 * THE BUBBLE'S PRESS TARGET IS THE TEXT ROW, AND THE TEXT ROW DRAWS NOTHING
 * (DROVE-343, second pass).
 *
 * THE FIRST PASS PUT A SURFACE THERE AND IT WAS VISIBLE. It gave the text row
 * its own `liquid`/`regular` `MobileGlassSurface`, on the reasoning that a
 * glass effect nested in the shell's own has nothing left to refract and so
 * draws as nothing — DROVE-254's finding, used rather than fought. The
 * reasoning was about the EFFECT and the surface is more than the effect:
 * `MobileGlassSurface` also paints `chromeGlassTint` on it (DROVE-171, a tint
 * chosen precisely so the composer SEPARATES from the chat behind it) and a
 * full-bleed white `LinearGradient` over that. On OTA 01a05f69, iOS 26 build
 * 18, Clay: "What the hell happened here?" over a screenshot of a distinctly
 * lighter rounded panel filling the whole field.
 *
 * So there is no surface on the text row at rest. No material, no tint, no
 * rim: the bubble looks exactly as it did before this ticket, which is the
 * only acceptable resting state for the field's own area.
 *
 * WHAT DRAWS THE PRESS INSTEAD. The SHELL, and only while a finger is on the
 * text row. `UIGlassEffect.isInteractive` is a property of the effect view and
 * answers every touch delivered inside it — that is the whole reason the press
 * had to move off the shell in the first place, because a press on the `+` or
 * on the capsule swelled the bubble. It is also a plain boolean prop, so the
 * question "is this press on the text row" can be asked in JS and answered
 * before UIKit ever sees it. The text row reports its own touches, this
 * function turns that into the shell's `isInteractive`, and a touch that
 * starts anywhere else never reaches it.
 *
 * That keeps all three press cases and costs the resting state nothing, which
 * the surface could not do at any tint: an effect view mounted at rest draws
 * at rest.
 */
export function resolveComposerShellInteractive(
    pressedTarget: ComposerPressTarget | null,
): boolean {
    return pressedTarget === 'textRow';
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
export const COMPOSER_BUBBLE_CONTROLS_SLOT_GEOMETRY = resolveComposerControlsSlotGeometry();
export const COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY = resolveComposerBubbleSessionSegmentGeometry();
export const COMPOSER_BUBBLE_SESSION_MODEL_SEGMENT_GEOMETRY = resolveComposerBubbleSessionModelSegmentGeometry();
export const COMPOSER_BUBBLE_DISC_GEOMETRY = resolveComposerBubbleDiscGeometry();
export const COMPOSER_BUBBLE_SURFACE = resolveComposerBubbleSurface();
