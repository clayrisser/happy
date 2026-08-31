import { describe, expect, it } from 'vitest';
import {
    anchoredScrollOffset,
    collapseFromFooter,
    disclosureState,
    footerCollapseAnchorY,
    showsDisclosureFooter,
    toggleDisclosure,
} from './inlineDisclosure';

const header = { id: 'header' };

describe('showsDisclosureFooter', () => {
    it('an expanded block draws a collapse row at its end', () => {
        expect(showsDisclosureFooter(disclosureState(true))).toBe(true);
        expect(showsDisclosureFooter(toggleDisclosure(disclosureState(false)))).toBe(true);
    });

    it('a collapsed block draws nothing at its end', () => {
        expect(showsDisclosureFooter(disclosureState(false))).toBe(false);
        expect(showsDisclosureFooter(toggleDisclosure(disclosureState(true)))).toBe(false);
    });
});

describe('collapseFromFooter', () => {
    it('closes the block it belongs to', () => {
        const next = collapseFromFooter(disclosureState(true), header, -400, 600);
        expect(next.expanded).toBe(false);
    });

    it('closes even when neither row can be measured', () => {
        expect(collapseFromFooter(disclosureState(true), header, null, null).expanded).toBe(false);
        expect(collapseFromFooter(disclosureState(true), null, -400, 600).expanded).toBe(false);
    });

    it('asks for the header to land where the footer was', () => {
        const next = collapseFromFooter(disclosureState(true), header, -400, 600);
        expect(next.anchor).toEqual({ node: header, y: 600 });
    });

    it('leaves the transcript alone when the header is still on screen', () => {
        expect(collapseFromFooter(disclosureState(true), header, 120, 600).anchor).toBeNull();
    });

    it('carries no anchor from a header press', () => {
        expect(toggleDisclosure(disclosureState(true)).anchor).toBeNull();
    });
});

describe('footerCollapseAnchorY', () => {
    it('rescues a header that has scrolled off the top', () => {
        expect(footerCollapseAnchorY(-1200, 640)).toBe(640);
    });

    it('does nothing for a header sitting at or below the top edge', () => {
        expect(footerCollapseAnchorY(0, 640)).toBeNull();
        expect(footerCollapseAnchorY(200, 640)).toBeNull();
    });

    it('does nothing when a measurement is missing or nonsense', () => {
        expect(footerCollapseAnchorY(null, 640)).toBeNull();
        expect(footerCollapseAnchorY(-100, null)).toBeNull();
        expect(footerCollapseAnchorY(Number.NaN, 640)).toBeNull();
        expect(footerCollapseAnchorY(-100, Number.NaN)).toBeNull();
    });
});

describe('anchoredScrollOffset', () => {
    it('lands the header on its mark after the block shrinks', () => {
        // Header was tracked to y=600 (where the footer was) and layout left it
        // at y=180, so the inverted list has to give back the 420 difference.
        expect(anchoredScrollOffset(2000, 600, 180)).toBe(2420);
    });

    it('never scrolls past the newest message', () => {
        expect(anchoredScrollOffset(10, 100, 900)).toBe(0);
    });

    it('holds still for sub-pixel movement', () => {
        expect(anchoredScrollOffset(2000, 600, 600.2)).toBeNull();
    });

    it('holds still when the row cannot be measured', () => {
        expect(anchoredScrollOffset(2000, 600, Number.NaN)).toBeNull();
    });
});
