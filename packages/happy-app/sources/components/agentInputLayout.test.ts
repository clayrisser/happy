import { describe, expect, it } from 'vitest';
import * as agentInputLayout from './agentInputLayout';

const { resolveAgentInputLayout, resolveMobileCollapsedComposerGeometry } = agentInputLayout;

describe('agent input compact mobile layout', () => {
    /**
     * The glyph column, which is 19 for the third arrangement running and
     * arrives there a different way each time (DROVE-206).
     *
     * DROVE-153 had the `+` on the row under the card: 10 shell inset + 9,
     * half the difference between a 44pt button and its 26pt glyph. DROVE-196
     * moved it onto the field's line, same button, same arithmetic. DROVE-206
     * moves it INSIDE the field, where it is a 36pt disc inset 4 from the
     * bubble's rim, so the offset that centres the glyph is 5 rather than 9
     * and the column is 10 + 4 + 5.
     *
     * That it lands on 19 again is worth pinning precisely BECAUSE it looks
     * like nothing changed. The status row under the composer indents to this
     * column, and the alignment is now the `+`'s own ink rather than two
     * expressions that happen to agree.
     */
    it('keeps the glyph column at 19, by the in-field geometry that now decides it', () => {
        const layout = resolveAgentInputLayout({
            shellInset: 10,
            actionSize: 44,
            addIconSize: 26,
        });

        expect(layout.textInset).toBe(19);
        expect(layout.textInset).toBe(10 + 4 + (36 - 26) / 2);
        expect(layout.inFieldAddGlyphOffset).toBe(5);
        // Home's `+` is still a 44pt button on a row, and still 9.
        expect(layout.addGlyphOffset).toBe(9);
        expect(layout.inputContainerPaddingLeft).toBe(9);
        expect(layout.inputContainerPaddingRight).toBe(9);

        // SYMMETRIC AGAIN, and for the opposite reason to DROVE-196's. The
        // field holds a control at each rim now, both the same disc, so both
        // paddings are the same expression: 4 off the rim, 36 of disc, 6 of
        // air. The text is what runs between them.
        expect(layout.inputLeadingActionPadding).toBe(4 + 36 + 6);
        expect(layout.inputTrailingActionPadding).toBe(4 + 36 + 6);
        expect(layout.inputLeadingActionPadding).toBe(layout.inputTrailingActionPadding);
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

    it('opens the same height on a 320pt phone as on a 393pt one', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const resolveHeight = agentInputLayout.resolveMobileComposerHeight;
        // Height reads no screen width anywhere, which is why the widths get
        // a spec of their own below rather than a clause in this one.
        expect(resolveHeight(30)).toBe(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT);
        expect(metrics.inputMinHeight).toBe(44);
    });

    /**
     * THE TEXT'S USABLE WIDTH, RE-PINNED AT ALL THREE WIDTHS (DROVE-206).
     *
     * The field holds a control at each rim now, so the width changed at BOTH
     * ends and there is no width at which "does the placeholder still fit" is
     * the same question as "did the arrangement stay put". Pinned, therefore,
     * rather than left to the placeholder.
     *
     * The text came out WIDER even though it now shares its box, which is the
     * result worth stating. Outside on the line the `+` cost 69 (a 44pt
     * button, a 6pt gap, and the 19pt inset the bubble still kept); inside it
     * costs 46. 23pt back at every width.
     */
    it('re-pins the text at 320, 375 and 393, wider at each than it was outside', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const layout = agentInputLayout.MOBILE_COMPOSER_LAYOUT;
        const textWidth = agentInputLayout.resolveComposerTextWidth;

        // The composer's gutter, then a control's 46 at each rim.
        expect(textWidth(320)).toBe(208);
        expect(textWidth(375)).toBe(263);
        expect(textWidth(393)).toBe(281);
        for (const width of [320, 375, 393]) {
            expect(textWidth(width), `text at ${width}`).toBe(width - 112);
            // The expression, not the number: gutter, leading control,
            // trailing control, text.
            expect(
                metrics.shellInset * 2
                + layout.inputLeadingActionPadding
                + layout.inputTrailingActionPadding
                + textWidth(width),
                `the field at ${width}`,
            ).toBe(width);
        }

        // 23 wider than DROVE-196's 185 / 240 / 258.
        expect([textWidth(320) - 185, textWidth(375) - 240, textWidth(393) - 258])
            .toEqual([23, 23, 23]);

        // Still comfortably wider than the placeholder at 16pt on the
        // narrowest phone, which is what would have to wrap to open a second
        // line and break DROVE-106's one-line composer.
        expect(textWidth(320)).toBeGreaterThan(metrics.inputFontSize * 10);
    });

    /**
     * The one state that moves it: no `+` to draw, in zen mode or on a session
     * that takes no context. The caret falls back to the glyph column rather
     * than to the rim, so it does not jump; only the gap in front of it goes.
     */
    it('re-pins the same three widths with no `+` in the field', () => {
        const textWidth = agentInputLayout.resolveComposerTextWidth;
        const layout = agentInputLayout.MOBILE_COMPOSER_LAYOUT;

        expect(textWidth(320, false)).toBe(245);
        expect(textWidth(375, false)).toBe(300);
        expect(textWidth(393, false)).toBe(318);
        for (const width of [320, 375, 393]) {
            expect(textWidth(width, false) - textWidth(width), `zen at ${width}`)
                .toBe(layout.inputLeadingActionPadding - layout.inputContainerPaddingLeft);
        }

        // The caret is at the glyph column either way: 19 from the screen edge
        // with no `+`, and the `+`'s own ink at 19 when there is one.
        expect(agentInputLayout.MOBILE_COMPOSER_METRICS.shellInset
            + agentInputLayout.resolveComposerLeadingPadding(false)).toBe(layout.textInset);
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
    it('puts the plus inside the field and the controls outside the bubble', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const line = agentInputLayout.resolveMobileComposerLineGeometry();
        const controls = agentInputLayout.resolveMobileComposerControlRowGeometry();

        // The line is the bubble and nothing else now (DROVE-206), so there is
        // nothing left on it to be spaced from: no gap. It stays a
        // bottom-aligned row because it carries the composer's gutter.
        expect(line.flexDirection).toBe('row');
        expect(line.alignItems).toBe('flex-end');
        expect(line.gap).toBeUndefined();

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
     * What a screenshot at 375 and 393 would show, as numbers (DROVE-206).
     *
     * The arrangement is the claim, not the pixel: BOTH controls inside the
     * bubble, `+` at the leading rim, send at the trailing one, with the text
     * running between them. Walked left to right so a metric that drifts moves
     * a landmark here rather than only in the picture.
     */
    it.each([375, 393])('lays the field out plus-inside, send-inside at %ipt', (screenWidth) => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const layout = agentInputLayout.MOBILE_COMPOSER_LAYOUT;

        // The bubble is the whole line now: gutter to gutter.
        const bubbleLeft = metrics.shellInset;
        const bubbleRight = screenWidth - metrics.shellInset;
        const addLeft = bubbleLeft + metrics.primaryActionInset;
        const addRight = addLeft + metrics.primaryActionSize;
        const addGlyphLeft = addLeft + layout.inFieldAddGlyphOffset;
        const textLeft = bubbleLeft + layout.inputLeadingActionPadding;
        const textRight = bubbleRight - layout.inputTrailingActionPadding;
        const primaryRight = bubbleRight - metrics.primaryActionInset;
        const primaryLeft = primaryRight - metrics.primaryActionSize;

        // The `+` is INSIDE the bubble at the leading rim, 4pt off it, which
        // is the same 4 the send button keeps at the other end.
        expect(bubbleLeft).toBe(10);
        expect(addLeft - bubbleLeft).toBe(metrics.primaryActionInset);
        expect(addRight).toBeLessThan(textLeft);
        // And its ink lands on the 19pt column the status row indents to.
        expect(addGlyphLeft).toBe(layout.textInset);
        expect(addGlyphLeft).toBe(19);

        // Send is inside at the trailing rim, 4pt off on every side, which is
        // the same 4 the field's 44pt floor is built from.
        expect(bubbleRight - primaryRight).toBe(metrics.primaryActionInset);
        expect(metrics.inputMinHeight - metrics.primaryActionSize)
            .toBe(metrics.primaryActionInset * 2);

        // The two are mirror images across the field.
        expect(addLeft - bubbleLeft).toBe(bubbleRight - primaryRight);
        expect(addRight - addLeft).toBe(primaryRight - primaryLeft);

        // And the text runs between them, stopping one gap short of each
        // rather than under either.
        expect(textLeft).toBeLessThan(textRight);
        expect(textLeft - addRight).toBe(metrics.primaryActionMarginLeft);
        expect(primaryLeft - textRight).toBe(metrics.primaryActionMarginLeft);
        expect(textRight - textLeft).toBe(screenWidth === 375 ? 263 : 281);
        expect(textRight - textLeft)
            .toBe(agentInputLayout.resolveComposerTextWidth(screenWidth));

        // The bubble's rims and the control row's ends are the same two
        // columns, because both take the gutter from outside. That is what
        // makes the recording banner exactly as wide as the composer
        // (DROVE-157).
        expect(agentInputLayout.resolveMobileComposerLineGeometry().paddingHorizontal)
            .toBe(metrics.shellInset);
        expect(agentInputLayout.resolveMobileComposerControlRowGeometry().paddingHorizontal)
            .toBe(metrics.shellInset);
    });

    /**
     * The whole of DROVE-206 in one place: where the three things Clay moved
     * ended up, and what did not move for them.
     */
    it('moves the plus in, the waveform down, and the block not at all', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const layout = agentInputLayout.MOBILE_COMPOSER_LAYOUT;

        // 1. The `+` is in the field. There is nothing left on the line for it
        //    to sit beside, which is what says there is exactly one of it.
        expect(agentInputLayout.resolveMobileComposerLineGeometry().gap).toBeUndefined();
        expect(layout.inputLeadingActionPadding)
            .toBe(metrics.primaryActionInset + metrics.primaryActionSize
                + metrics.primaryActionMarginLeft);

        // 2. The waveform is on the control row, which is still 44 tall and
        //    still spaces its controls by the one composer gap. A fourth
        //    control costs the row no height.
        const controls = agentInputLayout.resolveMobileComposerControlRowGeometry();
        expect(controls.height).toBe(metrics.actionRowHeight);
        expect(controls.height).toBe(44);
        expect(controls.gap).toBe(metrics.controlGap);

        // 3. Both in-field discs clear DROVE-153's 44pt floor the same way:
        //    36 drawn plus 6pt of slop a side is a 48pt target.
        const target = metrics.primaryActionSize + metrics.primaryActionSlop * 2;
        expect(target).toBe(48);
        expect(target).toBeGreaterThanOrEqual(44);

        // And the empty composer is the same 102 it was, deliberately: the
        // bubble's floor did not move when the `+` came in, and the row's
        // height did not move when the waveform arrived (DROVE-106,
        // DROVE-196).
        expect(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT).toBe(102);
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT)
            .toBe(metrics.inputMinHeight);
        expect(agentInputLayout.resolveMobileComposerHeight(30)).toBe(102);
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
        // The two IN-FIELD discs are smaller than the row's buttons because
        // they are nested inside the 44pt input capsule (DROVE-153), the way
        // Messages nests its mic. 36 drawn plus 6pt of slop is a 48pt target.
        // They differ in one property, which is the side their air is on: the
        // primary keeps the text off its left, the `+` off its right
        // (DROVE-206).
        expect(resolveAction?.('primary')).toEqual({
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginLeft: 6,
        });
        expect(resolveAction?.('add')).toEqual({
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginRight: 6,
        });
    });
});
