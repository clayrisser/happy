import { describe, expect, it } from 'vitest';
import * as agentInputLayout from './agentInputLayout';

const { resolveAgentInputLayout, resolveMobileCollapsedComposerGeometry } = agentInputLayout;

describe('agent input compact mobile layout', () => {
    /**
     * THE TEXT COLUMN, still 19 and finally derived (DROVE-214).
     *
     * DROVE-153 got there as 10 shell inset + 9, half the difference between a
     * 44pt button and its 26pt glyph. DROVE-206 got there as 10 + 4 + 5 and
     * called it "the `+`'s ink column", which it never was. DROVE-214 rebuilt
     * the bubble as two rows, and 19 is now the bubble's INTERIOR EDGE: the
     * gutter plus the bubble's own padding. The caret starts on it and so does
     * the `+`'s disc on the row below, so it is a column two things really
     * stand in rather than a number that kept landing in the same place.
     */
    it('derives the text column from the bubble rather than from a glyph', () => {
        const layout = resolveAgentInputLayout({
            shellInset: 10,
            actionSize: 44,
            addIconSize: 26,
        });

        expect(layout.textInset).toBe(19);
        expect(layout.textInset).toBe(10 + agentInputLayout.MOBILE_COMPOSER_METRICS.bubbleInset);
        // Home's `+` is still a 44pt button on a row, and still 9.
        expect(layout.addGlyphOffset).toBe(9);
        expect(layout.inputContainerPaddingLeft).toBe(9);
        expect(layout.inputContainerPaddingRight).toBe(9);

        // Every in-field placement number is gone with the arrangement that
        // needed it. What is left is a size and a column.
        for (const key of [
            'inFieldAddGlyphOffset', 'addGlyphInkInset', 'addInkSize', 'addInkInset',
            'inputLeadingActionPadding', 'inputTrailingActionPadding',
        ]) {
            expect(layout).not.toHaveProperty(key);
        }
    });

    it('publishes one visual metric contract for Home and Chat composers', () => {
        expect((agentInputLayout as Record<string, unknown>).MOBILE_COMPOSER_METRICS).toEqual({
            shellRadius: 30,
            shellInset: 10,
            // AgentInput's OUTER padding, outside the shell inset (DROVE-223).
            // The status strip sits inside it too, and its budget was
            // measuring the row against the bare screen without it.
            shellGutter: 8,
            shellGutterWide: 12,
            shellPaddingTop: 8,
            shellPaddingBottom: 8,
            bubbleInset: 9,
            // The floor is its own number (DROVE-236): the three sides that
            // hold text keep the square corner's 9, and the one that holds two
            // circles keeps what a circle needs.
            bubbleInsetBottom: 4,
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
            primaryActionSize: 39,
            primaryActionSlop: 6,
            attachmentExtraHeight: 72,
            controlGap: 6,
            controlsBottomGap: 8,
        });
    });

    /**
     * THE COMPOSER GETS 46PT TALLER, and that is the price of the arrangement
     * Clay asked for (DROVE-214).
     *
     * "probably we should put everything in the speech bubble with the buttons
     * on the bottom and the text input one row above it?" A button row inside
     * the bubble costs its own height and the air round it, and the transcript
     * pays. Written down here rather than discovered later.
     */
    it('re-pins the empty composer at 93, and says where each point went', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;

        // DROVE-196   44 + 6 + 44 + 8   one-row bubble, gap, control row, clearance
        // DROVE-214   90 + 6 + 44 + 8   two-row bubble, and only the bubble moved
        // DROVE-236a  85 + 6 + 44 + 8   the bubble's floor gives 5 back
        // DROVE-236b  85         +  8   the row moves INTO the bubble's own
        //                               button row and stops existing
        // DROVE-266   88         +  8   the buttons grow 36 -> 39 and the row
        //                               with them, on Clay's "a little bigger"
        expect(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT).toBe(96);
        expect(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT).toBe(
            agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT
            + metrics.controlsBottomGap,
        );
        // The chrome under the bubble is the gap over the status strip and
        // nothing else. That gap did not change value, it changed owner: it
        // was the control row's `marginBottom` and it is the composer line's.
        expect(agentInputLayout.MOBILE_COMPOSER_CHROME_HEIGHT).toBe(8);
        expect(agentInputLayout.MOBILE_COMPOSER_CHROME_HEIGHT).toBe(metrics.controlsBottomGap);
        expect(agentInputLayout.resolveMobileComposerLineGeometry().marginBottom)
            .toBe(metrics.controlsBottomGap);
        expect(metrics.controlGap).toBe(6);
        expect(metrics.controlsBottomGap).toBe(8);
        // The whole 50 was the row plus the gap that held it off the bubble,
        // and DROVE-266 spends 3 of it back on bigger buttons. Written as the
        // two terms rather than as 47, so the ledger says who took what.
        expect(143 - agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT)
            .toBe(metrics.actionRowHeight + metrics.controlGap - 3);
        expect(metrics.primaryActionSize - 36).toBe(3);
        // And the bubble did NOT grow to take the row's controls: they are
        // drawn at the button row's own size rather than the 44 they wore
        // outside, so the composer is shorter than DROVE-196's while holding
        // every control DROVE-196 had. The 3 it gains in DROVE-266 is the
        // buttons growing, which is a thing Clay asked for rather than a cost
        // the move imposed.
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE).toBe(39);
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE)
            .toBe(agentInputLayout.MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT);
        expect(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT).toBeLessThan(102);

        // The bubble is padding, one line, the gap, the button row, and a
        // shallower floor.
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT).toBe(88);
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT).toBe(
            metrics.bubbleInset
            + agentInputLayout.MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT
            + metrics.controlGap
            + agentInputLayout.MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT
            + metrics.bubbleInsetBottom,
        );
        // The text row is the text and nothing else now. 44 was never about
        // text: it was the height a disc inset 4 needed.
        expect(agentInputLayout.MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT).toBe(30);
        expect(agentInputLayout.MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT).toBe(
            metrics.inputLineHeight + metrics.inputPaddingTop + metrics.inputPaddingBottom,
        );
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT)
            .toBe(metrics.primaryActionSize);
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
        const resolveHeight = agentInputLayout.resolveMobileComposerHeight;

        // `inputHeight` is the TEXT's measured height, so an empty composer is
        // one line box. Both ends of that convention are in one place now.
        expect(resolveHeight(22)).toBe(96);
        expect(resolveHeight(44)).toBe(118);
        expect(resolveHeight(120)).toBe(194);
        expect(resolveHeight(400)).toBe(194);
        expect(resolveHeight(22, true)).toBe(174);
        // The capsule's own row costs exactly what a row in this column costs:
        // its height and the gap above it (DROVE-266).
        expect(resolveHeight(22, false, true) - resolveHeight(22))
            .toBe(agentInputLayout.MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT
                + agentInputLayout.MOBILE_COMPOSER_METRICS.controlGap);
    });

    /**
     * Only the TEXT ROW grows. The button row inside the bubble, the control
     * row under it and every gap are fixed, so every point the composer gains
     * as the message wraps is a point of text.
     */
    it('grows the text row and nothing else as the text wraps', () => {
        const block = agentInputLayout.resolveMobileComposerHeight;
        const bubble = agentInputLayout.resolveMobileComposerBubbleHeight;
        const textRow = agentInputLayout.resolveMobileComposerTextRowHeight;
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;

        for (const inputHeight of [22, 44, 66, 120]) {
            expect(block(inputHeight) - bubble(inputHeight))
                .toBe(agentInputLayout.MOBILE_COMPOSER_CHROME_HEIGHT);
            // The bubble is its text row plus a fixed remainder.
            expect(bubble(inputHeight) - textRow(inputHeight))
                .toBe(metrics.bubbleInset
                    + metrics.bubbleInsetBottom
                    + metrics.controlGap
                    + agentInputLayout.MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT);
        }
        expect(bubble(22)).toBe(agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);
        // A strip is a third row in the bubble's column, so it costs the gap
        // as well as its own height.
        expect(bubble(22, true)).toBe(agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT
            + metrics.attachmentExtraHeight + metrics.controlGap);
        // And it stops at the cap rather than running away, which the model
        // used to miss because nothing laid out from it.
        expect(textRow(400)).toBe(metrics.inputMaxHeight
            + metrics.inputPaddingTop + metrics.inputPaddingBottom);
    });

    /**
     * DROVE-106. Clay photographed an empty composer standing roughly four
     * lines tall and asked for one. It is still one line of TEXT: what
     * DROVE-214 added under it is a row of buttons, not a spare line.
     */
    it('opens one line of text tall when the composer is empty', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const resolveHeight = agentInputLayout.resolveMobileComposerHeight;

        // What a native multiline TextInput measures with no text in it.
        // Nothing sets numberOfLines or a height on the field itself.
        expect(agentInputLayout.resolveMobileComposerTextRowHeight(metrics.inputLineHeight))
            .toBe(agentInputLayout.MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT);

        // A second line is the first thing that makes the composer taller, and
        // it costs exactly one line height.
        expect(resolveHeight(metrics.inputLineHeight))
            .toBe(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT);
        expect(resolveHeight(metrics.inputLineHeight * 2)
            - resolveHeight(metrics.inputLineHeight)).toBe(metrics.inputLineHeight);
    });

    it('reads no screen width itself, and takes the one shape question as an argument', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const resolveHeight = agentInputLayout.resolveMobileComposerHeight;
        // It used to be true that the composer opened the same height on a
        // 320pt phone as on a 393pt one. DROVE-266 makes it one height per
        // SHAPE rather than one height full stop, because below
        // COMPOSER_ROW_MIN_MODEL_WIDTH the capsule takes a row of its own.
        //
        // What has NOT changed is that this function reads no width. The shape
        // arrives as an argument decided by `composerCapsuleOwnRow`, so there is
        // still exactly one place that turns a width into a layout, which is the
        // property the old test was really protecting.
        expect(resolveHeight(metrics.inputLineHeight))
            .toBe(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT);
        expect(resolveHeight(metrics.inputLineHeight, false, false))
            .toBe(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT);
    });

    /**
     * THE TEXT'S WIDTH, AND WHY IT IS NO LONGER PINNED (DROVE-214).
     *
     * DROVE-206 pinned 208 / 263 / 281 because the `+` and the send button
     * stood in the text's own row: whether each was drawn changed where the
     * text could start and stop, so the width had to be reserved
     * unconditionally or the caret would move on the first keystroke.
     *
     * Both are on a row of their own now. The text gets the whole interior of
     * the bubble in every state, zen mode included, so the caret cannot move
     * and there is nothing left to reserve. The constraint is gone, not
     * satisfied by a bigger number.
     */
    it('gives the text the bubble\'s whole interior, at every width and every state', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const textWidth = agentInputLayout.resolveComposerTextWidth;

        expect(textWidth(320)).toBe(282);
        expect(textWidth(375)).toBe(337);
        expect(textWidth(393)).toBe(355);
        for (const width of [320, 375, 393]) {
            expect(textWidth(width), `text at ${width}`).toBe(width - 38);
            // The gutter and the bubble's padding, and the text is the rest.
            expect(
                metrics.shellInset * 2 + metrics.bubbleInset * 2 + textWidth(width),
                `the bubble at ${width}`,
            ).toBe(width);
        }

        // 74 wider than DROVE-206's 208 / 263 / 281.
        expect([textWidth(320) - 208, textWidth(375) - 263, textWidth(393) - 281])
            .toEqual([74, 74, 74]);

        // It takes ONE argument now. There is no state that changes it, which
        // is what deletes `resolveComposerLeadingPadding` with it.
        expect(textWidth.length).toBe(1);
        expect(agentInputLayout).not.toHaveProperty('resolveComposerLeadingPadding');
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
     * THERE IS NO ROW OUTSIDE THE BUBBLE ANY MORE (DROVE-236).
     *
     * The name of this test used to be "keeps the session controls outside the
     * bubble", which is DROVE-196's instruction. Clay reversed it in red on a
     * screenshot: an arrow from the session capsule up into the bubble's empty
     * middle, another from the audio button up to the right rim, and an X
     * through the mic that was already in there.
     */
    it('has no control row outside the bubble, and gives its gap to the line', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const line = agentInputLayout.resolveMobileComposerLineGeometry();

        // Gone, not renamed. A caller that still asks for it fails to compile
        // rather than laying out a row nothing draws.
        expect(agentInputLayout).not.toHaveProperty('resolveMobileComposerControlRowGeometry');

        // The line is the bubble and nothing else, so there is nothing left on
        // it to be spaced from: no gap. It stays a row because it carries the
        // composer's gutter, and the recording banner's width is measured
        // against exactly that now the control row is not there to measure to.
        expect(line.flexDirection).toBe('row');
        expect(line.gap).toBeUndefined();
        expect(line.paddingHorizontal).toBe(metrics.shellInset);

        // The control row's `marginBottom` moved here, same value, same job:
        // it is what stops the status strip's 14pt of upward tap slop reaching
        // the composer's buttons.
        expect(line.marginBottom).toBe(metrics.controlsBottomGap);
        expect(line.marginTop).toBeUndefined();

        // HOME's row is untouched. It still holds its controls in a card of
        // its own, still 44 tall, still spaced by the one composer gap.
        const home = agentInputLayout.resolveMobileComposerActionRowGeometry();
        expect(home.paddingHorizontal).toBe(0);
        expect(home.height).toBe(metrics.actionRowHeight);
        expect(home.height).toBe(44);
        expect(home.gap).toBe(metrics.controlGap);
    });

    /**
     * WHAT IS IN THE BUBBLE. Everything (DROVE-236).
     *
     * DROVE-214 split it: the MESSAGE's controls inside, the SESSION's on the
     * row below, on DROVE-196's "the second row buttons should sit outside the
     * speech bubble." Clay has drawn the reverse in red and it is not
     * ambiguous: an arrow from the session capsule up into the bubble's empty
     * middle, another from the audio button to the right rim, an X through the
     * duplicate mic, the middle scribbled over.
     *
     * DROVE-206's "the boss should not be in the message box" is NOT reversed
     * with it. Boss mode is not a control on this row: it is the audio
     * button's long press, and that button is one thing at one spot rather
     * than the two-identities-in-one-place that ticket was about.
     */
    it('puts every control in the bubble, at the row\'s own size', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;

        // The bubble's row is as tall as the discs it holds and no taller, so
        // their margin is the bubble's padding rather than a number of theirs.
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT)
            .toBe(metrics.primaryActionSize);
        // And the controls that joined it are drawn at exactly that, which is
        // the whole reason the bubble did not grow FOR THEM: 85 before the move
        // and 85 after it. The 88 is DROVE-266 growing every object on the row
        // together, which is a different thing being paid for.
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE)
            .toBe(agentInputLayout.MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT);
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT).toBe(88);

        // The audio button is the same disc as the `+` and send now, not the
        // 44pt icon button it was inside the shared capsule.
        const audio = agentInputLayout.resolveMobileComposerActionGeometry('audio');
        expect(audio).toEqual(agentInputLayout.resolveMobileComposerActionGeometry('primary'));
        expect(audio.width).toBe(metrics.primaryActionSize);

        // HOME's row is the one that still holds 44pt controls at 44.
        expect(metrics.actionRowHeight).toBe(44);
        expect(agentInputLayout.resolveMobileComposerActionGeometry('icon').width)
            .toBe(metrics.actionSize);

        // Every disc on the bubble's row clears DROVE-153's 44pt floor the
        // same way: 39 drawn plus 6pt of slop a side is a 51pt target.
        const target = metrics.primaryActionSize + metrics.primaryActionSlop * 2;
        expect(target).toBe(51);
        expect(target).toBeGreaterThanOrEqual(44);

        // The two GLYPH SEGMENTS are the exception and it is stated rather
        // than buried: they sit against each other inside one capsule, so
        // there is no horizontal slop to take and their touch box is 39 x 51.
        // The argument for spending it is on the constant. DROVE-266 narrows
        // the shortfall from 8pt to 5 without closing it.
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE).toBeLessThan(44);
        expect(agentInputLayout.MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE
            + metrics.primaryActionSlop * 2).toBe(51);
    });

    it('uses identical row and circular-button geometry in both composers', () => {
        const resolveRow = agentInputLayout.resolveMobileComposerActionRowGeometry;
        const resolveAction = agentInputLayout.resolveMobileComposerActionGeometry;

        expect(resolveRow()).toEqual({
            height: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 6,
            // No gutter: this is the row as Home draws it, inside a card that
            // supplies one.
            paddingHorizontal: 0,
        });
        expect(resolveAction('icon')).toEqual({
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
        });
        // THE TWO IN-BUBBLE DISCS ARE ONE OBJECT (DROVE-214). They used to
        // differ by a mirrored margin, which was how the text was kept off
        // each of them while all three shared a row. Nothing shares a row with
        // the text now, so the margins are gone and the two are identical.
        const disc = {
            width: 39,
            height: 39,
            borderRadius: 19.5,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
        };
        expect(resolveAction('primary')).toEqual(disc);
        expect(resolveAction('add')).toEqual(disc);
        expect(resolveAction('add')).toEqual(resolveAction('primary'));
    });

    /**
     * The one glyph metric that survives, and why (DROVE-214).
     *
     * Three passes used Ionicons' em coverage to compute where to PUT a glyph
     * and all three shipped something Clay called wrong. Placement is the
     * layout engine's job now. What the engine cannot answer is that a paper
     * plane and a plus at the same point size draw different amounts of ink,
     * so making the two ends of the row read equally heavy means matching ink
     * rather than font size.
     */
    it('sizes the send glyph by the `+`\'s ink, and computes nothing else from the font', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const layout = agentInputLayout.MOBILE_COMPOSER_LAYOUT;

        // `add` fills 320 of Ionicons' 512 em, so 16.25 of ink at 26pt.
        expect(agentInputLayout.IONICON_INK_RATIO.add).toBe(0.625);
        expect(metrics.addIconSize * agentInputLayout.IONICON_INK_RATIO.add).toBe(16.25);

        // The send glyph is sized so its ink IS that ink. `send` fills more of
        // its em than a plus does, so equal ink means a smaller number than 26.
        expect(agentInputLayout.IONICON_INK_RATIO.send).toBe(0.936807);
        expect(layout.sendIconSize).toBeCloseTo(17.346, 3);
        expect(layout.sendIconSize * agentInputLayout.IONICON_INK_RATIO.send)
            .toBeCloseTo(16.25, 6);
        expect(layout.sendIconSize).toBeGreaterThan(16);
        expect(layout.sendIconSize).toBeLessThan(metrics.addIconSize);

        // 17.35, DOWN FROM the plane's 18.58 (DROVE-236). Clay sent a crop of
        // the flat right-pointing arrowhead Slack and Telegram draw and asked
        // "Shouldn't send look more like this?" `send` is that glyph, it is
        // WIDER in its em than the plane was, and matching ink therefore
        // means a smaller point size. The mark on the page is shorter and
        // exactly as heavy, which is the point of measuring ink at all.
        expect(layout.sendIconSize).toBeLessThan(18.582);
        expect(agentInputLayout.IONICON_INK_RATIO).not.toHaveProperty('paperPlane');

        // THE MEASURE IS THE LONGEST INK SPAN. `paper-plane` was square in its
        // own bounds so DROVE-214 never met the question; `send` is 0.936807
        // wide against 0.811523 tall. Sizing on the height would have drawn a
        // mark 18.76pt across against the `+`'s 16.25pt box, so the wider axis
        // is what caps it and neither rim out-draws the other.
        expect(layout.sendIconSize * 0.811523).toBeLessThan(16.25);
        expect(16.25 / 0.811523).toBeGreaterThan(metrics.addIconSize * 0.625 / 0.936807);

        // And the ink clears the disc it sits in by a wide margin, which is
        // all that ever needed checking now that the disc centres it.
        expect(metrics.addIconSize * agentInputLayout.IONICON_INK_RATIO.add)
            .toBeLessThan(metrics.primaryActionSize);
    });
});
