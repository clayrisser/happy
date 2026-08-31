import { describe, expect, it } from 'vitest';
import * as agentInputLayout from './agentInputLayout';

const { resolveAgentInputLayout, resolveMobileCollapsedComposerGeometry } = agentInputLayout;

describe('agent input compact mobile layout', () => {
    it('starts the text 19pt inside the bubble and leaves room for the button', () => {
        const layout = resolveAgentInputLayout({
            shellInset: 10,
            actionSize: 44,
            addIconSize: 26,
        });

        // 19 used to be measured from the DOCK's edge and aligned the caret
        // with the add glyph on the row below. DROVE-196 moved the `+` up onto
        // the field's line, so there is no glyph below to align with and the
        // number is measured from the BUBBLE's leading rim instead: the card's
        // old gutter plus its old input padding, which is why the caret sits
        // exactly where it did.
        expect(layout.textInset).toBe(19);
        expect(layout.inputContainerPaddingLeft).toBe(9);
        expect(layout.inputContainerPaddingRight).toBe(9);
        expect(layout.textInset).toBe(layout.shellInset + (44 - 26) / 2);
        // The trailing side is not symmetric: the send/voice button lives
        // inside the field at that edge now (DROVE-153).
        expect(layout.inputTrailingActionPadding).toBe(4 + 36 + 6);
    });

    it('publishes one visual metric contract for Home and Chat composers', () => {
        expect((agentInputLayout as Record<string, unknown>).MOBILE_COMPOSER_METRICS).toEqual({
            shellRadius: 30,
            shellInset: 10,
            shellPaddingTop: 8,
            shellPaddingBottom: 8,
            inputMinHeight: 44,
            inputMaxHeight: 120,
            inputFontSize: 16,
            inputLineHeight: 22,
            inputPaddingTop: 4,
            inputPaddingBottom: 4,
            actionRowHeight: 44,
            actionSize: 44,
            addIconSize: 26,
            secondaryActionHeight: 40,
            effortWidth: 64,
            primaryActionSize: 36,
            primaryActionSlop: 6,
            primaryActionMarginLeft: 6,
            primaryActionInset: 4,
            attachmentExtraHeight: 72,
            controlGap: 6,
            controlsBottomGap: 8,
        });
    });

    /**
     * DROVE-196 re-pins DROVE-106's number, deliberately.
     *
     * DROVE-153 wrote "104, not 102: the row's buttons are drawn at 44 rather
     * than 42", and the buttons are still 44. What moved is the card around
     * them. The control row is outside the bubble now, so the card's 16pt of
     * padding goes with it and comes back as the two gaps that hold the row
     * off the bubble above and the status strip below.
     */
    it('re-pins the empty composer at 102, and says where each point went', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;

        // WAS 8 + 44 + 44 + 8, one card holding the field and the row.
        // NOW 44 + 6 + 44 + 8, a bubble, a gap, a row, and the row's clearance
        // over the status strip.
        expect(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT).toBe(102);
        expect(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT).toBe(
            agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT
            + metrics.controlGap
            + metrics.actionRowHeight
            + metrics.controlsBottomGap,
        );
        expect(agentInputLayout.MOBILE_COMPOSER_CHROME_HEIGHT).toBe(58);

        // The bubble IS the field. Nothing else is in it, and its floor is the
        // in-field send button plus its inset at each end, so the button is
        // 4pt off the rim on every side.
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT).toBe(44);
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT).toBe(metrics.inputMinHeight);
        expect(metrics.inputMinHeight).toBe(metrics.primaryActionSize + metrics.primaryActionInset * 2);

        // Two points shorter than DROVE-153's 104, and it is arithmetic rather
        // than a revert: 16pt of card padding out, 14pt of gap in.
        expect(104 - agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT).toBe(2);
        expect(metrics.shellPaddingTop + metrics.shellPaddingBottom
            - (metrics.controlGap + metrics.controlsBottomGap)).toBe(2);
    });

    /**
     * Home is not the screen Clay photographed and its dock has no status strip
     * for a control row to be furniture in front of, so its focused composer
     * stays one card and stays 104. Two constants exist so that moving the
     * chat's box cannot silently resize Home, which is what would have happened
     * while both read one number.
     */
    it('leaves the Home focused composer on DROVE-153 arithmetic', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;

        expect(agentInputLayout.MOBILE_HOME_COMPOSER_BASE_HEIGHT).toBe(104);
        expect(agentInputLayout.MOBILE_HOME_COMPOSER_BASE_HEIGHT).toBe(
            metrics.shellPaddingTop
            + metrics.inputMinHeight
            + metrics.actionRowHeight
            + metrics.shellPaddingBottom,
        );
        expect(agentInputLayout.resolveMobileHomeComposerHeight(30)).toBe(104);
        expect(agentInputLayout.resolveMobileHomeComposerHeight(30, true)).toBe(176);
        // And it is NOT the chat's number any more, which is the whole point of
        // there being two.
        expect(agentInputLayout.MOBILE_HOME_COMPOSER_BASE_HEIGHT)
            .not.toBe(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT);
    });

    it('starts collapsed composer text where the capsule becomes straight', () => {
        const geometry = resolveMobileCollapsedComposerGeometry();

        expect(geometry).toEqual({
            shellHeight: 56,
            shellRadius: 28,
            contentPaddingLeft: 7,
            contentPaddingRight: 7,
            inputPaddingLeft: 21,
            inputPaddingRight: 4,
            textInset: 28,
        });
        expect(geometry.textInset).toBe(geometry.shellRadius);
    });

    it('matches the chat shell height while the input grows and attachments appear', () => {
        const resolveHeight = (agentInputLayout as Record<string, unknown>)
            .resolveMobileComposerHeight as undefined | ((inputHeight: number, hasAttachments?: boolean) => number);

        expect(resolveHeight?.(30)).toBe(102);
        expect(resolveHeight?.(52)).toBe(118);
        expect(resolveHeight?.(120)).toBe(186);
        expect(resolveHeight?.(30, true)).toBe(174);
    });

    /**
     * Only the bubble grows. The control row and both gaps are fixed, so every
     * point the composer gains as the text wraps is a point of field.
     */
    it('grows the bubble and nothing else as the text wraps', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const block = agentInputLayout.resolveMobileComposerHeight;
        const bubble = agentInputLayout.resolveMobileComposerBubbleHeight;

        for (const inputHeight of [30, 52, 74, 120]) {
            expect(block(inputHeight) - bubble(inputHeight))
                .toBe(agentInputLayout.MOBILE_COMPOSER_CHROME_HEIGHT);
        }
        expect(bubble(30)).toBe(metrics.inputMinHeight);
        expect(bubble(30, true)).toBe(metrics.inputMinHeight + metrics.attachmentExtraHeight);
    });

    /**
     * DROVE-106. Clay photographed an empty composer standing roughly four
     * lines tall and asked for one. The pill row DROVE-83 put inside the card
     * is gone (DROVE-111) and the send button moved into the field
     * (DROVE-153), so the empty capsule is a single line again. This locks
     * that, because it is exactly the kind of number that drifts back.
     */
    it('opens one line tall when the composer is empty', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const resolveHeight = agentInputLayout.resolveMobileComposerHeight;

        // What a native multiline TextInput measures with no text in it: one
        // line and its own vertical padding. Nothing sets numberOfLines or a
        // height on the field itself, so this is the whole story.
        const emptyInputHeight = metrics.inputLineHeight
            + metrics.inputPaddingTop
            + metrics.inputPaddingBottom;
        expect(emptyInputHeight).toBe(30);

        // The capsule's 44pt floor is the in-field send button plus its inset
        // at each end (DROVE-153), not a spare line held open. A second line
        // would cost inputLineHeight on top of this.
        expect(metrics.inputMinHeight)
            .toBe(metrics.primaryActionSize + metrics.primaryActionInset * 2);
        expect(metrics.inputMinHeight).toBeLessThan(emptyInputHeight + metrics.inputLineHeight);

        // So an empty composer is the base block and nothing more, and typing
        // onto a second line is the first thing that makes it taller. The
        // bubble around that line is now exactly the line (DROVE-196), which
        // is as tight as this claim can be made.
        expect(agentInputLayout.resolveMobileComposerBubbleHeight(emptyInputHeight))
            .toBe(metrics.inputMinHeight);
        expect(resolveHeight(emptyInputHeight)).toBe(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT);
        expect(resolveHeight(emptyInputHeight + metrics.inputLineHeight))
            .toBeGreaterThan(resolveHeight(emptyInputHeight));
    });

    /**
     * Height does not read the screen width anywhere, so the narrowest phone
     * the status row is tested at (320) and a 393pt one open identically. The
     * only width-sensitive thing left is the placeholder wrapping, and it has
     * 185pt of room on the narrow one for `Type a message ...`. That is 60pt
     * less than before DROVE-196, because the `+` moved onto this line and
     * takes 50 of it; still comfortably more than the placeholder needs, and
     * the check below is what would catch it if a control were added beside
     * the `+` and pushed it under.
     */
    it('opens the same height on a 320pt phone as on a 393pt one', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const layout = agentInputLayout.MOBILE_COMPOSER_LAYOUT;

        // The `+` and its gap come off the line before the bubble starts
        // (DROVE-196), and the bubble carries the whole leading inset itself.
        const textWidth = (screenWidth: number) => screenWidth
            - metrics.shellInset * 2
            - metrics.actionSize
            - metrics.controlGap
            - layout.textInset
            - layout.inputTrailingActionPadding;

        expect(textWidth(320)).toBe(185);
        expect(textWidth(375)).toBe(240);
        expect(textWidth(393)).toBe(258);
        // Comfortably wider than the placeholder at 16pt, which is what would
        // have to wrap for either width to open a second line.
        expect(textWidth(320)).toBeGreaterThan(metrics.inputFontSize * 10);
    });

    it.each([
        ['icon',
            { width: 44, height: 44, flexShrink: 0 },
            { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }],
        // The pair is right-aligned, so each chip keeps its slack on the outside
        // of the separator. Only the model shrinks; the effort reserves the
        // widest label's width so changing level cannot reflow or clip the row.
        ['model',
            { flexShrink: 1, minWidth: 0, height: 40 },
            {
                minWidth: 0, height: 40, borderRadius: 20,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
                paddingLeft: 12, paddingRight: 4, gap: 7,
            }],
        ['effort',
            { flexShrink: 0, minWidth: 64, height: 40 },
            {
                minWidth: 0, height: 40, borderRadius: 20,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start',
                paddingLeft: 4, paddingRight: 12, gap: 4,
            }],
    ])('keeps %s native-menu frame geometry separate from label padding', (variant, expectedFrame, expectedContent) => {
        const resolveGeometry = (agentInputLayout as Record<string, unknown>)
            .resolveMobileComposerMenuGeometry as undefined | ((kind: string) => {
                frame: Record<string, unknown>;
                content: Record<string, unknown>;
            });

        const geometry = resolveGeometry?.(variant);
        expect(geometry?.frame).toEqual(expectedFrame);
        expect(geometry?.content).toEqual(expectedContent);
        expect(geometry?.frame).not.toHaveProperty('paddingLeft');
        expect(geometry?.frame).not.toHaveProperty('paddingRight');
        expect(geometry?.frame).not.toHaveProperty('gap');
    });

    /**
     * The two rows DROVE-196 introduced, and the thing that makes them the
     * arrangement Clay asked for rather than a reshuffle.
     */
    it('puts the plus on the field\u2019s line and the controls outside the bubble', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const line = agentInputLayout.resolveMobileComposerLineGeometry();
        const controls = agentInputLayout.resolveMobileComposerControlRowGeometry();

        // The `+` and the bubble share a line, bottom-aligned so the `+` stays
        // beside send as the field wraps rather than riding up the capsule.
        expect(line.flexDirection).toBe('row');
        expect(line.alignItems).toBe('flex-end');
        expect(line.gap).toBe(metrics.controlGap);

        // Both rows carry the shell gutter themselves, which is the whole
        // difference from a row inside a card: the card used to supply it, and
        // the card is now just the bubble between them.
        expect(line.paddingHorizontal).toBe(metrics.shellInset);
        expect(controls.paddingHorizontal).toBe(metrics.shellInset);
        expect(agentInputLayout.resolveMobileComposerActionRowGeometry().paddingHorizontal).toBe(0);

        // The card's old padding, reappearing outside it as the two gaps that
        // hold the row off the bubble and off the status strip.
        expect(controls.marginTop).toBe(metrics.controlGap);
        expect(controls.marginBottom).toBe(metrics.controlsBottomGap);
        expect((controls.marginTop ?? 0) + (controls.marginBottom ?? 0))
            .toBe(metrics.shellPaddingTop + metrics.shellPaddingBottom - 2);

        // DROVE-153's 44pt floor survives the move: the row is still 44 tall
        // and still spaces its controls by the one composer gap.
        expect(controls.height).toBe(metrics.actionRowHeight);
        expect(controls.height).toBe(44);
        expect(controls.gap).toBe(metrics.controlGap);
    });

    /**
     * What a screenshot at 375 and 393 would show, as numbers.
     *
     * The arrangement is the claim, not the pixel: `+` outside the bubble at
     * the leading edge, send inside it at the trailing edge, both on the same
     * line (DROVE-196). Walked left to right so a metric that drifts moves a
     * landmark here rather than only in the picture.
     */
    it.each([375, 393])('lays the line out leading-plus, trailing-send at %ipt', (screenWidth) => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const layout = agentInputLayout.MOBILE_COMPOSER_LAYOUT;

        const addLeft = metrics.shellInset;
        const addRight = addLeft + metrics.actionSize;
        const bubbleLeft = addRight + metrics.controlGap;
        const bubbleRight = screenWidth - metrics.shellInset;
        const textLeft = bubbleLeft + layout.textInset;
        const textRight = bubbleRight - layout.inputTrailingActionPadding;
        const primaryRight = bubbleRight - metrics.primaryActionInset;
        const primaryLeft = primaryRight - metrics.primaryActionSize;

        // The `+` is OUTSIDE the bubble, at the leading edge, with one gap.
        expect(addLeft).toBe(10);
        expect(addRight).toBeLessThan(bubbleLeft);
        expect(bubbleLeft - addRight).toBe(metrics.controlGap);

        // Send is INSIDE it, at the trailing edge, 4pt off the rim on every
        // side, which is the same 4 the field's 44pt floor is built from.
        expect(bubbleRight - primaryRight).toBe(metrics.primaryActionInset);
        expect(metrics.inputMinHeight - metrics.primaryActionSize)
            .toBe(metrics.primaryActionInset * 2);

        // And the text runs between them, stopping one gap short of the button
        // rather than under it.
        expect(textLeft).toBeLessThan(textRight);
        expect(primaryLeft - textRight).toBe(metrics.primaryActionMarginLeft);
        expect(textRight - textLeft).toBe(screenWidth === 375 ? 240 : 258);

        // The bubble's trailing rim and the control row's trailing edge are
        // the same column, because both now take the gutter from outside.
        expect(bubbleRight).toBe(screenWidth - metrics.shellInset);
        expect(agentInputLayout.resolveMobileComposerControlRowGeometry().paddingHorizontal)
            .toBe(metrics.shellInset);
    });

    it('uses identical row and circular-button geometry in both composers', () => {
        const exports = agentInputLayout as Record<string, unknown>;
        const resolveRow = exports.resolveMobileComposerActionRowGeometry as undefined | (() => Record<string, unknown>);
        const resolveAction = exports.resolveMobileComposerActionGeometry as undefined | ((kind: string) => Record<string, unknown>);

        expect(resolveRow?.()).toEqual({
            height: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 6,
            // No gutter: this is the row as Home draws it, inside a card that
            // supplies one.
            paddingHorizontal: 0,
        });
        expect(resolveAction?.('icon')).toEqual({
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
        });
        // The primary is smaller than the row's buttons because it is nested
        // inside the 44pt input capsule now (DROVE-153), the way Messages nests
        // its mic. 36 drawn plus 6pt of slop is a 48pt target.
        expect(resolveAction?.('primary')).toEqual({
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginLeft: 6,
        });
    });
});
