/**
 * How much of its own em box an Ionicons glyph's OUTLINE actually fills,
 * measured off `Ionicons.ttf` (unitsPerEm 512) rather than guessed.
 *
 * This is the metric DROVE-214 turned on. An icon font's glyph is drawn inside
 * an em box that is mostly empty, and both in-field controls are placed by
 * their box. That is right for the send button, whose box IS its ink because
 * the disc is filled, and wrong for the `+`, whose box is transparent: 26pt of
 * `add` is 16.25pt of ink with 4.875 of nothing on each side, so a box placed
 * 4 off the rim puts INK 13.875 off it.
 *
 *   add          outline spans x 96..416 of 512, so 0.625 of the em
 *   paper-plane  outline spans x 32.26..480 of 512, so 0.874486
 *
 * Both glyphs are vertically centred by the font's own metrics and need no
 * correction: `add`'s ink centre sits 0.3749em over the baseline and
 * `paper-plane`'s 0.3745, against a line box centred at (454-71)/2/512 =
 * 0.374em. Under a hundredth of a point either way at these sizes.
 */
export const IONICON_INK_RATIO = {
    add: 0.625,
    paperPlane: 0.874486,
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
     * Half the difference between the 36pt in-field disc and the same 26pt
     * glyph, so 5 (DROVE-206). What the chat's `+` needed to be CENTRED in the
     * disc it is drawn in.
     *
     * And centring is right, for a reason DROVE-206 never wrote down and
     * DROVE-214 briefly talked itself out of: the disc is 36 inset 4 in a 44pt
     * field, so its centre sits on the centre of the capsule's rounded end.
     * Centring the glyph in the disc centres it in that END, and the disc is
     * drawn now, so this is the same offset the send glyph takes at the other
     * rim. See `capsuleEndRadius`.
     */
    inFieldAddGlyphOffset: number;
    /**
     * How far the `+`'s ink sits inside its own 26pt em box: 4.875 a side,
     * because Ionicons `add` fills 0.625 of the em (DROVE-214).
     *
     * It does NOT place the glyph. DROVE-214's first pass used it to pull the
     * em box out until the ink started 4 from the rim, matching the disc's,
     * and that is the version Clay called "still wrong". It survives because
     * it is what `addInkSize` and `addInkInset` are measured with, and it is
     * what sizes the paper plane to the same ink at the other rim.
     */
    addGlyphInkInset: number;
    /**
     * The `+`'s ink, 16.25pt of it: 26pt of `add` at 0.625 of the em.
     *
     * The send glyph is sized to match it, which is what makes the two ends of
     * the field carry the same weight of ink rather than the same font size.
     */
    addInkSize: number;
    /**
     * Rim to a GLYPH's ink inside its disc: 13.875, which is
     * `capsuleEndRadius` minus half the ink (DROVE-214).
     *
     * THE SAME NUMBER AT BOTH RIMS, which is what the ticket asked for and
     * only became true once both ends were discs. The `+` is 16.25pt of ink
     * centred in a 36pt disc inset 4; the paper plane is sized to the same
     * 16.25pt of ink in the identical disc at the other rim. So rim to disc is
     * 4 at each end and rim to ink is 13.875 at each end, and neither is a
     * number anything was nudged toward: they fall out of the two ends being
     * the same object.
     */
    addInkInset: number;
    /**
     * What the send glyph is drawn at, so that its ink is the `+`'s ink.
     *
     * Clay: "the send button should actually be a send button", and a paper
     * plane reads lighter than an arrow at the same point size. It does not
     * get 16 because the arrow had 16; it gets whatever puts 16.25pt of ink in
     * the disc, which for `paper-plane` at 0.874486 of the em is 18.58
     * (DROVE-214). The arrow it replaces carried 9.97 x 10.75 of ink, so this
     * is a bigger mark as well as a different one.
     */
    sendIconSize: number;
    /**
     * THE COMPOSER'S GLYPH COLUMN: 19pt from the screen edge, where the status
     * row under the composer lines its text up and where the caret starts when
     * there is no `+` to draw (zen mode, or a session that takes no context).
     *
     * It is 10 shell inset + 4 rim inset + 5 glyph offset, and DROVE-206 wrote
     * that this is "the `+`'s ink column". IT NEVER WAS (DROVE-214). 19 is
     * where the `+`'s transparent EM BOX started; its ink started 4.875
     * further in, at 23.875, and since DROVE-214 aligns the glyph by its ink
     * the ink column is 10 + 4 = 14.
     *
     * 19 stays anyway, and deliberately. It is a column that two things share,
     * the status strip and the zen caret, and rebasing it on the ink would
     * move both for a reason nobody asked for. What it is not is a number
     * derived from where the `+` is drawn, so it is written down here as the
     * chosen column it has always actually been.
     */
    textInset: number;
    inputContainerPaddingLeft: number;
    inputContainerPaddingRight: number;
    /**
     * What the text leaves clear on the LEADING side for the in-field `+`
     * (DROVE-206): the disc's inset from the capsule edge, the disc, and air
     * between it and the first character.
     *
     * Clay: "the plus should be [in the message box]". It was outside on the
     * field's line (DROVE-196); inside, it costs the field 46 instead of the
     * 69 it cost the LINE out there (44 button + 6 gap + 19 inset), so the
     * text gains 23pt at every width even though it now shares its box.
     *
     * Deliberately the same expression as the trailing padding, off the same
     * three metrics, so the field is symmetric by construction: a control at
     * each rim, 4 off the rim, 6 off the text.
     */
    inputLeadingActionPadding: number;
    /**
     * What the text leaves clear on the trailing side for the in-field send
     * button (DROVE-153): the button's inset from the capsule edge, the
     * button, and air between it and the last character.
     *
     * Measured from the bubble's trailing rim since DROVE-196. The card used
     * to add its own 10pt gutter under this, so the text stopped 56 short of
     * the rim for a button that ended at 46; the gutter moved outside the card
     * and the number is now literally what it says.
     *
     * It is reserved unconditionally, because the send button is always drawn
     * (DROVE-206). That is what makes the text's width a constant per screen
     * width rather than something that changes as you type.
     */
    inputTrailingActionPadding: number;
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
     * THE CHAT BUBBLE'S OWN PADDING, WHICH IS ZERO, AND IS NOW ACTUALLY ZERO
     * (DROVE-196, enforced in DROVE-214).
     *
     * DROVE-196 said "NO PADDING, and that is the ticket" and DROVE-206 built
     * every in-field number on it. The style that said it only overrode the
     * panel's colour and radius, so the desktop panel's `paddingHorizontal: 8`
     * / `paddingVertical: 2` / `paddingBottom: 8` went on shipping under it.
     *
     * That one leak is what Clay photographed. It cost the field 8pt at each
     * rim, so the `+` and the send button were both 8 further in than the spec
     * said and the pinned text widths were 16 wider than the text really got;
     * and 2 over 8 vertically is not centred, so the field sat 3pt above the
     * capsule's middle and took both glyphs up with it. The bubble drew 54
     * tall against a `MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT` of 44.
     *
     * It is a metric rather than a literal 0 in the stylesheet so the spec can
     * hold it: a padding that reappears here fails a test instead of quietly
     * moving every number DROVE-206 pinned.
     */
    bubblePadding: 0,
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
     * The disc every IN-FIELD control is drawn at: the send button at the
     * trailing rim, and since DROVE-206 the `+` at the leading one.
     *
     * Clay's Messages reference is one capsule field with the primary
     * affordance inside it at the trailing edge, and DROVE-153 did that half.
     * DROVE-206 does the other: "the plus should be [in the message box]", so
     * the field holds a control at each rim and they are the same disc.
     *
     * Smaller than the row's buttons on purpose: nested in a 44pt-tall field,
     * a 44pt disc would touch both edges. 36 drawn with 6pt of slop is a 48pt
     * target, which clears DROVE-153's 44pt FLOOR. The floor is a
     * floor on what the thumb can hit, and the row's buttons meet it by being drawn at
     * 44 while these two meet it with slop. Both in-field controls take the
     * slop, so neither is the exception.
     */
    primaryActionSize: 36,
    primaryActionSlop: 6,
    /**
     * Air between the text and an in-field control, at either rim: the send
     * button's `marginLeft` and the `+`'s `marginRight` are this one number
     * (DROVE-206).
     */
    primaryActionMarginLeft: 6,
    /**
     * THE PILL'S ROUNDED END: half the field's height, so 22, and the number
     * both in-field controls are placed by (DROVE-214).
     *
     * A 44pt capsule ends in a semicircle of radius 22 centred 22 in from the
     * rim. `primaryActionInset` is a CONSEQUENCE of that and not a chosen 4:
     * a 36pt disc whose centre is on the end's centre is inset
     * `capsuleEndRadius - primaryActionSize / 2` from the rim. CONCENTRIC, so
     * its clearance is 4 the whole way round the arc rather than 4 at one
     * point, and that is the whole reason a disc looks deliberate at a rounded
     * end while a bare glyph never quite does.
     *
     * Clay settled the composer on that property without naming it: "the plus
     * to add images and stuff should be a circle just like on the right hand
     * side send button." Both ends are the same disc now, so both have it.
     */
    capsuleEndRadius: 22,
    /**
     * Keeps an in-field disc off the capsule's rounded end. Derived, not
     * chosen: `capsuleEndRadius - primaryActionSize / 2` (DROVE-214).
     *
     * IT APPLIES TO BOTH ENDS BECAUSE BOTH ENDS ARE DISCS. Getting there took
     * two wrong rules and they are worth keeping, because each one looked
     * right in numbers.
     *
     * First: make rim-to-ink equal, and pull the `+` out until its ink also
     * started 4 from the rim. Clay: "is still wrong it looks like shit".
     * Measured off that build, rim to ink was 3.9 and the tightest clearance
     * anywhere on the glyph 3.999, against the disc's 4.000. Ionicons `add`
     * tapers its arm tips to half a point, so the cross's tightest point IS
     * its centreline and nothing sat closer. THE NUMBERS MATCHED EXACTLY AND
     * IT LOOKED WORSE, which is what says the quantity was wrong.
     *
     * Second: centre the ink on the end's centre, 13.875 in, and let the
     * clearances differ. Better, and for the right reason, but still an
     * approximation of a property the disc simply has: a cross centred in a
     * circle is only radially even at four arm tips, and it is transparent
     * everywhere else, so the end still reads as mostly empty.
     *
     * The disc ends the argument. Same circle, same inset, same centre, and
     * the clearance is even round the entire arc at both rims rather than at
     * a handful of points.
     */
    primaryActionInset: 4,
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
     * What the control row keeps clear under itself, above the status strip.
     *
     * This is the card's old `shellPaddingBottom` doing the same job from
     * outside the card. It is load-bearing, not decoration: the status row's
     * segments extend their touch area 14pt above their text
     * (STATUS_ROW_TAP_SLOP_TOP), and `resolveComposerButtonFloor` is what says
     * they stop before they are drawing over a control. Take this to 0 and the
     * segments reach 8pt into the mode and mic buttons.
     */
    controlsBottomGap: 8,
} as const;

/**
 * The chat bubble alone, empty: the field's own floor and nothing else
 * (DROVE-196).
 *
 * Clay: "the second row buttons should sit outside the speech bubble." So the
 * card is the message he is writing, and the field's 44pt floor is the card's
 * height. That floor is already derived from what the card holds:
 * `inputMinHeight === primaryActionSize + primaryActionInset * 2`, the in-field
 * send button inset 4 at each end. With the card's own padding gone that
 * derivation is finally literal, and the button is inset 4 from the bubble's
 * rim on every side.
 */
export const MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT = MOBILE_COMPOSER_METRICS.bubblePadding * 2
    + MOBILE_COMPOSER_METRICS.inputMinHeight;

/**
 * The whole chat composer block, empty: bubble, gap, control row, and the gap
 * the row keeps over the status strip.
 *
 * 102, AND THAT IS A DELIBERATE CHANGE FROM DROVE-106's 104. DROVE-153 pinned
 * 104 and wrote "104, not 102: the row's buttons are drawn at 44 rather than
 * 42". The buttons are still 44. What moved is everything around them:
 *
 *   was  8 + 44 + 44 + 8    card padding, field, row, card padding
 *   now      44 + 6 + 44 + 8    bubble, gap, row, gap over the strip
 *
 * The card's 16pt of padding is gone because the card no longer holds the row;
 * 6 of it comes back as the gap between the bubble and the row, and 8 as the
 * gap under the row, which is the same inert band the card's bottom padding
 * used to be (`resolveComposerButtonFloor` still reads 44 from the screen
 * edge). Net 2pt shorter, and landing back on DROVE-153's rejected number is a
 * coincidence of arithmetic, not a revert.
 *
 * DROVE-106's claim survives intact and gets tighter: the empty composer is
 * one line, and the bubble around that line is now exactly the line.
 *
 * DROVE-206 rearranged everything inside those four numbers and did not move
 * one of them, which was checked rather than assumed. The `+` came off the
 * line and into the field, where it is a 36pt disc inset 4 in a 44pt box, so
 * the bubble's floor is what it was; the line it left was 44 tall because the
 * `+` and the bubble were both 44, and it is 44 now because the bubble is.
 * The waveform went the other way, onto the control row, which was already
 * 44 and holds a fourth 44pt control at the same height. So 102 STANDS, and
 * it stands deliberately: an arrangement that changed at both ends of the
 * field and on the row under it costs the transcript nothing.
 */
export const MOBILE_COMPOSER_BASE_HEIGHT = MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT
    + MOBILE_COMPOSER_METRICS.controlGap
    + MOBILE_COMPOSER_METRICS.actionRowHeight
    + MOBILE_COMPOSER_METRICS.controlsBottomGap;

export const MOBILE_COMPOSER_CHROME_HEIGHT = MOBILE_COMPOSER_BASE_HEIGHT
    - MOBILE_COMPOSER_METRICS.inputMinHeight;

/**
 * The chat composer block: the bubble, and the furniture under it.
 *
 * Only the bubble grows with the text. The control row and both gaps are
 * fixed, which is why the chrome is a constant and the field is the whole
 * variable.
 */
export function resolveMobileComposerHeight(inputHeight: number, hasAttachments = false): number {
    return MOBILE_COMPOSER_CHROME_HEIGHT
        + resolveMobileComposerBubbleHeight(inputHeight, hasAttachments);
}

/** How tall the bubble itself is: the field's box, plus any attachment strip. */
export function resolveMobileComposerBubbleHeight(
    inputHeight: number,
    hasAttachments = false,
): number {
    const inputContainerHeight = Math.max(
        MOBILE_COMPOSER_METRICS.inputMinHeight,
        inputHeight
            + MOBILE_COMPOSER_METRICS.inputPaddingTop
            + MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    );
    return inputContainerHeight
        + (hasAttachments ? MOBILE_COMPOSER_METRICS.attachmentExtraHeight : 0);
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
        + resolveMobileComposerBubbleHeight(inputHeight, hasAttachments);
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
        // that already supplies one. The chat's row is outside the card and
        // carries the gutter itself (resolveMobileComposerControlRowGeometry).
        paddingHorizontal: 0,
    };
}

/**
 * The composer's first line, which is now the bubble and nothing else
 * (DROVE-206).
 *
 * DROVE-196 put the `+` out here beside the field, because that is where
 * Messages draws it. Clay looked at it and said the opposite: "the boss should
 * not be in the message box but the plus should be." So the `+` went inside,
 * to the leading rim, opposite the send button, and this line has one child.
 *
 * It stays a row rather than collapsing into the bubble's own style for two
 * reasons that are both load-bearing. It carries the composer's GUTTER, which
 * is what makes the bubble's rims line up with the control row's ends and lets
 * the recording banner be exactly as wide as the composer above it
 * (DROVE-157). And `alignItems: 'flex-end'` still pins the bubble to the
 * bottom of whatever the line grows to, which matters the moment anything is
 * ever put back beside it.
 *
 * No `gap`: there is nothing left on this line to be spaced from. The gap
 * between the `+` and the text is inside the field now
 * (`inputLeadingActionPadding`).
 */
export function resolveMobileComposerLineGeometry(): MobileComposerGeometryStyle {
    return {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: MOBILE_COMPOSER_METRICS.shellInset,
    };
}

/**
 * The control row, OUTSIDE the bubble (DROVE-196).
 *
 * Clay: "the second row buttons should sit outside the speech bubble." Mode,
 * effort, model, speaker and mic are settings for the session, not part of the
 * message, so they are furniture beneath the card rather than tenants of it.
 * Every control keeps DROVE-153's 44pt (`actionSize`, and 40 for the chips'
 * capsule inside a 44pt row) and DROVE-176's colours: this row moved, it did
 * not change.
 *
 * DROVE-206 adds a fourth control, the waveform, at the head of the audio
 * capsule. Clay: "the boss should not be in the message box." It was the face
 * the in-field button wore on an empty composer, which made that button two
 * things depending on what you had typed; out here it is one thing next to
 * the two other audio controls, and the row's height does not move for it
 * because it is a 44pt control on a 44pt row.
 *
 * It carries the shell gutter itself, which is the whole difference from the
 * Home row, and the two gaps that used to be the card's padding: `controlGap`
 * above it, `controlsBottomGap` below it over the status strip.
 */
export function resolveMobileComposerControlRowGeometry(): MobileComposerGeometryStyle {
    return {
        ...resolveMobileComposerActionRowGeometry(),
        paddingHorizontal: MOBILE_COMPOSER_METRICS.shellInset,
        marginTop: MOBILE_COMPOSER_METRICS.controlGap,
        marginBottom: MOBILE_COMPOSER_METRICS.controlsBottomGap,
    };
}

/**
 * A composer control's disc.
 *
 * `icon` is a control on the row, drawn at the full 44. `primary` and `add`
 * are the two IN-FIELD boxes (DROVE-206), the same 36 at opposite rims, and
 * they differ only in which side their air is on: the primary keeps the text
 * off its left, the `+` keeps it off its right.
 *
 * The BOXES stay identical and mirrored, which is what keeps the text's width
 * a constant and both touch targets at 46 (DROVE-214). What is not identical
 * is what fills them: the primary's box is a filled disc, the `+`'s is
 * transparent, and only the `+` therefore has to place its glyph by ink. That
 * is `addGlyphInkInset`, applied to the glyph inside this box and not to the
 * box, so nothing here moves.
 */
export function resolveMobileComposerActionGeometry(
    variant: 'icon' | 'primary' | 'add',
): MobileComposerGeometryStyle {
    const inField = variant === 'primary' || variant === 'add';
    const size = inField
        ? MOBILE_COMPOSER_METRICS.primaryActionSize
        : MOBILE_COMPOSER_METRICS.actionSize;
    return {
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...(variant === 'primary'
            ? { marginLeft: MOBILE_COMPOSER_METRICS.primaryActionMarginLeft }
            : {}),
        ...(variant === 'add'
            ? { marginRight: MOBILE_COMPOSER_METRICS.primaryActionMarginLeft }
            : {}),
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
    // Chat's `+`, a 36pt box inside the field (DROVE-206).
    const inFieldAddGlyphOffset = (MOBILE_COMPOSER_METRICS.primaryActionSize - addIconSize) / 2;
    // And the part of that box the glyph does not fill (DROVE-214).
    const addInkSize = addIconSize * IONICON_INK_RATIO.add;
    const addGlyphInkInset = (addIconSize - addInkSize) / 2;
    // One expression, read twice: an in-field control is inset off its rim,
    // takes its disc, and leaves air before the text. The `+` at the leading
    // rim and send at the trailing one are mirror images (DROVE-206).
    const inFieldActionPadding = MOBILE_COMPOSER_METRICS.primaryActionInset
        + MOBILE_COMPOSER_METRICS.primaryActionSize
        + MOBILE_COMPOSER_METRICS.primaryActionMarginLeft;
    return {
        shellInset,
        addGlyphOffset,
        inFieldAddGlyphOffset,
        addGlyphInkInset,
        addInkSize,
        // Rim to the `+`'s ink, which is what centring it in a box that is
        // itself concentric with the capsule's end comes out as (DROVE-214).
        addInkInset: MOBILE_COMPOSER_METRICS.primaryActionInset
            + inFieldAddGlyphOffset
            + addGlyphInkInset,
        // The send glyph carries the `+`'s ink, not the `+`'s point size
        // (DROVE-214). A paper plane fills more of its em than a plus does, so
        // matching the number would have drawn a heavier mark than the one at
        // the other rim.
        sendIconSize: addInkSize / IONICON_INK_RATIO.paperPlane,
        // The status strip's column and the zen caret's, 19. NOT the `+`'s ink
        // column, which is `shellInset + primaryActionInset` = 14 (DROVE-214).
        textInset: shellInset
            + MOBILE_COMPOSER_METRICS.primaryActionInset
            + inFieldAddGlyphOffset,
        inputContainerPaddingLeft: addGlyphOffset,
        inputContainerPaddingRight: addGlyphOffset,
        inputLeadingActionPadding: inFieldActionPadding,
        inputTrailingActionPadding: inFieldActionPadding,
    };
}

export const MOBILE_COMPOSER_LAYOUT = resolveAgentInputLayout({
    shellInset: MOBILE_COMPOSER_METRICS.shellInset,
    actionSize: MOBILE_COMPOSER_METRICS.actionSize,
    addIconSize: MOBILE_COMPOSER_METRICS.addIconSize,
});

/**
 * What the field's leading padding is, which is the only thing about the
 * composer that still depends on state (DROVE-206).
 *
 * With the `+` there the text starts past it; without one it starts at the
 * column the glyph would have occupied, so the caret lands in the same place
 * either way and only the gap in front of it changes. Zen mode and a session
 * that takes no context are the two ways to get the second case.
 */
export function resolveComposerLeadingPadding(hasAddButton: boolean): number {
    return hasAddButton
        ? MOBILE_COMPOSER_LAYOUT.inputLeadingActionPadding
        : MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft;
}

/**
 * How wide the text actually is, at a screen width (DROVE-206).
 *
 * Pinned rather than left to the placeholder. The field holds a control at
 * each rim now, so the usable width changed at BOTH ends and there is no
 * longer any width where "does the placeholder fit" is the same question as
 * "did the arrangement stay put". This is the expression the composer draws
 * with, so a metric that drifts moves a number in the spec.
 *
 * The send button is always drawn, so the trailing 46 is never conditional
 * and this does not change as the user types.
 */
export function resolveComposerTextWidth(screenWidth: number, hasAddButton = true): number {
    return screenWidth
        - MOBILE_COMPOSER_METRICS.shellInset * 2
        - resolveComposerLeadingPadding(hasAddButton)
        - MOBILE_COMPOSER_LAYOUT.inputTrailingActionPadding;
}
