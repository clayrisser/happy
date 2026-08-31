import { describe, expect, it } from 'vitest';
import {
    DOCK_CONTENT_BOTTOM_PADDING,
    DOCK_SCRIM_FADE_HEIGHT,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveDockScrimHeight,
    transparentOf,
} from './agentDockLayout';

// Measured on the iPhone the DROVE-113 screenshot came from: composer card,
// the DROVE-82 status row under it, AgentInput's 8pt container padding, and a
// 34pt home indicator inset.
const composerOnly = 116;
const withStatusRow = composerOnly + 24;
const safeAreaBottom = 34;

describe('resolveDockBottomOffset', () => {
    it('spends the composer padding inside the safe area instead of on top of it', () => {
        expect(resolveDockBottomOffset(safeAreaBottom, true)).toBe(
            safeAreaBottom - DOCK_CONTENT_BOTTOM_PADDING,
        );
    });

    it('never goes negative on a device with no home indicator', () => {
        expect(resolveDockBottomOffset(0, true)).toBe(0);
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
        // The gap under the status row is the home indicator inset exactly,
        // not the inset plus AgentInput's own padding.
        expect(resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
        })).toBe(withStatusRow + 26);
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

    it('is unchanged by an open keyboard on the translating platform', () => {
        expect(resolveDockInset({
            dockHeight: withStatusRow,
            safeAreaBottom,
            floatingDock: true,
            keyboardInset: 0,
        })).toBe(withStatusRow + 26);
    });
});

describe('resolveDockScrimHeight', () => {
    it('covers the dock, the gap under it, and the fade above it', () => {
        expect(resolveDockScrimHeight(withStatusRow, safeAreaBottom))
            .toBe(withStatusRow + 26 + DOCK_SCRIM_FADE_HEIGHT);
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
