/**
 * Keeping the transcript's scroll indicator off the controls it draws over
 * (DROVE-156).
 *
 * Clay's screenshot: an agent card reading "Running · 36s" with its collapse
 * chevron hard against the right edge, and the scroll indicator painted
 * straight across the chevron. The indicator stays, he reads his position in a
 * long transcript from it, so the controls move instead.
 *
 * One constant, derived from what the platform actually draws, rather than a
 * different magic number per component.
 */

/** The bar iOS and Android paint: about 3pt wide. */
export const scrollIndicatorWidth = 3;

/** How far in from the edge that bar sits. */
export const scrollIndicatorEdgeGap = 2;

/**
 * The lane a right-edge control has to stay out of: the bar, the gap it sits
 * in, and the same gap again on the inside so the two do not touch.
 */
export const scrollIndicatorClearance = scrollIndicatorWidth + scrollIndicatorEdgeGap * 2;

/**
 * The extra padding a row needs on its right. A row already inset past the
 * lane (a card with its own margin, say) needs nothing, and padding it further
 * would only shove its chevron inward for no reason.
 */
export function edgeClearance(existingInset = 0): number {
    if (!Number.isFinite(existingInset) || existingInset < 0) return scrollIndicatorClearance;
    return Math.max(0, scrollIndicatorClearance - existingInset);
}

/** HIG's floor for anything a thumb has to hit. */
export const minTapTarget = 44;

/**
 * The hit slop a row of this height needs to reach that floor. Touch area
 * only: the row keeps the height the transcript's density was tuned for
 * (DROVE-153 is auditing the visual sizes separately).
 */
export function tapSlopFor(rowHeight: number): number {
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return Math.ceil(minTapTarget / 2);
    return Math.max(0, Math.ceil((minTapTarget - rowHeight) / 2));
}
