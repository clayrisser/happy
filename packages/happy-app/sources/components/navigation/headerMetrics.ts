export const MOBILE_GLASS_HEADER_HEIGHT = 52;
export const MOBILE_GLASS_CONTROL_SIZE = 44;
export const MOBILE_GLASS_CONTROL_RADIUS = MOBILE_GLASS_CONTROL_SIZE / 2;

/** Clear air between the title pill and the control on either side of it. */
export const MOBILE_TITLE_PILL_GAP = 12;

/**
 * How far the outermost header controls sit in from the screen edges.
 *
 * The row carries this as margins on the controls rather than as padding on
 * itself, because the title pill is positioned absolutely inside that row and
 * Yoga and CSS disagree about whether an absolute child's `left` counts the
 * parent's padding. With no padding to argue over, the pill's inset and the
 * controls' positions are measured from the same origin (DROVE-133).
 */
export const MOBILE_HEADER_EDGE_INSET = 16;

/**
 * How far in from both edges the title pill is allowed to reach.
 *
 * The same inset on both sides, so the pill stays centred on the header rather
 * than on whatever space the controls happen to leave. It clears the wider of
 * the two controls, which is the only one that can be run into: the right one
 * carries a variable payload and is measured, the left is a fixed-size button.
 *
 * The edge inset is part of it. Leaving it out is what made the pill overlap
 * both neighbours by 2pt at 393pt, which is the "no padding" Clay photographed.
 */
export function resolveTitlePillInset({
    leftControlWidth,
    rightControlWidth,
    gap = MOBILE_TITLE_PILL_GAP,
    edgeInset = MOBILE_HEADER_EDGE_INSET,
}: {
    leftControlWidth: number;
    rightControlWidth: number;
    gap?: number;
    edgeInset?: number;
}): number {
    const widest = Math.max(leftControlWidth, rightControlWidth);
    // Nothing to clear on either side means nothing to hold the gap off, so the
    // pill reaches the same edge inset the controls would have used.
    return edgeInset + (widest > 0 ? widest + gap : 0);
}
