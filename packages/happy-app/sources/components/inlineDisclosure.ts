/**
 * Closing an expanded block from its END (DROVE-150).
 *
 * Clay expanded a RAW JSON block, read several screens of it, and then had to
 * scroll all the way back up past what he had just read to reach the only
 * chevron. Where he actually is when he decides he is done is the BOTTOM, so
 * an open block grows a matching collapse row there.
 *
 * The rules live here, away from React, because the same three of them apply
 * to every inline disclosure in the transcript and the fiddly one (where the
 * virtualised list lands afterwards) is worth being able to test.
 */

/** A row's identity plus where it sat on screen before the layout moved. */
export interface DisclosureAnchor<Node = unknown> {
    node: Node;
    y: number;
}

export interface DisclosureState<Node = unknown> {
    expanded: boolean;
    /** Carried for exactly one layout pass after a footer collapse. */
    anchor: DisclosureAnchor<Node> | null;
}

export function disclosureState<Node = unknown>(expanded = false): DisclosureState<Node> {
    return { expanded, anchor: null };
}

/** The footer exists only while the block is open. Nothing to close otherwise. */
export function showsDisclosureFooter(state: { expanded: boolean }): boolean {
    return state.expanded === true;
}

/** A header press flips the block and claims no scroll anchor. */
export function toggleDisclosure<Node>(state: DisclosureState<Node>): DisclosureState<Node> {
    return { expanded: !state.expanded, anchor: null };
}

/**
 * A header already on screen needs no rescue, and dragging the transcript for
 * a block that fits in the viewport is the jarring part. So only re-anchor
 * when the header has scrolled off the top, and land it on the footer's own
 * screen position, which is where the finger already is.
 */
export function footerCollapseAnchorY(headerY: number | null, footerY: number | null): number | null {
    if (headerY === null || footerY === null) return null;
    if (!Number.isFinite(headerY) || !Number.isFinite(footerY)) return null;
    if (headerY >= 0) return null;
    return footerY;
}

/** A footer press closes the block, and asks for the header to stay in sight. */
export function collapseFromFooter<Node>(
    state: DisclosureState<Node>,
    header: Node | null,
    headerY: number | null,
    footerY: number | null,
): DisclosureState<Node> {
    const y = footerCollapseAnchorY(headerY, footerY);
    if (header === null || y === null) {
        return { expanded: false, anchor: null };
    }
    return { expanded: false, anchor: { node: header, y } };
}

/**
 * Where an inverted list has to sit so an anchored row lands back on its mark.
 * `null` means the row barely moved and scrolling would only add a jitter.
 */
export function anchoredScrollOffset(offsetY: number, anchorY: number, nextY: number): number | null {
    if (!Number.isFinite(nextY)) return null;
    const adjustment = anchorY - nextY;
    if (Math.abs(adjustment) < 0.5) return null;
    return Math.max(0, offsetY + adjustment);
}
