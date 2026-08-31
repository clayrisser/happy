import { describe, expect, it } from 'vitest';
import {
    MOBILE_GLASS_CONTROL_SIZE,
    MOBILE_HEADER_EDGE_INSET,
    MOBILE_HEADER_SLOT_CONTENT_PADDING,
    MOBILE_TITLE_PILL_GAP,
    resolveHeaderSlotBox,
    resolveHeaderSlotPadding,
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

describe('the header row is one shape (DROVE-202)', () => {
    // Clay: "Why is this button not fully rounded matching the dimensions of
    // the back button". The avatar already filled a 44pt box; 8pt of padding a
    // side drew it 60 wide, so a stadium sat beside a disc.
    it('draws a lone control square, at the back chevron\'s diameter', () => {
        expect(resolveHeaderSlotBox({ kind: 'control', contentWidth: MOBILE_GLASS_CONTROL_SIZE }))
            .toEqual({ width: MOBILE_GLASS_CONTROL_SIZE, height: MOBILE_GLASS_CONTROL_SIZE });
    });

    it('matches the back button exactly, which is the thing being compared', () => {
        const backButton = { width: MOBILE_GLASS_CONTROL_SIZE, height: MOBILE_GLASS_CONTROL_SIZE };
        expect(resolveHeaderSlotBox({ kind: 'control', contentWidth: MOBILE_GLASS_CONTROL_SIZE }))
            .toEqual(backButton);
    });

    it('gives a content payload its air, so the file view keeps its capsule', () => {
        expect(resolveHeaderSlotPadding('content')).toBe(MOBILE_HEADER_SLOT_CONTENT_PADDING);
        expect(resolveHeaderSlotBox({ kind: 'content', contentWidth: 120 }))
            .toEqual({ width: 120 + MOBILE_HEADER_SLOT_CONTENT_PADDING * 2, height: MOBILE_GLASS_CONTROL_SIZE });
    });

    it('never draws a slot under the chrome floor', () => {
        for (const contentWidth of [0, 12, 28, MOBILE_GLASS_CONTROL_SIZE, 96]) {
            for (const kind of ['control', 'content'] as const) {
                const box = resolveHeaderSlotBox({ kind, contentWidth });
                expect(box.width).toBeGreaterThanOrEqual(MOBILE_GLASS_CONTROL_SIZE);
                expect(box.height).toBe(MOBILE_GLASS_CONTROL_SIZE);
            }
        }
    });
});
