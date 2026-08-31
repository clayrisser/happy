/**
 * Geometry for the floating composer dock on the portrait phone chat.
 *
 * Three numbers have to agree or the strip at the bottom of the chat goes
 * wrong (DROVE-113):
 *
 *  - where the dock's frame sits above the screen edge,
 *  - how much height the inverted chat list reserves at its visual bottom,
 *  - how much of the transcript is masked out under the composer.
 *
 * They drifted apart twice before. DROVE-82 put the status row inside the
 * dock and DROVE-88 mounted the gate overlay inside it at `bottom: '100%'`,
 * deliberately outside the measured box. The overlay exclusion is correct:
 * an absolutely positioned child adds no height, so the list must not
 * reserve room for it. What was NOT correct is the bottom gap. AgentInput's
 * own container already carries 8pt under the status row, and the dock frame
 * then sat a full safe-area inset above the screen edge on top of that, so
 * the strip under the status row measured safeArea.bottom + 8 with nothing
 * painted in it.
 *
 * DROVE-144 is the next step and it is a DECISION, not a bug fix. After
 * DROVE-113 the gap was exactly safeArea.bottom, 34pt on Clay's handset, and
 * DROVE-111 re-measured and found nothing left to delete by accident. Clay
 * asked a third time for the space, so the dock now moves INTO the home
 * indicator's reservation and keeps only as much of it as the status row's
 * tap targets need. See `statusRowBottomClearance` for how the number is
 * derived; do not put it back to `safeAreaBottom` because it "should be the
 * safe area".
 */

/**
 * Padding AgentInput's outer container already keeps under the status row.
 * Mirrors `stylesheet.container.paddingBottom` in AgentInput.tsx.
 */
export const DOCK_CONTENT_BOTTOM_PADDING = 8;

/**
 * The painted backdrop's ramp on Android and web, and why the number is 32
 * (DROVE-168, kept where it still applies).
 *
 * DROVE-168 derived 32 like this, and the derivation is still right for a
 * PAINTED backdrop. The transcript's tallest ordinary line box is 24pt
 * (`MarkdownView`'s paragraph and list rows); code is 20pt. Below one line box
 * a line goes from full strength to nothing across less than its own height,
 * which reads as a clip rather than a fade. 32 is one and a third body lines
 * and the smallest multiple of the app's 8pt grid that clears one.
 *
 * What DROVE-180 changed is WHERE it applies. Android and web have no Liquid
 * Glass: `resolveGlassChromeMaterial` returns `fallback` there, so the dock is
 * a flat surface and the transcript really does have to be painted out before
 * it reaches one. iOS 26 has the material, and on iOS the transcript now runs
 * behind it at full strength instead. So this constant stayed on the platforms
 * that still paint, and the iOS mask no longer uses it.
 */
export const DOCK_SCRIM_FADE_HEIGHT = 32;

/**
 * The iOS mask, inverted from DROVE-168 (DROVE-180).
 *
 * Clay, twice: "let the text go behind my liquid glass here", then an hour
 * later "they should be faded out by the time they get here". DROVE-168 took
 * the second sentence as the rule and masked the transcript's own alpha to
 * NOTHING over the 32pt above the composer, so the only thing ever behind the
 * glass was the page background. DROVE-171 then found the glass had no edge
 * over black and raised the tint to give it one. Both followed from the same
 * misreading, and the shape of the mistake is visible in the result: glass
 * over nothing is a grey slab.
 *
 * Clay, on seeing it: "Also I told you already that we should SEE behind the
 * chat right?" The transcript passes BEHIND the composer and is visible
 * THROUGH it, blurred and refracted, the way content shows through a Liquid
 * Glass tab bar in any iOS 26 app. DROVE-113's original complaint, chat text
 * legible straight through a weak scrim, is answered by the material being
 * real (DROVE-153) rather than by hiding the content.
 *
 * WHY 0.4 AND NOT 1. The ticket's first instinct is full alpha, and the only
 * thing standing against it is the other requirement on the same ticket: every
 * composer control stays legible with light and dark content behind it, by
 * DROVE-153's measured method. Measured, that is a ceiling on this number, not
 * a matter of taste. A composer button glyph sits on the transcript, then the
 * card's glass tint, then its own (`chromeGlassTint`, both). Worst case is a
 * white code block under a white glyph on the dark theme:
 *
 *   alpha  dark glyph   light glyph
 *   0.40   3.17:1       4.79:1
 *   0.42   3.03:1       4.52:1     <- the last step that clears 3:1
 *   0.50   2.53:1       3.57:1
 *   1.00   1.00:1       1.00:1     <- white on white
 *
 * So 0.42 is the ceiling and 0.4 is it on a round number with a step of room.
 * It is a PESSIMISTIC bound: it models `UIGlassEffect` as a plain translucent
 * tint, and the real `regular` material also blurs, desaturates and clamps
 * what it samples, all of which can only help. The point of holding the
 * pessimistic bound is that legibility does not then depend on a private
 * Apple adaptation that changes between releases.
 *
 * At 0.4 a white code block reads as rgb(144, 144, 144) through the composer:
 * plainly there, plainly behind glass, and not competing with the controls.
 * That is what Clay asked to see. It is nowhere near DROVE-168's zero.
 */
export const TRANSCRIPT_GLASS_ALPHA = 0.4;

/**
 * The short ramp where the transcript meets the capsule's top edge.
 *
 * DROVE-168's 32pt ramp was measured against a LINE BOX, because its job was
 * to have no legible text anywhere near the glass; that is why it had to clear
 * the tallest thing the transcript could draw. This one is measured against
 * the MATERIAL EDGE, which is what DROVE-180 asks for. Its only job is that a
 * line of text does not change strength on a hard boundary at the capsule's
 * rim, so it is sized to the rim rather than to the text: 12pt is half a body
 * line box and half the bubble's drawn 22pt corner (DROVE-196), which is
 * enough for the eye to read the change as the glass beginning rather than as
 * an edge.
 *
 * It ends at `TRANSCRIPT_GLASS_ALPHA`, not at zero. That is the difference
 * between this and the thing it replaces.
 */
export const TRANSCRIPT_EDGE_SOFTEN_HEIGHT = 12;

/**
 * The one band that is still cleared, and it is not the composer.
 *
 * Everything from the strip's top edge DOWN is the DROVE-82 status row, its
 * 8pt of container padding, and the gap over the home indicator. That strip
 * has no material of its own: it is 11pt text drawn straight onto the dock's
 * transparent frame.
 *
 * DROVE-196 put the control row between the card and this band and did NOT
 * widen the band for it, which is the deliberate half. Every control on that
 * row carries its own glass (the `+`'s chrome button, the mode/effort/model
 * capsule, the audio capsule), so it has the material this band exists for the
 * lack of. The transcript runs behind the gaps between them at
 * TRANSCRIPT_GLASS_ALPHA, which is a floating dock over a chat and is the
 * thing DROVE-144 and DROVE-180 were buying back. Content behind bare text is not "seen through", it
 * is noise, and 11pt `textSecondary` (#8E8E93 on BOTH themes) does not clear
 * 3:1 even against its own page today, so there is no alpha that would make it
 * safe. The real fix for the strip is a material of its own, which is the
 * composer surface work (DROVE-176/178), not this ticket.
 *
 * So the clear band shrank from the WHOLE dock to just this strip: 36pt at the
 * very bottom edge on Clay's handset, against 156 before. The composer
 * capsule itself, the part he is actually looking at, is see-through.
 *
 * Measured from the screen edge up, the same landmarks
 * `STATUS_ROW_TAP_SLOP_TOP` lists:
 *
 *   0..13   the home indicator.
 *   16      the status text's bottom (`resolveStatusRowBottomGap`).
 *   36      the composer card's bottom edge, over the row's 6pt paddingTop.
 */
export function resolveStatusStripBandHeight(safeAreaBottom: number): number {
    return resolveStatusRowBottomGap(safeAreaBottom) + STATUS_ROW_ROW_HEIGHT;
}

/**
 * The ramp OUT of that clear band, back up to the glass alpha.
 *
 * Same length as the top one and for the same reason: it lands on the bottom
 * edge of the composer's furniture, which is the control row since DROVE-196
 * and was the card's rim before it. It is the last place a ramp still reaches zero in this file, and
 * it reaches zero because what is below it is bare text, not because anything
 * above it needed hiding.
 */
export const TRANSCRIPT_STRIP_SOFTEN_HEIGHT = 12;

/**
 * The home indicator's own strip, measured from the screen edge up.
 *
 * The bar is 5pt tall and drawn 8pt above the bottom edge, so it and its
 * margin own the bottom 13pt. That is the landmark a thumb avoids and the
 * band a downward-drifting touch turns into a system swipe. Nothing tappable
 * goes inside it. This is NOT the same as `safeArea.bottom`, which is 34pt:
 * the extra 21pt is Apple padding the reservation, not the indicator.
 */
export const HOME_INDICATOR_KEEP_OUT = 13;

/**
 * How far the status row's segments extend their touch area below their text
 * (`hitSlop.bottom` in AgentInputStatusRow). Doubles as the air between the
 * 11pt text and the top of the indicator, which is why the row's visible
 * bottom and its tap floor are one subtraction apart.
 *
 * It was 14 before DROVE-144, which is what forced the gap to be at least
 * 27pt for the targets to stay clear. Trading 11pt of downward reach for 18pt
 * of chat is the deal this ticket takes: the segments go from a 40pt touch
 * height to 29pt, still roughly three times the height of the text they sit
 * on. If they turn out fiddly in the hand, raise THIS constant rather than
 * padding the dock, because the gap follows it.
 */
export const STATUS_ROW_TAP_SLOP_BOTTOM = 3;

/**
 * How far a segment reaches ABOVE its text.
 *
 * DROVE-153 raised this from 12 to 14, which is every point there was, and the
 * arithmetic is worth keeping because it is the answer to "can the 44pt target
 * be won back upward" and the answer is no. Measured from the screen edge up
 * on Clay's handset:
 *
 *   0..13   the home indicator. Nothing tappable (HOME_INDICATOR_KEEP_OUT).
 *   13      the segments' tap floor, exactly on the indicator's top edge.
 *   16      the status text's bottom (STATUS_ROW_BOTTOM_CLEARANCE).
 *   30      the status text's top: 11pt type in a 14pt line box.
 *   36      the strip's top edge, over the row's 6pt paddingTop.
 *   44      the composer's buttons start, 8pt above the strip.
 *
 * DROVE-196 moved the controls OUT of the card and every one of those numbers
 * held, because the card's 8pt bottom padding became an 8pt gap under the
 * control row (COMPOSER_CONTROLS_BOTTOM_GAP). What is at 44 is now the control
 * row itself rather than the card's last inch; the bubble's bottom rim is at
 * 94, another 44 of row and 6 of gap above it.
 *
 * So a segment can reach 44 before it is drawing its touch area over buttons
 * that are themselves 44pt tall. 44 - 13 is a 31pt box, and 14 above the text
 * is every point of it. Reaching a 44pt box needs to top out at 57, which is
 * 13pt inside those buttons.
 *
 * Every other route costs the same 13pt. Taking it below costs it out of
 * DROVE-144's 18pt reclaim, because STATUS_ROW_BOTTOM_CLEARANCE is derived from
 * STATUS_ROW_TAP_SLOP_BOTTOM point for point. Moving the row above the composer
 * costs 20. There is no slack anywhere in the stack: a 44pt box for this row is
 * 13pt of chat, whichever end it is taken from.
 *
 * SO IT IS 31, NOT 44, AND THAT IS A CHOICE. Clay asked for the bottom space
 * three times and these segments are status TEXT, not the chrome buttons he
 * photographed; every one of those is drawn at 44 or larger now. To take the
 * other side of the trade, raise STATUS_ROW_TAP_SLOP_BOTTOM from 3 to 16: the
 * gap below the row goes 16 -> 29 and the segments become 44pt tall.
 */
export const STATUS_ROW_TAP_SLOP_TOP = 14;

/**
 * The 11pt status text's line box. Not a style, a measurement: the touch box's
 * height is derived from it, so the derivation cannot silently drift.
 */
export const STATUS_ROW_TEXT_LINE_HEIGHT = 14;

/** What a status row segment actually answers a touch on, top to bottom. */
export const STATUS_ROW_TAP_HEIGHT = STATUS_ROW_TAP_SLOP_TOP
    + STATUS_ROW_TEXT_LINE_HEIGHT
    + STATUS_ROW_TAP_SLOP_BOTTOM;

/** The row's own box: its 6pt top padding over the text's line. Mirrors AgentInputStatusRow. */
export const STATUS_ROW_ROW_HEIGHT = 6 + STATUS_ROW_TEXT_LINE_HEIGHT;

/**
 * The last inert band between the status row and a control that must not lose
 * presses to it. Mirrors `MOBILE_COMPOSER_METRICS.controlsBottomGap`.
 *
 * It was the composer card's own bottom padding, because the controls were
 * inside the card. DROVE-196 took them out; the band is the same 8pt doing the
 * same job from the other side of the card's edge, and it was renamed rather
 * than deleted precisely so that this arithmetic could not be dropped on the
 * way. `resolveComposerButtonFloor` still reads 44 from the screen edge and
 * STATUS_ROW_TAP_SLOP_TOP is still 14 because of it.
 */
export const COMPOSER_CONTROLS_BOTTOM_GAP = 8;

/**
 * How far above the screen edge the composer's own buttons start, which is the
 * ceiling on how far a status row segment may reach up.
 */
export function resolveComposerButtonFloor(safeAreaBottom: number): number {
    return resolveStatusRowBottomGap(safeAreaBottom)
        + STATUS_ROW_ROW_HEIGHT
        + COMPOSER_CONTROLS_BOTTOM_GAP;
}

/**
 * The gap we want under the status row on a phone that HAS a home indicator:
 * the indicator's strip, plus the segments' downward reach, and nothing else.
 *
 * The tap targets therefore stop exactly where the indicator starts, and the
 * text stops `STATUS_ROW_TAP_SLOP_BOTTOM` above that. 16pt, against the 34pt
 * the safe area asks for.
 */
export const STATUS_ROW_BOTTOM_CLEARANCE =
    HOME_INDICATOR_KEEP_OUT + STATUS_ROW_TAP_SLOP_BOTTOM;

/**
 * Distance from the screen edge to the dock frame's bottom, keyboard closed.
 *
 * Two clauses, and the second is the DROVE-144 one:
 *
 *  - the composer's own bottom padding counts toward the clearance instead of
 *    stacking on top of it (DROVE-113), so the gap is never padding + inset;
 *  - the gap is then capped at `STATUS_ROW_BOTTOM_CLEARANCE`, so a phone with
 *    a home indicator gives 18 of its 34 reserved points back to the chat.
 *
 * It is a `min`, never a flat subtraction, and that is what makes both device
 * shapes work. A phone with a home BUTTON reports `safeAreaBottom` 0, so the
 * first clause is already 0 and the cap cannot lift it: the gap stays the 8pt
 * of composer padding and the row is not jammed on the bezel. A subtraction
 * would have to special-case that; this does not.
 */
export function resolveDockBottomOffset(safeAreaBottom: number, floatingDock: boolean): number {
    if (!floatingDock) {
        return safeAreaBottom;
    }
    const withoutDoubleCount = Math.max(0, safeAreaBottom - DOCK_CONTENT_BOTTOM_PADDING);
    const capped = Math.max(0, STATUS_ROW_BOTTOM_CLEARANCE - DOCK_CONTENT_BOTTOM_PADDING);
    return Math.min(withoutDoubleCount, capped);
}

/**
 * The empty band Clay can actually see: status row text to screen edge.
 * The composer's padding plus whatever the dock frame keeps under itself.
 */
export function resolveStatusRowBottomGap(safeAreaBottom: number): number {
    return DOCK_CONTENT_BOTTOM_PADDING + resolveDockBottomOffset(safeAreaBottom, true);
}

/**
 * Distance from the screen edge to the LOWEST point any status row segment
 * will answer a touch on. Must not fall inside `HOME_INDICATOR_KEEP_OUT` on a
 * device that has an indicator; on one that does not there is nothing to
 * clear and the composer's 8pt of padding is the whole story.
 */
export function resolveStatusRowTapFloor(safeAreaBottom: number): number {
    return resolveStatusRowBottomGap(safeAreaBottom) - STATUS_ROW_TAP_SLOP_BOTTOM;
}

export interface DockInsetInput {
    /** Measured height of the dock's own box. Excludes the gate overlay. */
    dockHeight: number;
    safeAreaBottom: number;
    floatingDock: boolean;
    /**
     * Extra height the keyboard takes below the dock. iOS moves the dock with
     * a transform instead, so it passes 0 here.
     */
    keyboardInset?: number;
}

/**
 * What the chat list reserves at its visual bottom: the dock's real height
 * from the screen edge up, which is the measured box plus the gap under it.
 */
export function resolveDockInset({
    dockHeight,
    safeAreaBottom,
    floatingDock,
    keyboardInset = 0,
}: DockInsetInput): number {
    if (!floatingDock) {
        return 0;
    }
    return dockHeight + keyboardInset + resolveDockBottomOffset(safeAreaBottom, true);
}

/**
 * How far the transcript is held above the dock at rest.
 *
 * 12pt, the length of the edge ramp (DROVE-180). DROVE-168 held 32 because its
 * ramp took the newest line to NOTHING, so a line parked in the ramp would
 * have been gone at rest and every point of ramp had to be a point the list
 * held clear. This ramp only goes from full to `TRANSCRIPT_GLASS_ALPHA`, but
 * the newest line still should not sit at rest inside a gradient, so the rule
 * survives at the ramp's new length. 20pt of the 24 DROVE-168 spent goes back
 * to the reading area.
 */
export function resolveTranscriptBottomClearance(): number {
    return TRANSCRIPT_EDGE_SOFTEN_HEIGHT;
}

export interface TranscriptMask {
    /** Height of the gradient band, from the top ramp down to the clear band. */
    gradientHeight: number;
    /** Mask colours for that band. A mask reads ALPHA only; the hue is arbitrary. */
    colors: string[];
    /** Stops for those colours, 0 at the top of the band. */
    locations: number[];
    /** The status strip at the very bottom, masked out entirely. */
    clearHeight: number;
}

/**
 * The mask over the transcript, measured from the screen edge up.
 *
 * Four bands, and DROVE-168 had two. Reading DOWN from the top:
 *
 *   full           everything above the composer, untouched.
 *   1 -> 0.4       12pt, landing on the capsule's top rim.
 *   0.4            the whole height of the composer card. THE TICKET.
 *   0.4 -> 0       12pt, landing on the card's bottom rim.
 *   0              the status strip, which has no material of its own.
 *
 * The 0.4 band covers the control row as well as the bubble since DROVE-196,
 * and the lower ramp lands on the row's bottom edge rather than the card's
 * rim. Same 12pt, same job: a line of text must not change strength on a hard
 * boundary.
 *
 * DROVE-168's two bands were a 32pt ramp to zero above the composer and then
 * zero for the whole dock and the gap under it. Everything the composer covers
 * was erased; now everything it covers is visible through it at 0.4, and only
 * the bare strip below the card is erased.
 *
 * Returned as ready-made gradient stops rather than as heights, because three
 * of the four boundaries move with the measured dock and hand-placing them at
 * the call site is how the two sides drift.
 */
export function resolveTranscriptMask(dockHeight: number, safeAreaBottom: number): TranscriptMask {
    if (dockHeight <= 0) {
        return { gradientHeight: 0, colors: [], locations: [], clearHeight: 0 };
    }
    const clearHeight = Math.min(resolveStatusStripBandHeight(safeAreaBottom), dockHeight);
    // The top of the dock's frame, which is where the card's own top edge is.
    const dockTop = dockHeight + resolveDockBottomOffset(safeAreaBottom, true);
    const overStrip = Math.max(0, dockTop - clearHeight);
    const stripSoften = Math.min(TRANSCRIPT_STRIP_SOFTEN_HEIGHT, overStrip);
    const gradientHeight = TRANSCRIPT_EDGE_SOFTEN_HEIGHT + overStrip;
    const glassStop = TRANSCRIPT_EDGE_SOFTEN_HEIGHT / gradientHeight;
    const stripStop = Math.max(glassStop, (gradientHeight - stripSoften) / gradientHeight);
    return {
        gradientHeight,
        colors: [
            'rgba(0, 0, 0, 1)',
            `rgba(0, 0, 0, ${TRANSCRIPT_GLASS_ALPHA})`,
            `rgba(0, 0, 0, ${TRANSCRIPT_GLASS_ALPHA})`,
            'rgba(0, 0, 0, 0)',
        ],
        locations: [0, glassStop, stripStop, 1],
        clearHeight,
    };
}

/** Alpha at `distance` points above the composer card's top edge. */
export function transcriptAlphaAboveGlass(distance: number): number {
    if (distance >= TRANSCRIPT_EDGE_SOFTEN_HEIGHT) {
        return 1;
    }
    if (distance <= 0) {
        return TRANSCRIPT_GLASS_ALPHA;
    }
    const t = distance / TRANSCRIPT_EDGE_SOFTEN_HEIGHT;
    return TRANSCRIPT_GLASS_ALPHA + (1 - TRANSCRIPT_GLASS_ALPHA) * t;
}

/**
 * Android and web keep a painted backdrop rather than a mask.
 *
 * The material only exists on iOS 26. `resolveGlassChromeMaterial` returns
 * `fallback` everywhere else, so there is no glass for the transcript to run
 * behind and nothing to see through; a flat dock over live text is the
 * DROVE-113 bug. They keep DROVE-168's full 32pt ramp over the chat's own
 * surface, which is where that derivation still holds (DROVE-180).
 */
export function resolveDockScrimHeight(dockHeight: number, safeAreaBottom: number): number {
    if (dockHeight <= 0) {
        return 0;
    }
    return dockHeight + resolveDockBottomOffset(safeAreaBottom, true) + DOCK_SCRIM_FADE_HEIGHT;
}

/**
 * Same colour at zero alpha, for the top stop of the backdrop fade. Theme
 * surfaces are hex today; rgb()/rgba() are handled so a token change cannot
 * silently paint a black fade over a light chat.
 */
export function transparentOf(color: string): string {
    const value = color.trim();
    if (value.startsWith('#')) {
        const digits = value.slice(1);
        if (digits.length === 3) {
            const expanded = digits.split('').map((d) => d + d).join('');
            return `#${expanded}00`;
        }
        if (digits.length === 6) {
            return `#${digits}00`;
        }
        if (digits.length === 8) {
            return `#${digits.slice(0, 6)}00`;
        }
    }
    const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
    if (rgb) {
        const parts = rgb[1].split(',').map((part) => part.trim());
        if (parts.length >= 3) {
            return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, 0)`;
        }
    }
    return 'transparent';
}
