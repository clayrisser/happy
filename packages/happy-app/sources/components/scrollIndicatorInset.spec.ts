import { describe, expect, it } from 'vitest';
import {
    edgeClearance,
    minTapTarget,
    scrollIndicatorClearance,
    scrollIndicatorEdgeGap,
    scrollIndicatorWidth,
    tapSlopFor,
} from './scrollIndicatorInset';

describe('scrollIndicatorClearance', () => {
    it('comes from the indicator, not from a number someone liked', () => {
        expect(scrollIndicatorClearance).toBe(scrollIndicatorWidth + scrollIndicatorEdgeGap * 2);
    });

    it('is wider than the bar it has to clear', () => {
        expect(scrollIndicatorClearance).toBeGreaterThan(scrollIndicatorWidth);
    });
});

describe('edgeClearance', () => {
    it('pads a control sitting flush against the edge', () => {
        expect(edgeClearance(0)).toBe(scrollIndicatorClearance);
        expect(edgeClearance()).toBe(scrollIndicatorClearance);
    });

    it('tops up a control that is only part of the way clear', () => {
        expect(edgeClearance(3)).toBe(scrollIndicatorClearance - 3);
    });

    it('leaves an already-inset row alone', () => {
        expect(edgeClearance(16)).toBe(0);
        expect(edgeClearance(scrollIndicatorClearance)).toBe(0);
    });

    it('treats a nonsense inset as no inset at all', () => {
        expect(edgeClearance(Number.NaN)).toBe(scrollIndicatorClearance);
        expect(edgeClearance(-4)).toBe(scrollIndicatorClearance);
    });
});

describe('tapSlopFor', () => {
    it('brings a short transcript row up to the HIG floor', () => {
        expect(24 + tapSlopFor(24) * 2).toBeGreaterThanOrEqual(minTapTarget);
        expect(28 + tapSlopFor(28) * 2).toBeGreaterThanOrEqual(minTapTarget);
        expect(32 + tapSlopFor(32) * 2).toBeGreaterThanOrEqual(minTapTarget);
    });

    it('adds nothing to a row that already clears it', () => {
        expect(tapSlopFor(44)).toBe(0);
        expect(tapSlopFor(60)).toBe(0);
    });

    it('falls back to half the floor when the height is unknown', () => {
        expect(tapSlopFor(0)).toBe(22);
        expect(tapSlopFor(Number.NaN)).toBe(22);
    });
});
