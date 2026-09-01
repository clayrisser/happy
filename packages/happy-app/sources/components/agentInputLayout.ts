/**
 * How much of its own em box an Ionicons glyph's OUTLINE fills, measured off
 * `Ionicons.ttf` (unitsPerEm 512) rather than guessed.
 *
 *   add          x  96.0000..416.0000   0.625000 of the em
 *   send         x  16.0000..495.6452   0.936807, and y -16..399.5 is 0.811523
 *
 * IT SIZES ONE GLYPH AGAINST THE OTHER AND PLACES NEITHER (DROVE-214). Three
 * passes on that ticket used these ratios to compute where to put a glyph
 * inside a box, and all three shipped something Clay called wrong. Placement is
 * the layout engine's job: every glyph in the composer is centred by
 * `alignItems`/`justifyContent` in the disc that holds it, and every offset
 * derived from these numbers is deleted.
 *
 * What survives is a question flexbox genuinely cannot answer: two different
 * marks at the same point size draw different amounts of ink, so matching
 * their WEIGHT means matching ink rather than font size. That is `sendIconSize`
 * and nothing else.
 *
 * THE MEASURE IS THE LONGEST INK SPAN (DROVE-236). `paper-plane` was square in
 * its own bounds, 0.874486 wide against 0.874407 tall, so DROVE-214 could
 * write "the x span" and never meet the question. `send` is not square: it is
 * 0.936807 wide and 0.811523 tall. Matching on the height would draw a mark
 * 18.76pt across against the `+`'s 16.25pt box, which is a heavier right rim
 * than left. Matching on the longest span caps the glyph's ink box at the
 * `+`'s, so neither end of the row draws a bigger mark than the other. That is
 * the same rule DROVE-214 applied, stated for a glyph where the two axes
 * disagree.
 *
 * `paperPlane` is gone with the plane (DROVE-236). Its 0.874486 is kept in the
 * prose above so the arithmetic that produced 18.58 can still be checked.
 */
export const IONICON_INK_RATIO = {
    add: 0.625,
    send: 0.936807,
} as const;

export interface AgentInputLayoutGeometry {
    shellInset: number;
    actionSize: number;
    addIconSize: number;
}

export interface AgentInputLayout {
    shellInset: number;
    /**
     * Half the difference between a 44pt row button and its 26pt glyph, so 9.
     *
     * This is HOME's number now (DROVE-206). Home still draws the `+` as a
     * 44pt button on its own row, and HomeDock reads it as the collapsed
     * composer's inner padding. The chat's `+` is inside the field and takes
     * `inFieldAddGlyphOffset` instead.
     */
    addGlyphOffset: number;
    /**
     * What the send glyph is drawn at, so that its ink is the `+`'s ink.
     *
     * Clay, with a reference crop: "Shouldn't send look more like this?" The
     * crop is the flat, solid, right-pointing arrowhead Slack and Telegram
     * draw, not the tilted origami plane. Ionicons ships exactly that as
     * `send`, so this costs no asset either.
     *
     * 17.35, down from 18.58 (DROVE-236). It does not get 18.58 because the
     * plane had 18.58; it gets whatever puts the `+`'s 16.25pt of ink in the
     * disc, which for `send` at 0.936807 of the em is 17.35. The mark is
     * SHORTER than the plane's on the page and exactly as heavy in ink, which
     * is the point: `send` is a wide, flat glyph and a wide glyph at the
     * plane's size would have out-drawn the `+` at the other rim.
     *
     * The last survivor of the ink arithmetic, and it survives because it is a
     * SIZE rather than a position. Both glyphs are centred in their disc by the
     * layout engine.
     */
    sendIconSize: number;
    /**
     * THE COMPOSER'S TEXT COLUMN: where the caret starts, and where the status
     * strip under the composer lines its text up (DROVE-223).
     *
     * Still 19, and for the first time it is a column something actually
     * stands in rather than a number that happened to land there (DROVE-214).
     * It is the composer's gutter plus the bubble's own padding, so it is
     * literally the left edge of the bubble's interior: the caret sits on it,
     * and so does the leading edge of the `+`'s disc on the row below. Nothing
     * about the `+`'s glyph enters into it any more.
     *
     * DROVE-206 called 19 "the `+`'s ink column" and it never was; DROVE-214
     * then kept it as a chosen number with no derivation. It has one now, and
     * the arithmetic happens to land on the same 19, so the status strip does
     * not move.
     */
    textInset: number;
    inputContainerPaddingLeft: number;
    inputContainerPaddingRight: number;
}

/**
 * Canonical visual metrics for the compact mobile composer. Home and Chat
 * intentionally render different controls, but their shell, input, and action
 * geometry must stay identical.
 */
export const MOBILE_COMPOSER_METRICS = {
    // Clamped by the renderer to half the card's height, and the chat bubble's
    // floor is 44 (DROVE-196), so what is DRAWN there is a 22pt capsule. The
    // number stays 30 because Home's focused card is 104 tall and really does
    // use it.
    shellRadius: 30,
    // The composer's outer gutter. It used to be the card's own horizontal
    // padding, because the card spanned the dock and everything lived inside
    // it. DROVE-196 moved the `+` and the control row outside the card, so it
    // is now the padding on the composer LINE and on the control row, and the
    // card is what sits between them.
    shellInset: 10,
    /**
     * AgentInput's OUTER gutter, outside everything above (DROVE-223).
     *
     * `shellInset` is the padding on the composer line; this is the padding on
     * the whole component, the one AgentInput's own container carries, and the
     * status strip sits inside it as well. It was never written down anywhere
     * a budget could read it, so `statusRowLayout` measured the strip against
     * the screen and handed the row 16pt a phone does not have. In Clay's
     * photograph the strip's dot starts 27pt from the screen edge: this 8 plus
     * the row's own 19, which is what says the number is real.
     *
     * 12 above 700pt, where the composer is centred in a wide window and the
     * air either side is not a phone's thumb margin.
     */
    shellGutter: 8,
    shellGutterWide: 12,
    // Home's card only (DROVE-196). Its focused composer is still one card
    // holding the field and the control row, so it still needs air at both
    // ends. The chat bubble is the field and nothing else, and it keeps none:
    // the in-field button's own 4pt inset is the only air inside it.
    shellPaddingTop: 8,
    shellPaddingBottom: 8,
    /**
     * THE CHAT BUBBLE'S PADDING, which is the air around everything in it
     * (DROVE-214).
     *
     * Clay: "probably we should put everything in the speech bubble with the
     * buttons on the bottom and the text input one row above it?" So the
     * bubble is two rows, and this is the only air between either of them and
     * the bubble's rim. It is the discs' margin, expressed where Clay asked
     * for it to be expressed: as padding on the container, not as an offset on
     * each control.
     *
     * DERIVED FROM THE CORNER RADIUS, which is the one thing the layout engine
     * genuinely cannot see. Yoga lays out rectangles and knows nothing about
     * `borderRadius`, so a child flush to a rounded corner escapes the drawn
     * shape while every frame in the tree still says it is inside. A square
     * corner clears a radius `r` when it is inset `r - r/sqrt(2)` = 8.79 for
     * our 30, so 9 is the smallest whole point that works.
     *
     * The discs are circles and need less than that, which is why they end up
     * with visible clearance at the corner rather than grazing it. The number
     * is set by the text, which really does have square corners.
     *
     * IT REPLACES `bubblePadding: 0`. Zero was DROVE-196's rule for a bubble
     * that held one row of text with a control jammed into each rounded end,
     * and it is what made both discs look, in Clay's words, like shit: at zero
     * there is no air anywhere, so the only way to place a control was to
     * offset it by hand from a rim.
     */
    bubbleInset: 9,
    /**
     * THE BUBBLE'S BOTTOM PADDING, and it is a different number because it
     * holds a different shape (DROVE-236).
     *
     * Clay, on the composer: "Move the bottom row up." The control row is
     * pinned to the bottom of the dock, so the only thing that can shorten the
     * distance between it and the bubble is the air the bubble keeps under its
     * own button row. There are 15pt of it: 9 of padding inside the rim and
     * `controlGap`'s 6 outside. This takes 5 of the 9.
     *
     * IT IS DERIVED, NOT TASTE. `bubbleInset` is 9 because the TEXT has square
     * corners and a square corner clears a 30pt radius only when it is inset
     * `r - r/sqrt(2)` = 8.79. Nothing square is in the bottom row: it holds two
     * 36pt CIRCLES, and DROVE-214 already wrote down that they "need less than
     * that". How much less is `roundedRectClearance`'s question, and the answer
     * at each padding, for a disc 9 in from the side of a 30pt corner:
     *
     *   9   7.76pt of clearance
     *   6   5.29
     *   4   3.46      <- here
     *   2   1.56      <- under 2, which is what DROVE-214 measured as broken
     *   0  -0.37      escapes the drawn shape
     *
     * The shipped bug Clay photographed measured 0.69, and the arrangement it
     * replaced measured 4.7. So 4 sits above the number that was wrong and
     * below the one that was fine, with the whole margin stated rather than
     * felt. It does not move with the text, because the disc's distance from
     * the bottom corner is this padding at every height.
     *
     * `controlGap` is NOT the number that moved, deliberately. The recording
     * band reads it (`COMPOSER_STRIP_PADDING_TOP`), so spending it would move
     * DROVE-221's band as a side effect, and two glass rims 0pt apart read as
     * one slab, which is DROVE-118's argument against small gaps.
     */
    bubbleInsetBottom: 4,
    /**
     * HOME's field floor. The chat bubble no longer has one: its text row is
     * as tall as the text, because nothing else stands in that row any more.
     *
     * It was 44 for both, sized to hold a 36pt disc inset 4. The disc moved to
     * a row of its own (DROVE-214), so the chat's floor is now the line box
     * (`inputLineHeight + inputPaddingTop + inputPaddingBottom`) and is
     * derived rather than declared. Home's focused card still holds its field
     * and its control row together and still wants this.
     */
    inputMinHeight: 44,
    inputMaxHeight: 120,
    inputFontSize: 16,
    inputLineHeight: 22,
    inputPaddingTop: 4,
    inputPaddingBottom: 4,
    // 44, not 42 (DROVE-153). Clay: "I am expecting the button sizes to be
    // the normal button sizes that you see on a normal app". 42 with 6pt of
    // slop already passed the HIG's 44pt target, and that is not what he was
    // looking at: he was looking at what is DRAWN. Drawn size and target are
    // now the same number, so there is nothing left to argue about.
    actionRowHeight: 44,
    actionSize: 44,
    /**
     * The `+`'s ink, unchanged through every arrangement it has been drawn in.
     *
     * It is centred in a 44pt button on Home's row and in the 36pt in-field
     * disc on chat (DROVE-206). 26 in 36 leaves 5 clear on every side, which
     * is enough that the glyph never touches the rim, so the `+` moved inside
     * without being redrawn: only the offset that centres it changed, 9 to 5.
     * It reads heavier in the smaller disc on purpose. It is the one control
     * inside the field that is an offer rather than a state, and it has to
     * hold its own against a send button at the other rim.
     */
    addIconSize: 26,
    secondaryActionHeight: 40,
    effortWidth: 64,
    /**
     * The disc the `+` and the send button are both drawn at, on the bubble's
     * own bottom row (DROVE-214).
     *
     * Smaller than the row's 44pt buttons on purpose. It is the same bargain
     * DROVE-153 struck: 36 drawn with 6pt of slop is a 48pt target, over the
     * 44pt floor on what the thumb can hit. The row's controls meet that floor
     * by being drawn at 44; these two meet it with slop. Both do, so neither is
     * the exception.
     *
     * WHY A DISC AND NOT A BARE GLYPH, which is the one piece of reasoning
     * worth carrying out of three wrong passes. A disc reads as a button
     * because it nests: it is a shape with its own even clearance inside the
     * shape that holds it, at a corner as well as along an edge. A bare glyph
     * has that at no offset, which is why every attempt to place one by
     * arithmetic looked wrong however exactly the numbers matched. Clay
     * settled it: "the plus to add images and stuff should be a circle just
     * like on the right hand side send button."
     *
     * That is a reason to draw a circle. It is not a number to compute, and
     * every number that used to be computed from it is gone.
     */
    primaryActionSize: 36,
    primaryActionSlop: 6,
    attachmentExtraHeight: 72,
    /**
     * The one air gap between two pieces of composer furniture (DROVE-196):
     * the `+` and the bubble beside it, the bubble and the control row under
     * it, and each control and the next along that row.
     *
     * It was already the row's internal gap, argued for in DROVE-118: at 2 the
     * speaker, the mic and the primary read as one blob once they all carry a
     * surface. Now that the `+` and the row are outside the card, the same
     * number is what stops the bubble and its furniture reading as one slab,
     * so there is one gap in the composer rather than three.
     */
    controlGap: 6,
    /**
     * What the composer keeps clear under itself, above the status strip.
     *
     * This is the card's old `shellPaddingBottom` doing the same job from
     * outside the card. It is load-bearing, not decoration: the status row's
     * segments extend their touch area 14pt above their text
     * (STATUS_ROW_TAP_SLOP_TOP), and `resolveComposerButtonFloor` is what says
     * they stop before they are drawing over a control. Take this to 0 and the
     * segments reach 8pt into the composer's buttons.
     *
     * IT MOVED FROM THE CONTROL ROW TO THE COMPOSER LINE (DROVE-236) and did
     * not change value. The row it used to hang off is gone; the line that
     * holds the bubble carries it now, so the strip's 8pt of clear air is
     * unchanged and the tap floor is where it was. What DID change is that the
     * lowest control gained 4pt: the row's 44pt buttons filled the row down to
     * its rim, and the bubble's discs stop `bubbleInsetBottom` short of the
     * bubble's. So the strip's tap band now stops 4pt below the nearest
     * button instead of exactly at it.
     */
    controlsBottomGap: 8,
} as const;

/**
 * ONE LINE OF TEXT, which is the floor of the bubble's text row (DROVE-214).
 *
 * The row is as tall as the text and nothing else, because nothing else stands
 * in it any more. It replaces `inputMinHeight`'s 44 for the chat, and that 44
 * was never about text: it was the height a 36pt disc inset 4 needed.
 */
export const MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT = MOBILE_COMPOSER_METRICS.inputLineHeight
    + MOBILE_COMPOSER_METRICS.inputPaddingTop
    + MOBILE_COMPOSER_METRICS.inputPaddingBottom;

/**
 * The bubble's bottom row: the `+`, the session controls, the audio button and
 * send, and exactly as tall as they are drawn (DROVE-214, DROVE-236).
 *
 * A row sized to its buttons is what makes the discs' margin the bubble's
 * padding rather than a per-control offset. The touch target is the drawn disc
 * plus `primaryActionSlop`, which does not take space.
 *
 * IT DOES NOT GROW FOR THE THREE CONTROLS THAT JOINED IT (DROVE-236). They
 * were drawn at 44 on a row of their own; in here they are drawn at 36, the
 * size the row already is. That is the whole reason the bubble's height did
 * not move: 85 before the move and 85 after it, with a row that holds five
 * things instead of two.
 */
export const MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT = MOBILE_COMPOSER_METRICS.primaryActionSize;

/**
 * What a session control is drawn at INSIDE the bubble (DROVE-236).
 *
 * 36, the row's own size, not `COMPOSER_SESSION_CONTROL_SIZE`'s 44. The
 * permission glyph, the effort gauge, the model's segment and the audio button
 * are all this tall, so the row is one family of objects rather than a 44pt
 * capsule wedged between two 36pt discs.
 *
 * IT COSTS A TOUCH TARGET AND THAT IS THE TRADE, stated rather than buried.
 * The two glyph segments are 36 WIDE as well as 36 tall, and they sit against
 * each other inside one capsule, so horizontal slop is not available to them:
 * a segment that claimed 6pt to its right would be claiming its neighbour's
 * ink. Vertically they take `primaryActionSlop` like every other control on
 * the row, so each answers a touch in a 36 x 48 box. That is under Apple's
 * 44pt floor on ONE axis.
 *
 * The alternative was to keep them at 44 wide, and it is not affordable: the
 * arithmetic is in `sessionPillLabel.ts`, and 44pt segments leave 66pt for the
 * model's name at 320, which is under what `Opus 5` needs at any legible type
 * size. So the choice is a 36pt-wide segment or no model name, and DROVE-138
 * was filed about losing the model name.
 */
export const MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE = MOBILE_COMPOSER_METRICS.primaryActionSize;

/**
 * The chat bubble, empty: padding, one line of text, the gap, the button row,
 * padding (DROVE-214).
 *
 * 85, up from 44, AND THE COMPOSER GETS 41PT TALLER. That is the cost of the
 * arrangement Clay asked for and it is worth stating plainly rather than
 * burying: "probably we should put everything in the speech bubble with the
 * buttons on the bottom and the text input one row above it?" A button row
 * inside the bubble is 36 tall and needs air round it, and the transcript pays
 * for it.
 *
 * What it buys is that nothing in the composer is placed against anything that
 * grows. The text row grows with the text; the button row does not, because it
 * holds no text. Three passes of arithmetic existed only to keep a disc
 * centred in a row whose height nobody knew, and that question no longer has a
 * subject.
 *
 * NOTHING LAYS OUT FROM THIS NUMBER. It is a model of what the styles produce,
 * checked against them in `composerBubbleLayout.spec.ts` by resolving the real
 * style objects rather than by restating the arithmetic here. That distinction
 * is the whole reason three green suites shipped a broken composer: the model
 * agreed with itself while the renderer did something else.
 */
export const MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT = MOBILE_COMPOSER_METRICS.bubbleInset
    + MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT
    + MOBILE_COMPOSER_METRICS.controlGap
    + MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT
    + MOBILE_COMPOSER_METRICS.bubbleInsetBottom;

/**
 * The whole chat composer block, empty: the bubble, and the gap it keeps over
 * the status strip.
 *
 * 93, down from 143. DROVE-214 made it 148 by giving the buttons a row of
 * their own inside the bubble, DROVE-236 took 5 back off the bubble's floor,
 * and this takes the whole control row away: it is INSIDE the bubble now, on
 * the row the buttons already had. The terms, ticket by ticket:
 *
 *   DROVE-153   8 + 44 + 44 + 8      card padding, field, row, card padding
 *   DROVE-196       44 + 6 + 44 + 8  bubble, gap, row, gap over the strip
 *   DROVE-214       90 + 6 + 44 + 8  the bubble grew a button row
 *   DROVE-236a      85 + 6 + 44 + 8  and gave 5 of its floor back
 *   DROVE-236b      85         +  8  the row moved into that button row
 *
 * Clay, with the composer marked up in red: "Dude didn't I tell you to do this
 * already?" He did. The first pass moved the row NEARER the bubble; his
 * annotation draws it INTO the bubble, with an arrow from the session capsule
 * up into the empty middle beside the `+` and another from the audio button up
 * to sit beside the mic at the right rim. So there is one bubble and nothing
 * under it, and the 50pt the row and its gap were costing go to the transcript.
 *
 * THE BUBBLE DID NOT GROW TO TAKE THEM. Its button row is 36 tall and the
 * three controls that joined it are drawn at 36 rather than the 44 they wore
 * outside (`MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE`), so 85 is 85. What the move
 * costs is width, not height, and the whole of that cost is the model name's
 * budget: `composerModelBudget` in sessionPillLabel.ts, 33pt narrower at every
 * screen width, with the give-way order and the three phones written out
 * there.
 *
 * WHAT THE MOVE DOES DOWNSTREAM, because four other lanes hang off this
 * number and only one of them needs a line changing:
 *
 *   the bottom fade      `resolveTranscriptBottomScrim` hangs off the dock's
 *                        MEASURED height (DROVE-219), an `onLayout` on the
 *                        dock rather than this constant, so it is 50pt shorter and
 *                        its top edge 50pt lower with nothing edited, and it
 *                        stays exactly equal to `resolveDockInset` because it
 *                        calls it. The one thing that would have broken it is
 *                        moving a control OUT of the measured box, and nothing
 *                        moved out: the row moved further in.
 *   the transcript mask  same measured height. Its clear band is derived from
 *                        `safeAreaBottom` alone and does not move at all.
 *   the recording band   20pt, `STATUS_ROW_ROW_HEIGHT` (DROVE-221), and its
 *                        padding is `controlGap`. Neither is touched. Its
 *                        left and right are `shellInset`, which the composer
 *                        LINE still carries, so the band is still exactly as
 *                        wide as the bubble over it. That is the one spec
 *                        line that had to re-point, from the control row's
 *                        gutter to the line's, at the same 10.
 *   the status strip     reads `textInset` (19) and `shellGutter` (8) and
 *                        neither moved, so DROVE-231's zones and give-way
 *                        order are untouched. `resolveComposerButtonFloor`
 *                        still answers 44 and the strip's tap slop still
 *                        stops there; the nearest button is now 4pt above it
 *                        rather than on it, because the bubble's discs stop
 *                        `bubbleInsetBottom` short of its rim.
 *
 * The transcript gets the 50.
 */
export const MOBILE_COMPOSER_BASE_HEIGHT = MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT
    + MOBILE_COMPOSER_METRICS.controlsBottomGap;

export const MOBILE_COMPOSER_CHROME_HEIGHT = MOBILE_COMPOSER_BASE_HEIGHT
    - MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT;

/**
 * The chat composer block: the bubble, and the furniture under it.
 *
 * The TEXT ROW is the only thing in the whole composer that grows. The button
 * row inside the bubble, the control row under it and every gap are fixed,
 * which is what took the centring problem out of the composer rather than
 * solving it (DROVE-214).
 *
 * `inputHeight` is the TEXT's own measured height, the number a multiline
 * TextInput reports, so an empty composer passes `inputLineHeight`. The row's
 * padding is added here rather than by the caller, which is a change from
 * DROVE-206: it used to be added at both ends and the two conventions were
 * never reconciled because nothing laid out from either.
 */
export function resolveMobileComposerHeight(inputHeight: number, hasAttachments = false): number {
    return MOBILE_COMPOSER_CHROME_HEIGHT
        + resolveMobileComposerBubbleHeight(inputHeight, hasAttachments);
}

/** How tall the chat bubble is: its two rows, its padding and any attachments. */
export function resolveMobileComposerBubbleHeight(
    inputHeight: number,
    hasAttachments = false,
): number {
    return MOBILE_COMPOSER_METRICS.bubbleInset
        + MOBILE_COMPOSER_METRICS.bubbleInsetBottom
        + resolveMobileComposerTextRowHeight(inputHeight)
        + MOBILE_COMPOSER_METRICS.controlGap
        + MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT
        // The strip is a third row in the same column, so it costs the gap as
        // well as its own height. Counted here because the bubble's `gap` is
        // what actually draws it (DROVE-214).
        + (hasAttachments
            ? MOBILE_COMPOSER_METRICS.attachmentExtraHeight + MOBILE_COMPOSER_METRICS.controlGap
            : 0);
}

/**
 * The text row: the text's own box, a floor of one line and a ceiling of
 * `inputMaxHeight`.
 *
 * The ceiling is new here and it is not decoration (DROVE-214). The style
 * carries a `maxHeight` and the model did not, so a long message made the two
 * disagree by hundreds of points and nothing noticed, because nothing lays out
 * from the model. `composerBubbleLayout.spec.ts` resolves the styles and
 * compares, which is what caught it.
 */
export function resolveMobileComposerTextRowHeight(inputHeight: number): number {
    const padding = MOBILE_COMPOSER_METRICS.inputPaddingTop
        + MOBILE_COMPOSER_METRICS.inputPaddingBottom;
    return Math.min(
        MOBILE_COMPOSER_METRICS.inputMaxHeight + padding,
        Math.max(MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT, inputHeight + padding),
    );
}

/**
 * Home's field, which is still one row with a 44pt floor.
 *
 * Split from the chat's bubble in DROVE-214. They shared one function while
 * they were the same shape; the chat's bubble is two rows now and Home's card
 * is not, so sharing would have silently resized Home.
 */
export function resolveMobileHomeFieldHeight(
    inputHeight: number,
    hasAttachments = false,
): number {
    return Math.max(
        MOBILE_COMPOSER_METRICS.inputMinHeight,
        inputHeight
            + MOBILE_COMPOSER_METRICS.inputPaddingTop
            + MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    ) + (hasAttachments ? MOBILE_COMPOSER_METRICS.attachmentExtraHeight : 0);
}

/**
 * Home's focused composer, which is still ONE card holding the field and the
 * control row (DROVE-196).
 *
 * Home is not the screen Clay photographed and its dock has no status strip
 * under it, so there is nothing there for the row to be furniture in front of.
 * It keeps DROVE-153's arithmetic to the point: padding, field, row, padding.
 * This exists so that the chat's block height can change without silently
 * resizing Home, which is what would have happened while both read one
 * constant.
 */
export const MOBILE_HOME_COMPOSER_BASE_HEIGHT = MOBILE_COMPOSER_METRICS.shellPaddingTop
    + MOBILE_COMPOSER_METRICS.inputMinHeight
    + MOBILE_COMPOSER_METRICS.actionRowHeight
    + MOBILE_COMPOSER_METRICS.shellPaddingBottom;

export const MOBILE_HOME_COMPOSER_CHROME_HEIGHT = MOBILE_HOME_COMPOSER_BASE_HEIGHT
    - MOBILE_COMPOSER_METRICS.inputMinHeight;

export function resolveMobileHomeComposerHeight(
    inputHeight: number,
    hasAttachments = false,
): number {
    return MOBILE_HOME_COMPOSER_CHROME_HEIGHT
        + resolveMobileHomeFieldHeight(inputHeight, hasAttachments);
}

export type MobileComposerMenuVariant = 'icon' | 'model' | 'effort' | 'permission';

export interface MobileComposerGeometryStyle {
    width?: number | '100%';
    height?: number | '100%';
    minWidth?: number;
    flex?: number;
    flexShrink?: number;
    flexDirection?: 'row';
    alignItems?: 'center' | 'flex-end';
    justifyContent?: 'center' | 'flex-start' | 'flex-end';
    borderRadius?: number;
    paddingLeft?: number;
    paddingRight?: number;
    paddingHorizontal?: number;
    gap?: number;
    marginLeft?: number;
    marginRight?: number;
    marginTop?: number;
    marginBottom?: number;
}

export interface MobileComposerMenuGeometry {
    frame: MobileComposerGeometryStyle;
    content: MobileComposerGeometryStyle;
}

export interface MobileCollapsedComposerGeometry {
    shellHeight: number;
    shellRadius: number;
    contentPaddingLeft: number;
    contentPaddingRight: number;
    inputPaddingLeft: number;
    inputPaddingRight: number;
    textInset: number;
}

/**
 * Places collapsed-composer text at the tangent where the capsule's rounded
 * end meets its straight edge, rather than halfway through the rounded end.
 */
export function resolveMobileCollapsedComposerGeometry(
    shellHeight = 56,
    contentPaddingHorizontal = 7,
    inputPaddingRight = 4,
): MobileCollapsedComposerGeometry {
    const shellRadius = shellHeight / 2;
    const inputPaddingLeft = shellRadius - contentPaddingHorizontal;

    return {
        shellHeight,
        shellRadius,
        contentPaddingLeft: contentPaddingHorizontal,
        contentPaddingRight: contentPaddingHorizontal,
        inputPaddingLeft,
        inputPaddingRight,
        textInset: contentPaddingHorizontal + inputPaddingLeft,
    };
}

/**
 * Keeps the Expo native-menu host frame free of visual padding. Padding and
 * alignment belong exclusively to the visible React Native label inside it.
 */
export function resolveMobileComposerMenuGeometry(
    variant: MobileComposerMenuVariant,
): MobileComposerMenuGeometry {
    if (variant === 'icon') {
        return {
            frame: {
                width: MOBILE_COMPOSER_METRICS.actionSize,
                height: MOBILE_COMPOSER_METRICS.actionSize,
                flexShrink: 0,
            },
            content: {
                width: '100%',
                height: '100%',
                alignItems: 'center',
                justifyContent: 'center',
            },
        };
    }

    // The permission chip anchors the left of the row next to the add button,
    // so it sizes to its own label and never shrinks: it is always one word,
    // and a clipped permission is worse than a clipped model name.
    if (variant === 'permission') {
        return {
            frame: {
                flexShrink: 0,
                height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
            },
            content: {
                height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
                borderRadius: MOBILE_COMPOSER_METRICS.secondaryActionHeight / 2,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: 10,
            },
        };
    }

    // The pair is right-aligned against the send button, so each chip keeps its
    // slack on the outside of the separator: the model's padding sits to its
    // left, the effort's to its right. Only the model shrinks, and the effort
    // reserves the widest label's width so switching levels never reflows the
    // row or clips the text.
    if (variant === 'model') {
        return {
            frame: {
                flexShrink: 1,
                minWidth: 0,
                height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
            },
            content: {
                minWidth: 0,
                height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
                borderRadius: MOBILE_COMPOSER_METRICS.secondaryActionHeight / 2,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'flex-end',
                paddingLeft: 12,
                paddingRight: 4,
                gap: 7,
            },
        };
    }

    return {
        frame: {
            flexShrink: 0,
            minWidth: MOBILE_COMPOSER_METRICS.effortWidth,
            height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
        },
        content: {
            minWidth: 0,
            height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
            borderRadius: MOBILE_COMPOSER_METRICS.secondaryActionHeight / 2,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            paddingLeft: 4,
            paddingRight: 12,
            gap: 4,
        },
    };
}

export function resolveMobileComposerActionRowGeometry(): MobileComposerGeometryStyle {
    return {
        height: MOBILE_COMPOSER_METRICS.actionRowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        // Three filled circles need air between them (DROVE-118). At 2 the
        // speaker, the mic and the primary read as one blob once they all
        // carry a surface.
        gap: MOBILE_COMPOSER_METRICS.controlGap,
        // No gutter of its own: this is the row as HOME draws it, inside a card
        // that already supplies one. The chat has no row of this kind any
        // more: its controls are on the bubble's own button row (DROVE-236).
        paddingHorizontal: 0,
    };
}

/**
 * The composer's first line, which is the bubble and nothing else.
 *
 * DROVE-196 put the `+` out here beside the field, because that is where
 * Messages draws it. Clay said the opposite: "the boss should not be in the
 * message box but the plus should be." So the `+` went inside; since DROVE-214
 * it is on a row of the bubble's own, along with send.
 *
 * This line stays a row rather than collapsing into the bubble's own style
 * because it carries the composer's GUTTER, which is what lets the recording
 * banner be exactly as wide as the composer above it (DROVE-157). It used to
 * be the control row that the banner's width was checked against; the row is
 * gone and this line is the only thing left carrying `shellInset`, so it is
 * what the banner is measured to now (DROVE-236).
 *
 * AND IT CARRIES THE GAP OVER THE STATUS STRIP (DROVE-236). That 8 was the
 * control row's `marginBottom`; the row is gone, the gap is not, so it hangs
 * off the last thing above the strip. Same number, same job: it is what stops
 * the strip's 14pt of upward tap slop reaching the composer's buttons.
 */
export function resolveMobileComposerLineGeometry(): MobileComposerGeometryStyle {
    return {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: MOBILE_COMPOSER_METRICS.shellInset,
        marginBottom: MOBILE_COMPOSER_METRICS.controlsBottomGap,
    };
}

/*
 * `resolveMobileComposerControlRowGeometry` stood here and is gone
 * (DROVE-236).
 *
 * DROVE-196 wrote it for Clay's "the second row buttons should sit outside the
 * speech bubble", and it was right for the bubble that existed then: one row
 * of text with a control jammed into each rounded end, and no room in it for
 * anything that was not the message. DROVE-214 gave the bubble a button row of
 * its own, and that is the room. Clay's markup draws the arrow: the session
 * capsule and the audio button go UP into that row, beside the `+`.
 *
 * So there is no row outside the bubble to give a geometry to. What the
 * function carried is not lost, it is redistributed by the layout engine
 * rather than by a style object:
 *
 *   paddingHorizontal   was the row's own gutter; the composer LINE already
 *                       carries the same `shellInset` for the bubble.
 *   marginTop           was `controlGap` between the row and the bubble; the
 *                       controls are in the bubble, so there is nothing to
 *                       gap from.
 *   marginBottom        was `controlsBottomGap` over the status strip; it is
 *                       on `resolveMobileComposerLineGeometry` now, unchanged.
 *
 * `resolveMobileComposerActionRowGeometry` stays. That is HOME's row, which
 * still holds its controls in a card of its own and is untouched by any of
 * this.
 */

/*
 * `MOBILE_COMPOSER_EFFORT_READOUT_GAP` and
 * `resolveMobileComposerEffortLayerGeometry` stood here and are gone
 * (DROVE-242). They placed the effort drag's readout: a full-width layer above
 * the control row, which DROVE-229 wrote to stop the popover anchoring itself
 * to the finger. The drag is deleted, so there is nothing left to place. The
 * placement RULE it stated survives in ComposerSheet, which is where every
 * composer picker is drawn now.
 */

/**
 * A composer control's disc.
 *
 * `icon` is a control on HOME's row, drawn at the full 44. `add`, `audio` and
 * `primary` are the three on the chat bubble's own bottom row, all 36, and
 * since DROVE-214 they are the SAME OBJECT: identical style, no margins, no
 * mirrored offsets. The row places them, not they themselves.
 *
 * `audio` joined them in DROVE-236, coming off the control row where it was
 * drawn at 44 inside a shared capsule. It is a disc now because it stands
 * beside two discs: Clay's arrow puts it next to the mic at the bubble's right
 * rim, and a 44pt capsule between two 36pt circles would have been the one
 * object on the row that did not belong to it.
 *
 * `mic` came BACK in DROVE-264, which un-collapsed it from the primary. It is
 * the same object as the rest and at the same size, and that is the decision
 * rather than the default: at rest it draws no circle at all (DROVE-254), so
 * its ink is about 18pt and a narrower box would hand the model's name back
 * some of what this ticket costs it. It keeps 36 because the moment the mic is
 * OPEN it draws a full disc, and a disc narrower than the `+`'s would be a
 * second size of circle on a row DROVE-214 gave one. The same holds for
 * `primary`, which draws a disc for Stop and for the gate's lock.
 *
 * All of them centre their glyph with `alignItems`/`justifyContent`, which is
 * all a glyph in a disc ever needed. The variants remain distinct only so a
 * caller reads which one it is drawing.
 */
export function resolveMobileComposerActionGeometry(
    variant: 'icon' | 'primary' | 'add' | 'audio' | 'mic',
): MobileComposerGeometryStyle {
    const inBubble = variant !== 'icon';
    const size = inBubble
        ? MOBILE_COMPOSER_METRICS.primaryActionSize
        : MOBILE_COMPOSER_METRICS.actionSize;
    return {
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    };
}

/** Resolves compact mobile composer geometry from the leading add glyph. */
export function resolveAgentInputLayout({
    shellInset,
    actionSize,
    addIconSize,
}: AgentInputLayoutGeometry): AgentInputLayout {
    // Home's `+`, still a 44pt button on a row.
    const addGlyphOffset = (actionSize - addIconSize) / 2;
    return {
        shellInset,
        addGlyphOffset,
        // The send glyph carries the `+`'s ink, not the `+`'s point size
        // (DROVE-214, DROVE-236). `send` fills more of its em than a plus
        // does, so matching the number would have drawn a heavier mark than
        // the one at the other end of the row.
        sendIconSize: addIconSize * IONICON_INK_RATIO.add / IONICON_INK_RATIO.send,
        // The bubble's interior edge: the composer's gutter plus the bubble's
        // own padding, and therefore literally where the caret starts and
        // where the `+`'s disc begins on the row below (DROVE-214).
        textInset: shellInset + MOBILE_COMPOSER_METRICS.bubbleInset,
        inputContainerPaddingLeft: addGlyphOffset,
        inputContainerPaddingRight: addGlyphOffset,
    };
}

export const MOBILE_COMPOSER_LAYOUT = resolveAgentInputLayout({
    shellInset: MOBILE_COMPOSER_METRICS.shellInset,
    actionSize: MOBILE_COMPOSER_METRICS.actionSize,
    addIconSize: MOBILE_COMPOSER_METRICS.addIconSize,
});

/**
 * How wide the text is, at a screen width.
 *
 * DROVE-206 PINNED THIS AND DROVE-214 DELETES THE REASON IT WAS PINNED. The
 * constraint was that the caret must not move between an empty composer and a
 * typed one, which mattered because the `+` and the send button stood in the
 * text's own row: whether each was drawn changed where the text could start
 * and stop, so the width had to be reserved unconditionally and written down.
 *
 * Nothing stands beside the text now. Its row is the full interior of the
 * bubble at every state, including zen mode, which used to be the one case
 * that took a different leading padding. So the caret cannot move, and the
 * width is simply what is left after the gutter and the bubble's padding:
 * emergent, not reserved.
 *
 * The pinned 208 / 263 / 281 at 320 / 375 / 393 are gone with it, and the text
 * gains 74pt at every width. This function stays only because the placeholder
 * budget and the tests want the number; nothing lays out from it.
 */
export function resolveComposerTextWidth(screenWidth: number): number {
    return screenWidth
        - MOBILE_COMPOSER_METRICS.shellInset * 2
        - MOBILE_COMPOSER_METRICS.bubbleInset * 2;
}
