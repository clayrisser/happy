import { describe, expect, it } from 'vitest';
import {
    DOCK_CONTENT_BOTTOM_PADDING,
    DOCK_SCRIM_FADE_HEIGHT,
    TRANSCRIPT_EDGE_SOFTEN_HEIGHT,
    TRANSCRIPT_GLASS_ALPHA,
    TRANSCRIPT_STRIP_SOFTEN_HEIGHT,
    resolveStatusStripBandHeight,
    resolveTranscriptBottomClearance,
    resolveTranscriptMask,
    transcriptAlphaAboveGlass,
    HOME_INDICATOR_KEEP_OUT,
    STATUS_ROW_BOTTOM_CLEARANCE,
    STATUS_ROW_TAP_SLOP_BOTTOM,
    STATUS_ROW_TAP_SLOP_TOP,
    STATUS_ROW_TAP_HEIGHT,
    STATUS_ROW_ROW_HEIGHT,
    STATUS_ROW_TEXT_LINE_HEIGHT,
    COMPOSER_CONTROLS_BOTTOM_GAP,
    resolveComposerButtonFloor,
    resolveDockBottomOffset,
    resolveDockInset,
    resolveDockScrimHeight,
    resolveStatusRowBottomGap,
    resolveStatusRowTapFloor,
    resolveTranscriptBottomScrim,
    transparentOf,
} from './agentDockLayout';
import { MOBILE_COMPOSER_BASE_HEIGHT, MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import { COMPOSER_STRIP_HEIGHT } from './composerStripLayout';

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
        // than asserted. The segments' ceiling is the composer's own buttons:
        // a touch area drawn over those would take presses off controls that
        // are themselves at the floor. DROVE-196 moved those buttons out of
        // the card and the ceiling did not move, because the card's bottom
        // padding became the row's bottom gap.
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

describe('seeing the transcript through the glass (DROVE-180, inverting DROVE-168)', () => {
    const safeAreaBottom = 34;
    const dockBottomOffset = resolveDockBottomOffset(safeAreaBottom, true);
    const dockHeight = 148;
    const mask = resolveTranscriptMask(dockHeight, safeAreaBottom);
    /** Alpha at a stop, read back off the mask colours the component is handed. */
    const alphaAt = (index: number) => Number(mask.colors[index].match(/([\d.]+)\)$/)![1]);

    //
    // DROVE-168's specs are inverted here rather than deleted. Its numbers
    // were right for what it thought it was building, and what changed is the
    // intent, so each case below names the one it replaces.
    //

    it('leaves the transcript visible behind the composer instead of erasing it', () => {
        // WAS: "takes the transcript to nothing exactly at the glass edge",
        // alpha 0 at the glass and 0 for the whole dock below it. Clay: "we
        // should SEE behind the chat". The material is what makes the text
        // illegible; erasing it first is what made the composer a grey slab.
        expect(TRANSCRIPT_GLASS_ALPHA).toBeGreaterThan(0);
        expect(alphaAt(1)).toBe(TRANSCRIPT_GLASS_ALPHA);
        expect(alphaAt(2)).toBe(TRANSCRIPT_GLASS_ALPHA);
    });

    it('holds the alpha at the ceiling DROVE-153’s method puts on it', () => {
        // Not taste, and not 1 either. A composer glyph sits on the
        // transcript, then the card's glass tint, then its own; the worst case
        // is a white code block under a white glyph on the dark theme, and
        // that stack clears 3:1 up to 0.42 and no further. 0.4 is that with a
        // step of room. glassChrome.test.ts does the arithmetic.
        expect(TRANSCRIPT_GLASS_ALPHA).toBe(0.4);
        expect(TRANSCRIPT_GLASS_ALPHA).toBeLessThanOrEqual(0.42);
    });

    it('softens onto the capsule rim over 12pt and stops well above zero', () => {
        // WAS: a 32pt ramp, sized to the tallest line box (24pt), because it
        // had to leave nothing legible near the glass. This one is sized to
        // the rim it lands on, which is the DROVE-180 instruction: measure the
        // softening against the material's edge, not against legibility.
        expect(TRANSCRIPT_EDGE_SOFTEN_HEIGHT).toBe(12);
        expect(TRANSCRIPT_EDGE_SOFTEN_HEIGHT).toBeLessThan(24);
        expect(transcriptAlphaAboveGlass(TRANSCRIPT_EDGE_SOFTEN_HEIGHT)).toBe(1);
        expect(transcriptAlphaAboveGlass(TRANSCRIPT_EDGE_SOFTEN_HEIGHT + 40)).toBe(1);
        expect(transcriptAlphaAboveGlass(0)).toBe(TRANSCRIPT_GLASS_ALPHA);
        expect(transcriptAlphaAboveGlass(-8)).toBe(TRANSCRIPT_GLASS_ALPHA);
    });

    it('rises monotonically away from the glass and never touches zero', () => {
        let previous = -1;
        for (let d = -8; d <= TRANSCRIPT_EDGE_SOFTEN_HEIGHT + 8; d += 1) {
            const alpha = transcriptAlphaAboveGlass(d);
            expect(alpha).toBeGreaterThanOrEqual(previous);
            expect(alpha).toBeGreaterThanOrEqual(TRANSCRIPT_GLASS_ALPHA);
            previous = alpha;
        }
    });

    it('clears only the status strip, not the whole dock', () => {
        // WAS: clearHeight === dockHeight + dockBottomOffset, "so no scroll
        // position leaves anything legible underneath the composer". The card
        // is glass and can be seen through. The strip under it is bare 11pt
        // text with no material, so it is the one band left.
        expect(mask.clearHeight).toBe(resolveStatusStripBandHeight(safeAreaBottom));
        expect(mask.clearHeight).toBeLessThan(dockHeight + dockBottomOffset);
        // 36pt on Clay's handset, against 156 before.
        expect(mask.clearHeight).toBe(36);
        expect(dockHeight + dockBottomOffset).toBe(156);
    });

    it('puts the strip band exactly at the composer’s bottom edge', () => {
        // The same landmarks STATUS_ROW_TAP_SLOP_TOP lists: 16pt to the status
        // text's bottom, 20 more for the row's box, 36 to the strip's top.
        // Below the control row since DROVE-196, below the card before it, and
        // the same 36 either way.
        expect(resolveStatusStripBandHeight(safeAreaBottom))
            .toBe(resolveStatusRowBottomGap(safeAreaBottom) + STATUS_ROW_ROW_HEIGHT);
        expect(resolveStatusStripBandHeight(safeAreaBottom))
            .toBe(resolveComposerButtonFloor(safeAreaBottom) - COMPOSER_CONTROLS_BOTTOM_GAP);
    });

    it('never lets the clear band reach past the dock that was measured', () => {
        const shortDock = 20;
        expect(resolveTranscriptMask(shortDock, safeAreaBottom).clearHeight).toBe(shortDock);
    });

    it('spans the gradient from 12pt above the card down to the strip', () => {
        expect(mask.gradientHeight + mask.clearHeight)
            .toBe(dockHeight + dockBottomOffset + TRANSCRIPT_EDGE_SOFTEN_HEIGHT);
    });

    it('reads full, glass, glass, clear, in that order and monotonically', () => {
        expect(mask.colors).toHaveLength(4);
        expect(mask.locations).toHaveLength(4);
        expect(alphaAt(0)).toBe(1);
        expect(alphaAt(3)).toBe(0);
        for (let i = 1; i < mask.locations.length; i += 1) {
            expect(mask.locations[i]).toBeGreaterThanOrEqual(mask.locations[i - 1]);
            expect(alphaAt(i)).toBeLessThanOrEqual(alphaAt(i - 1));
        }
        expect(mask.locations[0]).toBe(0);
        expect(mask.locations[3]).toBe(1);
    });

    it('puts the two ramps on the card’s own two rims', () => {
        const topRamp = mask.locations[1] * mask.gradientHeight;
        const bottomRamp = (1 - mask.locations[2]) * mask.gradientHeight;
        expect(topRamp).toBeCloseTo(TRANSCRIPT_EDGE_SOFTEN_HEIGHT, 6);
        expect(bottomRamp).toBeCloseTo(TRANSCRIPT_STRIP_SOFTEN_HEIGHT, 6);
    });

    it('keeps DROVE-168’s 32pt derivation for the platforms with no material', () => {
        // Android and web have no Liquid Glass, so the dock is a flat surface
        // and the transcript really does have to be painted out before it
        // reaches one. The derivation still holds THERE: one and a third body
        // line boxes, on the 8pt grid.
        expect(DOCK_SCRIM_FADE_HEIGHT).toBe(32);
        expect(DOCK_SCRIM_FADE_HEIGHT).toBeGreaterThan(24);
        expect(DOCK_SCRIM_FADE_HEIGHT % 8).toBe(0);
    });

    it('draws no mask before the dock has been measured', () => {
        expect(resolveTranscriptMask(0, safeAreaBottom))
            .toEqual({ gradientHeight: 0, colors: [], locations: [], clearHeight: 0 });
    });

    it('gives 20 of DROVE-168’s 24pt of reading area back', () => {
        // WAS: resolveTranscriptBottomClearance() === 32, "every point of ramp
        // is a point the list has to hold clear", because a line parked in
        // that ramp would have been gone. This ramp only reaches 0.4, but a
        // newest line still should not rest inside a gradient, so the rule
        // survives at the ramp's new length.
        expect(resolveTranscriptBottomClearance()).toBe(TRANSCRIPT_EDGE_SOFTEN_HEIGHT);
        expect(32 - resolveTranscriptBottomClearance()).toBe(20);
    });
});

/**
 * WHAT THE MOVE DID TO EVERYTHING THAT HANGS OFF THE DOCK (DROVE-236).
 *
 * Clay asked for the control row nearer the bubble; the first pass moved it up
 * by 5 and he came back with the composer marked up in red: the row goes INTO
 * the bubble and there is nothing under it. Four other lanes read the geometry
 * that row sat in, and this is the check that none of them needs a line
 * changing, done by resolving them at both heights rather than by reasoning
 * about it.
 *
 *   148   DROVE-214's composer, with the row and a 9pt bubble floor
 *   143   the first pass: the floor gives 5 back, the row comes up by it
 *    93   this pass: the row is inside the bubble and the block is the
 *         bubble plus the gap over the status strip
 */
describe('the bottom row moves into the bubble and nothing else moves', () => {
    const safeAreaBottom = 34;
    const beforeAll = 148;
    const before = 143;
    const after = MOBILE_COMPOSER_BASE_HEIGHT;

    it('shortens the composer by 50, which is the row and the gap above it', () => {
        expect(after).toBe(93);
        expect(before - after).toBe(50);
        expect(beforeAll - after).toBe(55);
        // The 50 is exactly the row's height plus the one gap that held it off
        // the bubble. Nothing came out of the bubble itself: it is 85 on both
        // sides of the move.
        expect(before - after)
            .toBe(MOBILE_COMPOSER_METRICS.actionRowHeight + MOBILE_COMPOSER_METRICS.controlGap);
    });

    it('takes the bottom fade with it, still equal to what the list reserves', () => {
        // DROVE-219 hangs the fade off the dock's MEASURED height, an
        // `onLayout` on the dock rather than this constant, and returns
        // `resolveDockInset` itself, so the two cannot drift. Both move by the
        // 50 with nothing edited, and the overhang under the dock does not
        // move at all.
        //
        // The one thing that WOULD have broken it is moving a control out of
        // the measured box. Nothing moved out: the row moved further in.
        const scrimBefore = resolveTranscriptBottomScrim(before, safeAreaBottom);
        const scrimAfter = resolveTranscriptBottomScrim(after, safeAreaBottom);
        expect(scrimBefore.height - scrimAfter.height).toBe(50);
        expect(scrimAfter.overhang).toBe(scrimBefore.overhang);
        expect(scrimAfter.height).toBe(resolveDockInset({
            dockHeight: after,
            safeAreaBottom,
            floatingDock: true,
        }));
        expect(scrimAfter.visible).toBe(true);
    });

    it('leaves the recording band at 20pt, where DROVE-221 pinned it', () => {
        // The band is `STATUS_ROW_ROW_HEIGHT` and its padding is `controlGap`.
        // The move spent neither: the row did not shrink, it changed parent.
        expect(COMPOSER_STRIP_HEIGHT).toBe(20);
        expect(COMPOSER_STRIP_HEIGHT).toBe(STATUS_ROW_ROW_HEIGHT);
    });

    it('leaves the clear band and the tap floor exactly where they were', () => {
        // Both are derived from `safeAreaBottom` and `controlsBottomGap`, and
        // `controlsBottomGap` changed owner rather than value: it was the
        // control row's `marginBottom` and it is the composer line's. So a
        // shorter composer cannot reach them.
        expect(resolveStatusStripBandHeight(safeAreaBottom)).toBe(36);
        expect(resolveComposerButtonFloor(safeAreaBottom)).toBe(44);
        expect(resolveTranscriptMask(before, safeAreaBottom).clearHeight)
            .toBe(resolveTranscriptMask(after, safeAreaBottom).clearHeight);
        expect(resolveStatusRowTapFloor(safeAreaBottom)).toBe(HOME_INDICATOR_KEEP_OUT);
    });

    it('gains the strip 4pt of clearance under the nearest button', () => {
        // The floor says where the composer's controls START above the screen
        // edge, and it is unchanged at 44. What changed is what is AT it: the
        // control row's 44pt buttons filled the row down to its own rim, so
        // the strip's 14pt of upward tap slop stopped exactly at a button.
        // The bubble's discs stop `bubbleInsetBottom` short of the bubble's
        // rim, so the nearest button is now 4pt above the same floor.
        expect(resolveComposerButtonFloor(safeAreaBottom)
            + MOBILE_COMPOSER_METRICS.bubbleInsetBottom).toBe(48);
        expect(MOBILE_COMPOSER_METRICS.bubbleInsetBottom).toBe(4);
    });

    it('gives the 50pt to the transcript, which is the point of it', () => {
        const gradientBefore = resolveTranscriptMask(before, safeAreaBottom).gradientHeight;
        const gradientAfter = resolveTranscriptMask(after, safeAreaBottom).gradientHeight;
        expect(gradientBefore - gradientAfter).toBe(50);
    });
});
