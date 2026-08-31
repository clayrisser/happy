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
 */

/**
 * Padding AgentInput's outer container already keeps under the status row.
 * Mirrors `stylesheet.container.paddingBottom` in AgentInput.tsx.
 */
export const DOCK_CONTENT_BOTTOM_PADDING = 8;

/** Height of the fade from the chat into the opaque dock backdrop. */
export const DOCK_SCRIM_FADE_HEIGHT = 28;

/**
 * Distance from the screen edge to the dock frame's bottom, keyboard closed.
 *
 * The composer's own bottom padding counts toward the home indicator
 * clearance instead of stacking on top of it, so the total gap under the
 * status row is exactly the safe-area inset, never inset + padding.
 */
export function resolveDockBottomOffset(safeAreaBottom: number, floatingDock: boolean): number {
    if (!floatingDock) {
        return safeAreaBottom;
    }
    return Math.max(0, safeAreaBottom - DOCK_CONTENT_BOTTOM_PADDING);
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
