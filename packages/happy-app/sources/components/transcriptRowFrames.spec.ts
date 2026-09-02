import { describe, expect, it } from 'vitest';
import { FlexFrame, FlexNode, resolveFlexFrames } from './flexFrames';
import {
    resolveDockBottomOffset,
    resolveDockInset,
    resolveMeasuredDockHeight,
    resolveRestingDockHeight,
    resolveTranscriptBottomClearance,
} from './agentDockLayout';

/**
 * The transcript's two overlaps, measured (DROVE-373).
 *
 * Clay: "What's up with the alignment of the speech things? You can see how
 * they're overlapping, it's all funky." Two screenshots, two different
 * overlaps, and it took both to see there were two:
 *
 *   1. a message drawn on top of the message above it;
 *   2. the last message drawn under the composer.
 *
 * Neither was a nudge anybody could tune out. Both were a FRAME that did not
 * come from the layout engine — the first from a SwiftUI host writing a row's
 * height back from a native measurement (`nativeControls.ts`), the second from
 * a list reserving a measured dock height that starts at zero. So this file
 * measures rather than restates: `resolveFlexFrames` is the Yoga-checked
 * resolver DROVE-214 built for exactly this, and the geometry below is read
 * off it instead of being written down.
 */

/** Where a frame ends. The only number an overlap is about. */
function bottom(frame: FlexFrame): number {
    return frame.y + frame.height;
}

function rowsOf(column: FlexFrame): FlexFrame[] {
    return column.children;
}

/**
 * A transcript column: rows stacked, each as tall as its own content.
 *
 * Margins are modelled as the rows' own padding, which is what the resolver
 * models and what Yoga resolves them to in a column with no collapsing. The
 * agent block carries 10 above and below (`agentMessageContainer`), the user
 * bubble 4 under it (`userMessageBubble`); the numbers are the transcript's,
 * the shape is the resolver's.
 */
const agentRow = (bodyHeight: number, pinnedHeight?: number): FlexNode => ({
    name: `agent:${bodyHeight}`,
    style: {
        flexDirection: 'column',
        width: '100%',
        paddingTop: 10,
        paddingBottom: 10,
        ...(pinnedHeight === undefined ? {} : { height: pinnedHeight }),
    },
    children: [{ name: `agent-body:${bodyHeight}`, style: { width: '100%' }, intrinsicHeight: bodyHeight }],
});

const userRow = (bodyHeight: number, pinnedHeight?: number): FlexNode => ({
    name: `user:${bodyHeight}`,
    style: {
        flexDirection: 'column',
        width: '100%',
        paddingBottom: 4,
        ...(pinnedHeight === undefined ? {} : { height: pinnedHeight }),
    },
    children: [{ name: `user-body:${bodyHeight}`, style: { width: '100%' }, intrinsicHeight: bodyHeight }],
});

const column = (children: FlexNode[]): FlexNode => ({
    name: 'transcript',
    style: { flexDirection: 'column', alignItems: 'stretch', width: '100%' },
    children,
});

const PHONE_WIDTH = 393;

describe('a transcript row ends before the next one begins', () => {
    /**
     * The rule the ticket buys, over the case the screenshots caught: three
     * consecutive rows, alternating authors, none of them the same height.
     * The tall one is a long drover reply with a code fence, which is the body
     * that reflows late and so the body the native measurement lost.
     */
    const mixed = [agentRow(212), userRow(48), agentRow(96)];

    it('leaves no gap and no overlap between any two consecutive rows', () => {
        const rows = rowsOf(resolveFlexFrames(column(mixed), PHONE_WIDTH));
        expect(rows).toHaveLength(3);
        for (let i = 0; i + 1 < rows.length; i += 1) {
            expect(bottom(rows[i]), `${rows[i].name} -> ${rows[i + 1].name}`)
                .toBeLessThanOrEqual(rows[i + 1].y);
        }
    });

    it('holds at every ordering of the same three heights', () => {
        // The bug was not about which author came first, so neither is this.
        const heights = [212, 48, 96];
        const orders = [
            [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
        ];
        for (const order of orders) {
            const nodes = order.map((h, index) => (
                index % 2 === 0 ? agentRow(heights[h]) : userRow(heights[h])
            ));
            const rows = rowsOf(resolveFlexFrames(column(nodes), PHONE_WIDTH));
            for (let i = 0; i + 1 < rows.length; i += 1) {
                expect(bottom(rows[i]), `${order.join(',')}: ${rows[i].name}`)
                    .toBeLessThanOrEqual(rows[i + 1].y);
            }
        }
    });

    it('gives every row the full height of its own content', () => {
        // The other half of "no overlap", and the one the clip was. A row that
        // ends before the next begins but stops short of its own text has
        // simply moved the failure inside itself.
        const rows = rowsOf(resolveFlexFrames(column(mixed), PHONE_WIDTH));
        const bodies = rows.map((row) => row.children[0]);
        expect(bodies.map((body) => body.height)).toEqual([212, 48, 96]);
        for (let i = 0; i < rows.length; i += 1) {
            expect(bottom(bodies[i]), rows[i].name).toBeLessThanOrEqual(bottom(rows[i]));
        }
    });

    it('overlaps exactly when a row is pinned to a height its content outgrows', () => {
        /**
         * The mechanism, demonstrated rather than asserted about.
         *
         * This is what `<Host matchContents={{ vertical: true }}>` does to a
         * message: the row's height stops being a number Yoga computed and
         * becomes a number written back from a native measurement, and a
         * measurement taken before a markdown body reflowed is short. Pin the
         * tall row to what the host measured it at before its code fence laid
         * out, and the row below moves up INTO it by the difference — which is
         * the screenshot, in one line of arithmetic.
         *
         * So the fix is not a bigger number anywhere. It is that no message row
         * carries an externally written height at all, which
         * `longPressCopyable.test.ts` asserts on the file and this measures on
         * the consequence.
         */
        const bodyHeight = 212;
        // What the host reported before the code fence laid out: the row's own
        // padding around a body 62pt shorter than the one that got drawn.
        const measuredShort = 150;
        const pinned = 10 + measuredShort + 10;
        const rows = rowsOf(resolveFlexFrames(
            column([agentRow(bodyHeight, pinned), userRow(48), agentRow(96)]),
            PHONE_WIDTH,
        ));
        const body = rows[0].children[0];
        expect(rows[0].height).toBe(pinned);
        expect(bottom(body)).toBeGreaterThan(bottom(rows[0]));
        expect(bottom(body)).toBeGreaterThan(rows[1].y);
        // The row's 10pt bottom padding absorbs that much of the shortfall
        // before the text reaches the next row. Everything past it is drawn on
        // top of the message below, which is the screenshot.
        expect(bottom(body) - rows[1].y).toBe(bodyHeight - measuredShort - 10);
    });
});

describe('the newest message clears the composer', () => {
    /**
     * The other overlap. The inverted list's `paddingTop` renders at its visual
     * bottom and is `resolveTranscriptBottomClearance() + resolveDockInset(…)`,
     * so what has to hold is that the reserved band is never shorter than the
     * dock that sits in it — at every composer height, keyboard up and down.
     *
     * The floor lives on the HEIGHT, not on the inset, because the same height
     * also sizes the transcript mask, the bottom scrim and the empty state's
     * bottom edge, and `agentDockLayout.test.ts` asserts those equal to the
     * inset. A floor applied in one reader would have pulled them apart.
     */
    const safeAreaBottom = 34;
    const spacer = resolveDockBottomOffset(safeAreaBottom, true);

    function reserved(measured: number, keyboardInset = 0): number {
        return resolveTranscriptBottomClearance()
            + resolveDockInset({
                dockHeight: resolveMeasuredDockHeight(measured),
                safeAreaBottom,
                floatingDock: true,
                keyboardInset,
            });
    }

    it('reserves the dock plus its spacer, plus the edge ramp, at every measured height', () => {
        // Every height a composer actually takes: one line, two, three, the
        // cap, and with an attachment strip open.
        const resting = resolveRestingDockHeight();
        for (const dockHeight of [resting, resting + 22, resting + 44, resting + 66, 260]) {
            expect(reserved(dockHeight), `dock ${dockHeight}`)
                .toBe(resolveTranscriptBottomClearance() + dockHeight + spacer);
        }
    });

    it('reserves the resting dock even before anything has measured', () => {
        // The first-paint case, and the whole reason the floor exists. The
        // dock's height reaches the list through onLayout -> setState -> effect
        // -> setState; reserving 12pt for a dock over a hundred tall draws the
        // newest message under the glass for as long as that takes.
        expect(resolveMeasuredDockHeight(0)).toBe(resolveRestingDockHeight());
        expect(reserved(0))
            .toBe(resolveTranscriptBottomClearance() + resolveRestingDockHeight() + spacer);
    });

    it('never lets a short measurement reserve less than the composer at rest', () => {
        for (const shortRead of [0, 1, 40, resolveRestingDockHeight() - 1]) {
            expect(reserved(shortRead), `short read ${shortRead}`)
                .toBeGreaterThanOrEqual(reserved(resolveRestingDockHeight()));
        }
    });

    it('gets out of the way once the measurement is real', () => {
        // A floor, not a replacement: a composer holding three lines or an
        // attachment strip is taller than the resting height and only the
        // measurement knows by how much.
        const tall = resolveRestingDockHeight() + 88;
        expect(resolveMeasuredDockHeight(tall)).toBe(tall);
        expect(reserved(tall)).toBe(resolveTranscriptBottomClearance() + tall + spacer);
    });

    it('holds with the keyboard up, where Android adds the keyboard to the inset', () => {
        // iOS translates the dock and the content together and passes 0 here;
        // Android and web pass the keyboard's height. Both have to reserve the
        // dock, so the floor is on the dock term either way.
        const keyboardInset = 291;
        expect(reserved(0, keyboardInset))
            .toBe(resolveTranscriptBottomClearance() + resolveRestingDockHeight() + keyboardInset + spacer);
        expect(reserved(260, keyboardInset))
            .toBe(resolveTranscriptBottomClearance() + 260 + keyboardInset + spacer);
    });

    it('is a floor on the height, so every band derived from it moves together', () => {
        // The mask, the scrim and the list all read one number. This is the
        // statement that they read the SAME one.
        const measured = 40;
        const floored = resolveMeasuredDockHeight(measured);
        expect(floored).toBe(resolveRestingDockHeight());
        expect(resolveDockInset({ dockHeight: floored, safeAreaBottom, floatingDock: true }))
            .toBe(floored + spacer);
    });

    it('reserves nothing at all off the floating dock, where the list ends at the input', () => {
        // Tablet, web, landscape: the composer is a sibling below the list, not
        // an overlay on it, so a floor here would be dead space.
        expect(resolveDockInset({ dockHeight: 0, safeAreaBottom, floatingDock: false })).toBe(0);
        expect(resolveDockInset({ dockHeight: 300, safeAreaBottom, floatingDock: false })).toBe(0);
    });
});
