/**
 * A flexbox resolver, so a spec can MEASURE what a style tree lays out to
 * instead of restating the arithmetic that produced it (DROVE-214).
 *
 * Clay, after three passes on the composer that each shipped a green suite
 * over a visibly broken control: "Why don't you use layout system for these
 * things?" The composer does now. This is the other half of that — the tests
 * have to read the layout system too, because what went wrong every time was
 * that the spec asserted a MODEL of the geometry while the renderer's own
 * stylesheet quietly did something else. A `position: absolute` pin lived in
 * AgentInput.tsx and no spec could see it, so the discs hung 10.7pt below the
 * bubble's centre through three "correct" rounds.
 *
 * It covers exactly the subset the composer uses: row and column, padding, gap,
 * fixed and percentage sizes, `flex: 1`, `minHeight`/`maxHeight`, and the two
 * cross-axis alignments. Anything outside that throws rather than guessing,
 * because a resolver that silently approximates is the same failure again.
 *
 * Checked against Yoga, the engine React Native actually runs, in
 * `flexFrames.spec.ts`.
 */

export interface FlexStyle {
    flexDirection?: 'row' | 'column';
    alignItems?: 'center' | 'stretch';
    justifyContent?: 'flex-start';
    flex?: number;
    flexShrink?: number;
    width?: number | '100%';
    height?: number | '100%';
    minHeight?: number;
    maxHeight?: number;
    padding?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    gap?: number;
    borderRadius?: number;
}

export interface FlexNode {
    name: string;
    style: FlexStyle;
    /**
     * What a leaf measures at, when nothing in the style fixes it. The text
     * row's is the only one that varies, which is the entire reason the
     * composer had a layout bug.
     */
    intrinsicHeight?: number;
    children?: FlexNode[];
}

export interface FlexFrame {
    name: string;
    /** Absolute, from the root's top-left. */
    x: number;
    y: number;
    width: number;
    height: number;
    children: FlexFrame[];
}

const supported = new Set([
    'flexDirection', 'alignItems', 'justifyContent', 'flex', 'flexShrink',
    'width', 'height', 'minHeight', 'maxHeight',
    'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'gap', 'borderRadius',
]);

/**
 * Refuses anything the resolver does not model, INCLUDING every positional
 * property. A hand-placed offset is what this exists to catch, so it must not
 * be quietly ignored.
 */
function assertSupported(node: FlexNode): void {
    const style = node.style as Record<string, unknown>;
    for (const key of Object.keys(style)) {
        if (style[key] === undefined) continue;
        if (!supported.has(key)) {
            throw new Error(
                `flexFrames: "${node.name}" carries an unmodelled style "${key}". `
                + 'Positional properties are refused on purpose: the composer places '
                + 'nothing by hand (DROVE-214).',
            );
        }
    }
    for (const child of node.children ?? []) assertSupported(child);
}

function padding(style: FlexStyle) {
    const all = style.padding ?? 0;
    return {
        top: style.paddingTop ?? all,
        bottom: style.paddingBottom ?? all,
        left: style.paddingLeft ?? all,
        right: style.paddingRight ?? all,
    };
}

function clampHeight(style: FlexStyle, height: number): number {
    let out = height;
    if (style.minHeight !== undefined) out = Math.max(out, style.minHeight);
    if (style.maxHeight !== undefined) out = Math.min(out, style.maxHeight);
    return out;
}

/** The height a node wants, given the width it is being laid out at. */
function measureHeight(node: FlexNode, width: number): number {
    if (typeof node.style.height === 'number') return clampHeight(node.style, node.style.height);
    const pad = padding(node.style);
    const children = node.children ?? [];
    if (children.length === 0) {
        return clampHeight(node.style, (node.intrinsicHeight ?? 0) + pad.top + pad.bottom);
    }
    const inner = width - pad.left - pad.right;
    const gap = node.style.gap ?? 0;
    if (node.style.flexDirection === 'row') {
        const tallest = Math.max(...children.map((c) => measureHeight(c, measureWidth(c, inner))));
        return clampHeight(node.style, tallest + pad.top + pad.bottom);
    }
    const stacked = children.reduce((sum, c) => sum + measureHeight(c, measureWidth(c, inner)), 0);
    return clampHeight(node.style, stacked + gap * Math.max(0, children.length - 1) + pad.top + pad.bottom);
}

/**
 * The width a node takes inside `available`.
 *
 * A container with neither a width nor a `flex` sizes to its CONTENT, which is
 * what Yoga does for a flex item whose width is `auto` (DROVE-231). It used to
 * return `available` for that case, which was never exercised: every node in
 * DROVE-214's composer tree carries a width or a flex, so the branch could not
 * fire and the pinned frames are unchanged. The status strip's zones do need
 * it. A zone that is a row of text and glyphs has no width of its own and must
 * not swallow the line.
 *
 * A LEAF with no width still takes `available`. That is the text case, and a
 * leaf's intrinsic width is not something this resolver can measure; the strip
 * hands every text leaf an estimated width instead.
 *
 * The content width is NOT clamped to what is available, because React
 * Native's `flexShrink` defaults to 0 and a row of fixed children therefore
 * OVERFLOWS its parent rather than squeezing into it. Clamping here would say
 * every zone fits at every width, which is the failure mode this resolver
 * exists to catch: the strip's give-way order is driven by exactly this
 * measurement.
 */
function measureWidth(node: FlexNode, available: number): number {
    if (typeof node.style.width === 'number') return node.style.width;
    if (node.style.width === '100%') return available;
    if (node.style.flex !== undefined) return available;
    const children = node.children ?? [];
    if (children.length === 0) return available;
    const pad = padding(node.style);
    const inner = available - pad.left - pad.right;
    if (node.style.flexDirection === 'row') {
        const gap = node.style.gap ?? 0;
        const content = children.reduce(
            (sum, child) => sum + (child.style.flex !== undefined ? 0 : measureWidth(child, inner)),
            0,
        ) + gap * Math.max(0, children.length - 1);
        return content + pad.left + pad.right;
    }
    const widest = Math.max(...children.map((child) => measureWidth(child, inner)));
    return widest + pad.left + pad.right;
}

/**
 * Resolves absolute frames for a style tree at a given width.
 *
 * `height` is optional: without it the root sizes to its content, which is what
 * the composer does.
 */
export function resolveFlexFrames(root: FlexNode, width: number, height?: number): FlexFrame {
    assertSupported(root);
    return place(root, 0, 0, width, height ?? measureHeight(root, width));
}

function place(node: FlexNode, x: number, y: number, width: number, height: number): FlexFrame {
    const frame: FlexFrame = { name: node.name, x, y, width, height, children: [] };
    const children = node.children ?? [];
    if (children.length === 0) return frame;

    const pad = padding(node.style);
    const innerX = x + pad.left;
    const innerY = y + pad.top;
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const gap = node.style.gap ?? 0;
    const row = node.style.flexDirection === 'row';
    const align = node.style.alignItems ?? 'stretch';

    if (row) {
        const fixed = children.map((c) => (
            c.style.flex !== undefined ? null : measureWidth(c, innerW)
        ));
        const used = fixed.reduce<number>((sum, w) => sum + (w ?? 0), 0)
            + gap * Math.max(0, children.length - 1);
        const flexTotal = children.reduce((sum, c) => sum + (c.style.flex ?? 0), 0);
        const spare = Math.max(0, innerW - used);
        let cursor = innerX;
        children.forEach((child, i) => {
            const w = fixed[i] ?? (flexTotal > 0 ? spare * ((child.style.flex ?? 0) / flexTotal) : 0);
            const wants = typeof child.style.height === 'number'
                ? child.style.height
                : measureHeight(child, w);
            const h = align === 'stretch' && child.style.height === undefined ? innerH : wants;
            const childY = align === 'center' ? innerY + (innerH - h) / 2 : innerY;
            frame.children.push(place(child, cursor, childY, w, h));
            cursor += w + gap;
        });
        return frame;
    }

    let cursor = innerY;
    for (const child of children) {
        const w = measureWidth(child, innerW);
        const h = measureHeight(child, w);
        const childX = align === 'center' ? innerX + (innerW - w) / 2 : innerX;
        frame.children.push(place(child, childX, cursor, w, h));
        cursor += h + gap;
    }
    return frame;
}

/**
 * What a node's CONTENT measures at inside `available`, without placing it.
 *
 * The same `measureWidth` the placement pass runs, exported so a caller can
 * ask one subtree's width without resolving the tree it belongs to
 * (DROVE-250). The strip needs that to size the account's truncation cap: the
 * cap is what the centre leaves, and measuring the centre by resolving the
 * whole strip would be circular, because the account leaf is IN that strip.
 *
 * It is the resolver's own measurement, not arithmetic restated beside it,
 * which is the whole reason this module exists.
 */
export function measureFlexWidth(node: FlexNode, available: number): number {
    assertSupported(node);
    return measureWidth(node, available);
}

/** Finds a frame by name anywhere in the tree. */
export function findFrame(frame: FlexFrame, name: string): FlexFrame {
    if (frame.name === name) return frame;
    for (const child of frame.children) {
        const hit = findFrame(child, name);
        if (hit) return hit;
    }
    return undefined as unknown as FlexFrame;
}

/**
 * How far a CIRCLE inscribed in `disc` sits inside a rounded rectangle, in
 * points. Negative means it has escaped the drawn shape.
 *
 * Yoga knows nothing about `borderRadius`, so every frame in a tree can be
 * inside its parent's box while the thing on screen is outside its parent's
 * SHAPE. That is what the corners of Clay's crop show, and it is the one
 * geometric fact a flexbox spec cannot get for free.
 */
export function roundedRectClearance(
    box: { x: number; y: number; width: number; height: number },
    radius: number,
    disc: { x: number; y: number; width: number; height: number },
): number {
    const r = Math.min(radius, box.width / 2, box.height / 2);
    const cx = disc.x + disc.width / 2;
    const cy = disc.y + disc.height / 2;
    const discRadius = Math.min(disc.width, disc.height) / 2;
    // Nearest corner arc centre, clamped so a disc on a straight edge measures
    // against that edge rather than a corner.
    const ax = Math.min(Math.max(cx, box.x + r), box.x + box.width - r);
    const ay = Math.min(Math.max(cy, box.y + r), box.y + box.height - r);
    const dx = cx - ax;
    const dy = cy - ay;
    const straight = Math.min(
        cx - box.x,
        box.x + box.width - cx,
        cy - box.y,
        box.y + box.height - cy,
    ) - discRadius;
    if (dx === 0 || dy === 0) return straight;
    return r - Math.hypot(dx, dy) - discRadius;
}
