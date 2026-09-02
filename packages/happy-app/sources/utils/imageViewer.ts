/**
 * What the full screen viewer draws, decided outside the component so a spec
 * can read both answers (DROVE-366).
 *
 * Clay, tapping a picture on a Read call row: "Why are images not showing when
 * I click on this?" Two unrelated faults produced the same black screen, which
 * is why they are answered together here.
 *
 * The SIZE. The viewer handed expo-image `width: '100%'` inside a stage whose
 * own width was auto: that stage sat under `alignItems: 'center'`, so Yoga
 * sized it to its content, and its content was a percentage OF that width. The
 * circle resolves to zero, so the picture was laid out zero wide and the screen
 * was the backdrop and nothing else. The box is measured from the window now
 * and passed as numbers, so there is no percentage left to round to nothing.
 *
 * The SOURCE. A picture the phone cannot reach opened onto the same empty
 * frame, indistinguishable from the layout fault. Now it says so in one
 * fragment, and the close control is drawn either way.
 */

export interface ImageViewerBox {
    width: number;
    height: number;
}

/**
 * The box the picture is drawn in: the whole window, with `contentFit` doing
 * the letterboxing.
 *
 * Null when the window has not been measured yet, which is the point. A null
 * box draws NO image rather than a zero-sized one, so the state that produced
 * the black screen is now a state the component cannot render.
 */
export function imageViewerStage(window: { width: number; height: number }): ImageViewerBox | null {
    const { width, height } = window;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }
    if (width <= 0 || height <= 0) {
        return null;
    }
    return { width, height };
}

/** One fragment, because there is nothing to explain and nothing to retry. */
export const imageViewerEmptyMessage = 'Not on this phone';

export type ImageViewerContent =
    | { kind: 'image'; uri: string }
    | { kind: 'empty'; message: string };

/**
 * The picture, or the reason there isn't one.
 *
 * A blank or whitespace uri is the same as none: expo-image draws nothing for
 * it, and drawing nothing is what this exists to stop.
 */
export function imageViewerContent(uri: string | null | undefined): ImageViewerContent {
    if (typeof uri !== 'string' || uri.trim().length === 0) {
        return { kind: 'empty', message: imageViewerEmptyMessage };
    }
    return { kind: 'image', uri };
}
