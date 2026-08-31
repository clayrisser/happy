export interface AgentInputLayoutGeometry {
    shellInset: number;
    actionSize: number;
    addIconSize: number;
}

export interface AgentInputLayout {
    shellInset: number;
    addGlyphOffset: number;
    /**
     * Where the text starts, measured from the bubble's leading rim
     * (DROVE-196).
     *
     * It used to be measured from the DOCK's edge, because the card spanned
     * the dock and the `+` sat below the caret; 19 was the column they shared.
     * The `+` is on the field's line now, so that alignment is gone and the
     * number is kept for what is left of it: 19 clears a 22pt capsule rim, and
     * it is where the caret already was inside the card, so nothing about
     * typing moved.
     */
    textInset: number;
    inputContainerPaddingLeft: number;
    inputContainerPaddingRight: number;
    /**
     * What the text has to leave clear on the trailing side for the in-field
     * send/voice button (DROVE-153): the button's inset from the capsule edge,
     * the button, and air between it and the last character.
     *
     * Measured from the bubble's trailing rim since DROVE-196. The card used
     * to add its own 10pt gutter under this, so the text stopped 56 short of
     * the rim for a button that ended at 46; the gutter moved outside the card
     * and the number is now literally what it says.
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
    // Home's card only (DROVE-196). Its focused composer is still one card
    // holding the field and the control row, so it still needs air at both
    // ends. The chat bubble is the field and nothing else, and it keeps none:
    // the in-field button's own 4pt inset is the only air inside it.
    shellPaddingTop: 8,
    shellPaddingBottom: 8,
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
    addIconSize: 26,
    secondaryActionHeight: 40,
    effortWidth: 64,
    /**
     * The send/voice/stop button, which now sits INSIDE the input capsule at
     * its trailing edge rather than at the end of the button row (DROVE-153).
     *
     * Clay's Messages reference is one capsule field with the primary
     * affordance inside it at the trailing edge, and this is that. Smaller
     * than the row's buttons on purpose: it is nested in a 44pt-tall field, so
     * drawing it at 44 would touch both edges. 36 drawn with 6pt of slop is a
     * 48pt target, above the floor, and it is the same proportion Messages
     * uses for the mic inside its own field.
     */
    primaryActionSize: 36,
    primaryActionSlop: 6,
    /** Air between the text and the in-field primary. */
    primaryActionMarginLeft: 6,
    /** Keeps the primary off the capsule's rounded trailing end. */
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
export const MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT = MOBILE_COMPOSER_METRICS.inputMinHeight;

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
 * The composer's first line: the `+`, then the bubble (DROVE-196).
 *
 * Clay: "Put plus to add image on same level as send button." The `+` is the
 * one affordance that adds content to the message being written, so it belongs
 * with the field rather than on the row of session settings underneath. This
 * is the Messages arrangement DROVE-153 took its cue from and stopped halfway
 * through: `+` OUTSIDE the field at the leading edge, primary action INSIDE it
 * at the trailing edge.
 *
 * `alignItems: 'flex-end'` is the part worth stating. The bubble grows upward
 * as the text wraps, and the `+` stays on the last line beside the send button
 * rather than floating up the side of a tall capsule.
 *
 * The gutter lives here now rather than inside the card, which is what lets
 * the bubble's trailing rim line up with the audio capsule below it and lets
 * the recording banner be exactly as wide as the composer above it.
 */
export function resolveMobileComposerLineGeometry(): MobileComposerGeometryStyle {
    return {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: MOBILE_COMPOSER_METRICS.controlGap,
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

export function resolveMobileComposerActionGeometry(
    variant: 'icon' | 'primary',
): MobileComposerGeometryStyle {
    return {
        width: variant === 'primary'
            ? MOBILE_COMPOSER_METRICS.primaryActionSize
            : MOBILE_COMPOSER_METRICS.actionSize,
        height: variant === 'primary'
            ? MOBILE_COMPOSER_METRICS.primaryActionSize
            : MOBILE_COMPOSER_METRICS.actionSize,
        borderRadius: variant === 'primary'
            ? MOBILE_COMPOSER_METRICS.primaryActionSize / 2
            : MOBILE_COMPOSER_METRICS.actionSize / 2,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...(variant === 'primary'
            ? { marginLeft: MOBILE_COMPOSER_METRICS.primaryActionMarginLeft }
            : {}),
    };
}

/** Resolves compact mobile composer geometry from the leading add glyph. */
export function resolveAgentInputLayout({
    shellInset,
    actionSize,
    addIconSize,
}: AgentInputLayoutGeometry): AgentInputLayout {
    const addGlyphOffset = (actionSize - addIconSize) / 2;
    return {
        shellInset,
        addGlyphOffset,
        textInset: shellInset + addGlyphOffset,
        inputContainerPaddingLeft: addGlyphOffset,
        inputContainerPaddingRight: addGlyphOffset,
        inputTrailingActionPadding: MOBILE_COMPOSER_METRICS.primaryActionInset
            + MOBILE_COMPOSER_METRICS.primaryActionSize
            + MOBILE_COMPOSER_METRICS.primaryActionMarginLeft,
    };
}

export const MOBILE_COMPOSER_LAYOUT = resolveAgentInputLayout({
    shellInset: MOBILE_COMPOSER_METRICS.shellInset,
    actionSize: MOBILE_COMPOSER_METRICS.actionSize,
    addIconSize: MOBILE_COMPOSER_METRICS.addIconSize,
});
