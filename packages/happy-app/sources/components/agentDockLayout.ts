/**
 * Geometry for the floating composer dock on the portrait phone chat.
 *
 * Three numbers have to agree or the strip at the bottom of the chat goes
 * wrong (DROVE-113):
 *
 *  - where the dock's frame sits above the screen edge,
 *  - how much height the inverted chat list reserves at its visual bottom,
 *  - how tall the opaque backdrop behind the dock has to be.
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

/** Height of the fade from the chat into the opaque dock backdrop. */
export const DOCK_SCRIM_FADE_HEIGHT = 28;

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

/** Unchanged by DROVE-144. Kept here so the whole touch box reads in one place. */
export const STATUS_ROW_TAP_SLOP_TOP = 12;

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
 * The opaque backdrop covers the dock and the gap below it, plus a fade above
 * so chat scrolling into it does not hit a hard edge.
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
