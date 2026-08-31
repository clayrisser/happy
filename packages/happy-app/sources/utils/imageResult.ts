/**
 * When a tool reads an image, the image IS the result, so the transcript shows
 * it instead of a one-line "Read call" row (DROVE-151).
 *
 * Two decisions live here, both pure so both can be specced: whether a result
 * is an image, and how big to draw it. The drawing itself is in
 * components/InlineImage.
 */
import { presentToolResult, type ToolResultPresentation } from './toolResult';

export interface ToolResultImage {
    uri: string;
    mediaType: string;
    /** Natural pixel size when the result reports it. */
    width?: number;
    height?: number;
}

/** What a picture of unknown shape is assumed to be until the file says. */
export const defaultImageAspect = 4 / 3;

function asImage(part: ToolResultPresentation): ToolResultImage | null {
    if (part.kind !== 'image') {
        return null;
    }
    return { uri: part.uri, mediaType: part.mediaType, width: part.width, height: part.height };
}

/**
 * The single image a tool result carries, or null.
 *
 * A mixed result counts: a Read of a png comes back as the file's header line
 * plus the picture, and the picture is what Clay is scrolling for. Two or more
 * images do not, because the row has one slot and showing the first would hide
 * the rest; those stay in the detail screen, where they stack.
 */
export function toolResultImage(result: unknown): ToolResultImage | null {
    // Every row in the transcript asks this, and a plain string is never a
    // picture. Answering here skips a JSON.parse attempt per Bash result.
    if (typeof result === 'string') {
        return null;
    }
    const presentation = presentToolResult(result);
    if (presentation.kind === 'image') {
        return asImage(presentation);
    }
    if (presentation.kind === 'mixed') {
        const images: ToolResultImage[] = [];
        for (const part of presentation.parts) {
            const image = asImage(part);
            if (image) {
                images.push(image);
            }
        }
        return images.length === 1 ? images[0] : null;
    }
    return null;
}

/** Width over height, falling back when the file did not report a usable size. */
export function imageAspect(width?: number, height?: number): number {
    if (typeof width === 'number' && typeof height === 'number'
        && Number.isFinite(width) && Number.isFinite(height)
        && width > 0 && height > 0) {
        return width / height;
    }
    return defaultImageAspect;
}

export interface ImageBox {
    width: number;
    height: number;
}

export interface ImageDisplayOptions {
    /** The message column, measured. Zero until the first layout pass. */
    containerWidth: number;
    aspect: number;
    /** So a tall screenshot does not swallow the scroll. */
    maxHeight: number;
    /** Natural width, so a 32px icon is not blown up to the whole column. */
    maxWidth?: number;
}

/**
 * The box the picture is drawn in. The box IS the picture's shape, and that is
 * what kills the black bars: the old card set width 100% AND a max height AND
 * contentFit contain, so anything taller than the cap got letterboxed into the
 * leftover width (DROVE-151).
 *
 * Null when there is nothing sane to draw yet, so the caller renders no frame
 * rather than an empty one.
 */
export function imageDisplaySize(options: ImageDisplayOptions): ImageBox | null {
    const aspect = Number.isFinite(options.aspect) && options.aspect > 0
        ? options.aspect
        : defaultImageAspect;
    const maxHeight = options.maxHeight;
    if (!Number.isFinite(maxHeight) || maxHeight <= 0) {
        return null;
    }
    let width = options.containerWidth;
    if (typeof options.maxWidth === 'number' && Number.isFinite(options.maxWidth) && options.maxWidth > 0) {
        width = Math.min(width, options.maxWidth);
    }
    if (!Number.isFinite(width) || width <= 0) {
        return null;
    }
    let height = width / aspect;
    if (height > maxHeight) {
        height = maxHeight;
        width = height * aspect;
    }
    return { width, height };
}
