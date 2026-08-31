import { describe, expect, it } from 'vitest';
import {
    MOBILE_GLASS_CONTROL_SIZE,
    MOBILE_HEADER_EDGE_INSET,
    MOBILE_TITLE_PILL_GAP,
    resolveTitlePillInset,
} from './headerMetrics';

describe('resolveTitlePillInset', () => {
    it('clears the back button by the full gap', () => {
        expect(resolveTitlePillInset({
            leftControlWidth: MOBILE_GLASS_CONTROL_SIZE,
            rightControlWidth: MOBILE_GLASS_CONTROL_SIZE,
        })).toBe(MOBILE_HEADER_EDGE_INSET + MOBILE_GLASS_CONTROL_SIZE + MOBILE_TITLE_PILL_GAP);
    });

    // The right control carries a variable payload. Growing it must move the
    // title, not let the title run underneath it.
    it('follows the wider control on both sides so the pill stays centred', () => {
        const inset = resolveTitlePillInset({
            leftControlWidth: MOBILE_GLASS_CONTROL_SIZE,
            rightControlWidth: 96,
        });
        expect(inset).toBe(MOBILE_HEADER_EDGE_INSET + 96 + MOBILE_TITLE_PILL_GAP);
    });

    it('falls back to the edge inset when there is no control to clear', () => {
        expect(resolveTitlePillInset({
            leftControlWidth: 0,
            rightControlWidth: 0,
        })).toBe(MOBILE_HEADER_EDGE_INSET);
    });

    // The regression Clay photographed: the controls start at the edge inset,
    // so an inset that ignores it puts the pill 2pt underneath both of them.
    it('never overlaps a control laid out at the edge inset', () => {
        const widths = [0, 12, MOBILE_GLASS_CONTROL_SIZE, 88, 140];
        for (const leftControlWidth of widths) {
            for (const rightControlWidth of widths) {
                const inset = resolveTitlePillInset({ leftControlWidth, rightControlWidth });
                const leftControlEnd = MOBILE_HEADER_EDGE_INSET + leftControlWidth;
                const rightControlEnd = MOBILE_HEADER_EDGE_INSET + rightControlWidth;
                expect(inset).toBeGreaterThanOrEqual(leftControlEnd);
                expect(inset).toBeGreaterThanOrEqual(rightControlEnd);
            }
        }
    });

    it('holds the full gap next to whichever control is present', () => {
        const inset = resolveTitlePillInset({
            leftControlWidth: MOBILE_GLASS_CONTROL_SIZE,
            rightControlWidth: 0,
        });
        expect(inset - (MOBILE_HEADER_EDGE_INSET + MOBILE_GLASS_CONTROL_SIZE))
            .toBe(MOBILE_TITLE_PILL_GAP);
    });

    // A 393pt screen with a back button and an avatar: the pill has to fit
    // between them rather than push either one off the edge.
    it('leaves the pill a real width at 393pt with both controls present', () => {
        const inset = resolveTitlePillInset({
            leftControlWidth: MOBILE_GLASS_CONTROL_SIZE,
            rightControlWidth: MOBILE_GLASS_CONTROL_SIZE,
        });
        expect(393 - inset * 2).toBeGreaterThan(200);
    });
});
