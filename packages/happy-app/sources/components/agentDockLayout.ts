/**
 * Geometry for the floating composer dock on the portrait phone chat.
 *
 * Three numbers have to agree or the strip at the bottom of the chat goes
 * wrong (DROVE-113):
 *
 *  - where the dock's frame sits above the screen edge,
 *  - how much height the inverted chat list reserves at its visual bottom,
 *  - how far the transcript is faded before it reaches the composer.
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
 * How tall the transcript's fade is, and why it is this number (DROVE-168).
 *
 * Clay: "Honestly let the text go behind my liquid glass here. But they should
 * be faded out by the time they get here." That reverses part of DROVE-113 on
 * purpose. DROVE-113 made the dock opaque because chat text stayed legible
 * through a 66% scrim and read as a bug; the composer is real Liquid Glass now
 * (DROVE-153), and a solid slab of `groupped.background` painted behind it is
 * the thing that made it look flat.
 *
 * The fade replaces that slab. It runs on the TRANSCRIPT, not on the dock:
 * `AgentContentView.ios.tsx` masks the chat's own alpha to nothing over this
 * band, so the last line dissolves instead of being covered, and the material
 * keeps the real screen behind it. That distinction is the whole point. An
 * opacity on the dock is what killed the material the first time.
 *
 * 32pt, and the length is the ticket. The transcript's tallest ordinary line
 * box is 24pt (`MarkdownView`'s paragraph and list rows); code is 20pt. The
 * floor is one line box: below that a line goes from full strength to nothing
 * across less than its own height, which reads as a clip rather than a fade,
 * and Clay would be looking at text colliding with the glass edge. The ceiling
 * is the reading area, because the two are the same number. The list has to
 * hold the newest line above the ramp or it sits dimmed at rest, so every
 * point of fade is a point of transcript. 32 is one and a third body lines,
 * one and three fifths of a code line, and the smallest multiple of the app's
 * 8pt grid that clears a body line.
 *
 * It costs 24pt: the list used to keep 8pt over the dock and now keeps 32.
 * On a portrait phone that is about 4% of the visible chat, one line of body
 * text, paid once at the bottom.
 */
export const TRANSCRIPT_FADE_HEIGHT = 32;

/**
 * The ramp's shape, top of the band down to the glass edge.
 *
 * Eased, and eased the opposite way from the obvious guess. The temptation is
 * to collapse the alpha early so nothing survives anywhere near the glass, but
 * that only drags the dimming up into the part of the band the eye is reading.
 * What actually has to hold is narrower: nothing at all at the glass edge, and
 * no line cut off at full strength on its way there.
 *
 * So the ramp holds 88% a quarter of the way in, is at 62% halfway, and spends
 * its last quarter falling from 30% to nothing. A 24pt body line whose
 * baseline sits exactly on the edge dissolves from 88% at its cap height to
 * zero at its baseline, across its own height, which is what a fade looks
 * like. Under one line box the same line would go from full strength to
 * nothing over a third of itself, which is what a clip looks like, and that is
 * the floor the length is set by.
 */
export const TRANSCRIPT_FADE_ALPHAS = [1, 0.88, 0.62, 0.3, 0] as const;
export const TRANSCRIPT_FADE_LOCATIONS = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * The same stops as a mask gradient. A mask reads ALPHA only, so the colour is
 * arbitrary and the alphas are the whole content. Spelled out rather than
 * mapped so the tuple survives into `LinearGradient`'s props; a test keeps it
 * honest against `TRANSCRIPT_FADE_ALPHAS`.
 */
export const TRANSCRIPT_FADE_MASK_COLORS = [
    'rgba(0, 0, 0, 1)',
    'rgba(0, 0, 0, 0.88)',
    'rgba(0, 0, 0, 0.62)',
    'rgba(0, 0, 0, 0.3)',
    'rgba(0, 0, 0, 0)',
] as const;

/** Alpha at `distance` points above the glass edge. Linear between stops. */
export function transcriptFadeAlphaAbove(distance: number): number {
    const t = 1 - Math.min(Math.max(distance / TRANSCRIPT_FADE_HEIGHT, 0), 1);
    for (let i = 1; i < TRANSCRIPT_FADE_LOCATIONS.length; i += 1) {
        const from = TRANSCRIPT_FADE_LOCATIONS[i - 1];
        const to = TRANSCRIPT_FADE_LOCATIONS[i];
        if (t <= to) {
            const span = to - from;
            const ratio = span === 0 ? 0 : (t - from) / span;
            return TRANSCRIPT_FADE_ALPHAS[i - 1]
                + (TRANSCRIPT_FADE_ALPHAS[i] - TRANSCRIPT_FADE_ALPHAS[i - 1]) * ratio;
        }
    }
    return TRANSCRIPT_FADE_ALPHAS[TRANSCRIPT_FADE_ALPHAS.length - 1];
}

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
 *   36      the composer card's bottom edge, over the row's 6pt paddingTop.
 *   44      the card's own buttons start, 8pt inside it (shellPaddingBottom).
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
 * What the composer card keeps under its own button row. Mirrors
 * `MOBILE_COMPOSER_METRICS.shellPaddingBottom`, and it is the last inert band
 * between the status row and a control that must not lose presses to it.
 */
export const COMPOSER_CARD_BOTTOM_PADDING = 8;

/**
 * How far above the screen edge the composer's own buttons start, which is the
 * ceiling on how far a status row segment may reach up.
 */
export function resolveComposerButtonFloor(safeAreaBottom: number): number {
    return resolveStatusRowBottomGap(safeAreaBottom)
        + STATUS_ROW_ROW_HEIGHT
        + COMPOSER_CARD_BOTTOM_PADDING;
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
 * How far the transcript has to be held above the screen edge so its newest
 * line is never sitting inside the ramp at rest.
 *
 * This replaces the flat 8pt gap the list used to keep over the dock. It is
 * the ramp's full height rather than the ramp plus a gap: the band already
 * reads as air, so adding a gap on top of it would spend the reading area
 * twice.
 */
export function resolveTranscriptBottomClearance(): number {
    return TRANSCRIPT_FADE_HEIGHT;
}

/**
 * The mask over the transcript, measured from the screen edge up.
 *
 * `clearHeight` is everything from the glass edge down, the dock and the gap
 * under it, and it is masked to nothing. That is what DROVE-113 was
 * protecting: no scroll position leaves anything legible under the composer.
 * `fadeHeight` is the ramp sitting directly on top of it.
 */
export function resolveTranscriptMask(dockHeight: number, safeAreaBottom: number): {
    fadeHeight: number;
    clearHeight: number;
} {
    if (dockHeight <= 0) {
        return { fadeHeight: 0, clearHeight: 0 };
    }
    return {
        fadeHeight: TRANSCRIPT_FADE_HEIGHT,
        clearHeight: dockHeight + resolveDockBottomOffset(safeAreaBottom, true),
    };
}

/**
 * Android and web keep a painted backdrop rather than a mask.
 *
 * The material only exists on iOS 26. `resolveGlassChromeMaterial` returns
 * `fallback` everywhere else, so there is no glass for the transcript to run
 * behind and nothing to gain from masking a list on those platforms. They get
 * the same ramp length so the two paths cannot drift, over the chat's own
 * surface so the band is invisible against it.
 */
export function resolveDockScrimHeight(dockHeight: number, safeAreaBottom: number): number {
    if (dockHeight <= 0) {
        return 0;
    }
    return dockHeight + resolveDockBottomOffset(safeAreaBottom, true) + TRANSCRIPT_FADE_HEIGHT;
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
