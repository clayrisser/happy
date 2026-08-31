/**
 * How tall ComposerSheet's body is, kept out of the component so it can be
 * tested without reanimated or gesture-handler (DROVE-158).
 *
 * DROVE-147 gave every composer sheet one shell and put a scroll view inside
 * it with nothing but a `maxHeight`. That is right for the agent tree and the
 * quota list, which are longer than the screen wants to give them. It was
 * wrong for Add context, which is a heading and three tiles: an unbounded
 * scroll view inside an auto-height card is free to settle at whatever height
 * it measured first, so the tiles came back sliced through their labels with
 * dead space under them, and the scroll hid the difference. Clay: "Then why is
 * this the scrollable section".
 *
 * So the body is never left to size itself. The children are measured, and the
 * scroll view is given an EXPLICIT height: the content's own height while it
 * fits, the cap once it does not. A short sheet is exactly its content and
 * does not scroll; a long one scrolls and the cap still holds.
 */

/**
 * Tall enough for the current account's three windows plus five accounts at
 * 20pt a row, or for a dozen agents, and short enough that the transcript is
 * still there behind it. Past that the content scrolls, which is the point: a
 * sixth account or a thirteenth agent is reachable instead of pushing the
 * sheet off the top of the screen.
 */
export const composerSheetMaxHeight = 320;

/** The sheet never eats the transcript entirely, however long the content is. */
export const composerSheetMaxHeightFraction = 0.7;

/**
 * Measurement comes back in device pixels divided by the scale, so a sheet
 * whose content is exactly the cap can report 320.33. Half a point is not a
 * reason to turn a fitted sheet into a scrolling one.
 */
const tolerance = 0.5;

/** The tallest this sheet is allowed to be on this window. */
export function composerSheetCap(input: { maxHeight?: number; windowHeight: number }): number {
    return Math.min(
        input.maxHeight ?? composerSheetMaxHeight,
        Math.round(input.windowHeight * composerSheetMaxHeightFraction),
    );
}

export type ComposerSheetBody = {
    /** The tallest the body may be. */
    cap: number;
    /**
     * What to put on the scroll view's `height`, or undefined for the one
     * frame before the children have laid out. Explicit, because a scroll
     * view left to size itself inside an auto-height card is what clipped the
     * tiles in the first place.
     */
    height: number | undefined;
    /** Whether the content is genuinely longer than the sheet may be. */
    scrolls: boolean;
};

/**
 * Given what the children measured, how tall the body is and whether it
 * scrolls. `contentHeight` is null until the first layout; the sheet is parked
 * offscreen for that frame, so a cap is the safe guess and nobody sees it.
 */
export function composerSheetBody(input: {
    contentHeight: number | null;
    maxHeight?: number;
    windowHeight: number;
}): ComposerSheetBody {
    const cap = composerSheetCap(input);
    if (input.contentHeight === null || input.contentHeight <= 0) {
        return { cap, height: undefined, scrolls: false };
    }
    const scrolls = input.contentHeight - cap > tolerance;
    return { cap, height: scrolls ? cap : input.contentHeight, scrolls };
}
