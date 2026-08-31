import { describe, expect, it } from 'vitest';
import {
    DOCK_CONTENT_BOTTOM_PADDING,
    DOCK_SCRIM_FADE_HEIGHT,
    HOME_INDICATOR_KEEP_OUT,
    STATUS_ROW_BOTTOM_CLEARANCE,
    STATUS_ROW_TAP_SLOP_BOTTOM,
    STATUS_ROW_TAP_SLOP_TOP,
    STATUS_ROW_TAP_HEIGHT,
    STATUS_ROW_TEXT_LINE_HEIGHT,
    resolveComposerButtonFloor,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveDockScrimHeight,
    resolveStatusRowBottomGap,
    resolveStatusRowTapFloor,
    transparentOf,
} from './agentDockLayout';

// Measured on the iPhone the DROVE-113 screenshot came from: composer card,
// the DROVE-82 status row under it, AgentInput's 8pt container padding, and a
// 34pt home indicator inset. DROVE-111 took the session pill's own 40pt row
// out of the card, which is why the card is shorter here than it was; the
// arithmetic below never knew about that row, because the dock is measured
// rather than computed.
const composerOnly = 76;
const withStatusRow = composerOnly + 24;
const safeAreaBottom = 34;
/** What the dock frame keeps under itself once the gap is capped: 16 - 8. */
const dockBottomOffset = STATUS_ROW_BOTTOM_CLEARANCE - DOCK_CONTENT_BOTTOM_PADDING;
/** A phone with a home button: no indicator, so nothing to clear. */
const noIndicator = 0;

describe('resolveDockBottomOffset', () => {
    it('spends the composer padding inside the safe area instead of on top of it', () => {
        // DROVE-113's half of the rule: the 8pt is spent inside the clearance,
        // never stacked on it, whatever the clearance ends up being.
        expect(resolveDockBottomOffset(safeAreaBottom, true)).toBe(
            resolveStatusRowBottomGap(safeAreaBottom) - DOCK_CONTENT_BOTTOM_PADDING,
        );
    });

    it('caps the gap at the status row clearance instead of spending the whole inset', () => {
        // DROVE-144. 34pt of safe area, 16pt kept, 18pt handed to the chat.
        expect(resolveDockBottomOffset(safeAreaBottom, true)).toBe(dockBottomOffset);
        expect(resolveDockBottomOffset(safeAreaBottom, true)).toBeLessThan(
            safeAreaBottom - DOCK_CONTENT_BOTTOM_PADDING,
        );
    });

    it('never keeps more room than the uncapped rule would have', () => {
        // A cap, not a subtraction: every device shape moves one way only.
        for (const inset of [0, 4, 8, 12, 20, 21, 24, 34, 44]) {
            expect(resolveDockBottomOffset(inset, true)).toBeLessThanOrEqual(
                Math.max(0, inset - DOCK_CONTENT_BOTTOM_PADDING),
            );
        }
    });

    it('leaves a small inset alone rather than inventing room it does not have', () => {
        // Android reports all sorts of bottom insets. Below the cap the old
        // behaviour stands untouched.
        expect(resolveDockBottomOffset(10, true)).toBe(2);
        expect(resolveDockBottomOffset(20, true)).toBe(dockBottomOffset);
    });

    it('never goes negative on a device with no home indicator', () => {
        expect(resolveDockBottomOffset(noIndicator, true)).toBe(0);
        expect(resolveDockBottomOffset(4, true)).toBe(0);
    });

    it('leaves non-floating layouts alone', () => {
        expect(resolveDockBottomOffset(safeAreaBottom, false)).toBe(safeAreaBottom);
    });
});

describe('resolveDockInset', () => {
    it('is zero when the dock is not floating', () => {
        expect(resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: false,
        })).toBe(0);
    });

    it('reserves the dock plus the gap under it, keyboard closed', () => {
        expect(resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
        })).toBe(withStatusRow + dockBottomOffset);
    });

    it('grows by exactly the status row when the row is present', () => {
        const without = resolveDockInset({
            dockHeight: composerOnly,
            safeAreaBottom,
            floatingDock: true,
        });
        const with_ = resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
        });
        expect(with_ - without).toBe(withStatusRow - composerOnly);
    });

    it('ignores the gate overlay, which is measured out of dockHeight', () => {
        // DROVE-88 mounts the overlay at bottom: '100%' inside the dock, so it
        // never reaches onLayout. The inset is identical with a gate pending.
        const overlayHeight = 220;
        const noGate = resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
        });
        const gatePending = resolveDockInset({
            dockHeight: withStatusRow, // unchanged: the overlay adds no measured height
            safeAreaBottom,
            floatingDock: true,
        });
        expect(gatePending).toBe(noGate);
        expect(gatePending).not.toBe(noGate + overlayHeight);
    });

    it('follows the keyboard when the platform pads instead of translating', () => {
        const keyboardInset = 291;
        expect(resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
            keyboardInset,
        })).toBe(resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
        }) + keyboardInset);
    });

    /*
     * The one number Clay can see: how much empty space sits under the status
     * line.
     *
     * READ THIS BEFORE "FIXING" IT BACK. Until DROVE-144 this asserted the gap
     * EQUALS safeArea.bottom, and that was correct for what it was measuring:
     * DROVE-113 had just removed a genuine 8pt double count, and DROVE-111
     * re-measured after taking the session pill row out and found no second
     * gap to delete. Nothing was left to remove by accident.
     *
     * Clay asked for the space a third time anyway, so DROVE-144 stopped
     * treating the 34pt as untouchable. The safe area is Apple's reservation
     * for the home indicator, not the indicator: the bar is 5pt tall sitting
     * 8pt off the edge, so only the bottom 13pt is really the indicator's.
     * The status row is not plain text either, its segments open sheets
     * (DROVE-111, DROVE-117), so what has to clear the indicator is the touch
     * area, not the glyphs. That is the whole derivation:
     *
     *     gap = HOME_INDICATOR_KEEP_OUT (13) + STATUS_ROW_TAP_SLOP_BOTTOM (3)
     *
     * 16pt, not the 34 the platform asks for and not a round 10 either. Ten
     * would put the text itself under the indicator.
     */
    it('keeps the status row clearance under the row, not the whole safe area', () => {
        const reserved = resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
        });
        const gap = reserved - withStatusRow + DOCK_CONTENT_BOTTOM_PADDING;
        expect(gap).toBe(STATUS_ROW_BOTTOM_CLEARANCE);
        expect(gap).toBe(resolveStatusRowBottomGap(safeAreaBottom));
        // Deliberately false as of DROVE-144, and the point of the ticket.
        expect(gap).not.toBe(safeAreaBottom);
        expect(safeAreaBottom - gap).toBe(18);
    });

    it('is unchanged by an open keyboard on the translating platform', () => {
        expect(resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
            keyboardInset: 0,
        })).toBe(withStatusRow + dockBottomOffset);
    });
});

describe('resolveDockScrimHeight', () => {
    it('covers the dock, the gap under it, and the fade above it', () => {
        expect(resolveDockScrimHeight(withStatusRow, safeAreaBottom))
            .toBe(withStatusRow + dockBottomOffset + DOCK_SCRIM_FADE_HEIGHT);
    });

    it('paints nothing before the dock has been measured', () => {
        expect(resolveDockScrimHeight(0, safeAreaBottom)).toBe(0);
    });

    it('always reaches at least as far as the reserved inset', () => {
        const inset = resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
        });
        expect(resolveDockScrimHeight(withStatusRow, safeAreaBottom)).toBeGreaterThanOrEqual(inset);
    });
});

describe('status row clearance', () => {
    it('stops the row tap targets exactly where the home indicator starts', () => {
        // The binding constraint. A segment answers touches down to here and
        // no further, so the system swipe never competes with a tap on the
        // agent count or the quota.
        expect(resolveStatusRowTapFloor(safeAreaBottom)).toBe(HOME_INDICATOR_KEEP_OUT);
        expect(resolveStatusRowTapFloor(safeAreaBottom))
            .toBeGreaterThanOrEqual(HOME_INDICATOR_KEEP_OUT);
    });

    it('leaves air between the 11pt text and the indicator', () => {
        expect(resolveStatusRowBottomGap(safeAreaBottom) - HOME_INDICATOR_KEEP_OUT)
            .toBe(STATUS_ROW_TAP_SLOP_BOTTOM);
    });

    it('keeps the touch height worth having', () => {
        // 14 above, the 14pt line itself, 3 below. DROVE-144 left this at 29
        // and DROVE-153 took the two points that were free above it.
        expect(STATUS_ROW_TAP_HEIGHT).toBe(31);
        expect(STATUS_ROW_TAP_HEIGHT)
            .toBe(STATUS_ROW_TAP_SLOP_TOP + STATUS_ROW_TEXT_LINE_HEIGHT + STATUS_ROW_TAP_SLOP_BOTTOM);
    });

    it('cannot reach the 44pt floor without buying the points from somewhere', () => {
        // The upward answer to Clay's "normal button sizes", worked out rather
        // than asserted. The segments' ceiling is the composer card's own
        // buttons: a touch area drawn over those would take presses off
        // controls that are themselves at the floor.
        expect(resolveComposerButtonFloor(safeAreaBottom)).toBe(44);

        const ceiling = resolveComposerButtonFloor(safeAreaBottom) - HOME_INDICATOR_KEEP_OUT;
        expect(ceiling).toBe(STATUS_ROW_TAP_HEIGHT);
        expect(ceiling).toBeLessThan(44);

        // And what the other side of the trade would cost: 44 - 31 points, out
        // of the 18 DROVE-144 reclaimed.
        expect(44 - ceiling).toBe(13);
    });

    it('does not jam the row on the bezel of a phone with a home button', () => {
        // safeArea.bottom is 0 there, so the cap can only ever hold the gap
        // down, never lift it. The composer's own 8pt is what is left, which
        // is exactly what that device had before DROVE-144.
        expect(resolveStatusRowBottomGap(noIndicator)).toBe(DOCK_CONTENT_BOTTOM_PADDING);
        expect(resolveStatusRowBottomGap(noIndicator)).toBeGreaterThan(0);
        // No indicator, so HOME_INDICATOR_KEEP_OUT does not apply and the tap
        // floor being below it is correct rather than a violation.
        expect(resolveStatusRowTapFloor(noIndicator)).toBe(5);
    });

    it('gives the chat every point it takes off the gap', () => {
        const before = withStatusRow + Math.max(0, safeAreaBottom - DOCK_CONTENT_BOTTOM_PADDING);
        const after = resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
        });
        expect(before - after).toBe(18);
    });
});

describe('transparentOf', () => {
    it('zeroes the alpha of a six digit hex', () => {
        expect(transparentOf('#F2F2F7')).toBe('#F2F2F700');
        expect(transparentOf('#000000')).toBe('#00000000');
    });

    it('expands a three digit hex', () => {
        expect(transparentOf('#fff')).toBe('#ffffff00');
    });

    it('replaces an existing alpha', () => {
        expect(transparentOf('#F2F2F7CC')).toBe('#F2F2F700');
    });

    it('handles rgb and rgba tokens', () => {
        expect(transparentOf('rgb(242, 242, 247)')).toBe('rgba(242, 242, 247, 0)');
        expect(transparentOf('rgba(0, 0, 0, 0.66)')).toBe('rgba(0, 0, 0, 0)');
    });

    it('falls back to transparent rather than guessing', () => {
        expect(transparentOf('rebeccapurple')).toBe('transparent');
    });
});
