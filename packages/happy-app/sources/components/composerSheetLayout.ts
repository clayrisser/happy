/**
 * How tall ComposerSheet's body is, kept out of the component so it can be
 * tested without reanimated or gesture-handler (DROVE-158, DROVE-201).
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
 * fits, the cap once it does not.
 *
 * What DROVE-158 left behind was the cap itself. It was 320, or 400 for the
 * pickers, or 70% of the window, whichever was smallest, so a sheet with more
 * content than that stopped part way up and scrolled the rest. Clay, twice:
 * "you still don't have the sheet slide up to as much as what content is
 * inside of them... it should only become scrollable when the sheet has filled
 * up the whole screen."
 *
 * So the cap is the screen now. Not a number anyone picked, and not a share of
 * the window: what is actually left after the status bar, the grabber and the
 * home indicator. A sheet is exactly its content until its content runs out of
 * screen, and only then does it scroll.
 */

/** The grabber block: 10pt over the 4pt bar, 4pt under it. */
export const composerSheetGrabberHeight = 18;

/** The strip below the body that clears the home indicator. */
export function composerSheetFooterHeight(safeAreaBottom: number): number {
    return safeAreaBottom + 8;
}

/**
 * Measurement comes back in device pixels divided by the scale, so a sheet
 * whose content is exactly the cap can report 320.33. Half a point is not a
 * reason to turn a fitted sheet into a scrolling one.
 */
const tolerance = 0.5;

/**
 * Never a sliver. A window this small is a split view or a test, and a body
 * of a few points is worse than one that overhangs.
 */
const floor = 120;

/** What the sheet has to fit inside. */
export type ComposerSheetWindow = {
    windowHeight: number;
    /** The status bar. The sheet's top corners stop under it, never behind it. */
    safeAreaTop: number;
    /** The home indicator, which the footer strip clears. */
    safeAreaBottom: number;
};

/**
 * The tallest the BODY may be on this window: everything the sheet is not
 * already spending on its own furniture or on a safe area.
 */
export function composerSheetCap(input: ComposerSheetWindow): number {
    const usable = input.windowHeight
        - input.safeAreaTop
        - composerSheetGrabberHeight
        - composerSheetFooterHeight(input.safeAreaBottom);
    return Math.max(floor, Math.round(usable));
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
    /** Whether the content is genuinely longer than the screen allows. */
    scrolls: boolean;
};

/**
 * Given what the children measured, how tall the body is and whether it
 * scrolls. `contentHeight` is null until the first layout; the sheet is parked
 * offscreen for that frame, so a cap is the safe guess and nobody sees it.
 */
export function composerSheetBody(input: ComposerSheetWindow & {
    contentHeight: number | null;
}): ComposerSheetBody {
    const cap = composerSheetCap(input);
    if (input.contentHeight === null || input.contentHeight <= 0) {
        return { cap, height: undefined, scrolls: false };
    }
    const scrolls = input.contentHeight - cap > tolerance;
    return { cap, height: scrolls ? cap : input.contentHeight, scrolls };
}

/**
 * How far the keyboard lifts the sheet, in the transform's units: negative is
 * up, and 0 is the sheet sitting on the bottom edge.
 *
 * The sheet rides the keyboard rather than hiding behind it, which was free
 * while every sheet was under 70% of the window. A full height sheet has no
 * room to rise into, and lifting it anyway would carry the grabber and the top
 * corners off the top of the screen. So the lift stops at whatever slack is
 * left above the sheet. A worklet, because the animated style asks on the UI
 * thread.
 */
export function composerSheetLift(input: {
    /** react-native-keyboard-controller's height, negative while the keyboard is up. */
    keyboardHeight: number;
    windowHeight: number;
    safeAreaTop: number;
    sheetHeight: number;
}): number {
    'worklet';
    const slack = Math.max(0, input.windowHeight - input.safeAreaTop - input.sheetHeight);
    return Math.max(input.keyboardHeight, -slack);
}
