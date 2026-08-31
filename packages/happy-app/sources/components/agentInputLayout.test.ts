import { describe, expect, it } from 'vitest';
import * as agentInputLayout from './agentInputLayout';

const { resolveAgentInputLayout, resolveMobileCollapsedComposerGeometry } = agentInputLayout;

describe('agent input compact mobile layout', () => {
    it('aligns composer text start with the left edge of the add glyph', () => {
        const layout = resolveAgentInputLayout({
            shellInset: 10,
            actionSize: 44,
            addIconSize: 26,
        });

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
        });
        // 104, not 102: the row's buttons are drawn at 44 rather than 42
        // (DROVE-153), which is two points of composer for a control that
        // finally matches its own tap target.
        expect((agentInputLayout as Record<string, unknown>).MOBILE_COMPOSER_BASE_HEIGHT).toBe(104);
        expect((agentInputLayout as Record<string, unknown>).MOBILE_COMPOSER_CHROME_HEIGHT).toBe(60);
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

        expect(resolveHeight?.(30)).toBe(104);
        expect(resolveHeight?.(52)).toBe(120);
        expect(resolveHeight?.(120)).toBe(188);
        expect(resolveHeight?.(30, true)).toBe(176);
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

        // So an empty composer is the base card and nothing more, and typing
        // onto a second line is the first thing that makes it taller.
        expect(resolveHeight(emptyInputHeight)).toBe(agentInputLayout.MOBILE_COMPOSER_BASE_HEIGHT);
        expect(resolveHeight(emptyInputHeight + metrics.inputLineHeight))
            .toBeGreaterThan(resolveHeight(emptyInputHeight));
    });

    /**
     * Height does not read the screen width anywhere, so the narrowest phone
     * the status row is tested at (320) and a 393pt one open identically. The
     * only width-sensitive thing left is the placeholder wrapping, and it has
     * 245pt of room on the narrow one for `Type a message ...`.
     */
    it('opens the same height on a 320pt phone as on a 393pt one', () => {
        const metrics = agentInputLayout.MOBILE_COMPOSER_METRICS;
        const layout = agentInputLayout.MOBILE_COMPOSER_LAYOUT;

        const textWidth = (screenWidth: number) => screenWidth
            - metrics.shellInset * 2
            - layout.inputContainerPaddingLeft
            - layout.inputTrailingActionPadding;

        expect(textWidth(320)).toBe(245);
        expect(textWidth(393)).toBe(318);
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
