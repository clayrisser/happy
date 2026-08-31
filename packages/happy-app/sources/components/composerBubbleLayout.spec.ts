import { describe, expect, it } from 'vitest';
import {
    MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT,
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT,
    resolveComposerTextWidth,
    resolveMobileComposerBubbleHeight,
} from './agentInputLayout';
import {
    COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY,
    COMPOSER_BUBBLE_DISC_GEOMETRY,
    COMPOSER_BUBBLE_GEOMETRY,
    COMPOSER_BUBBLE_SPACER_GEOMETRY,
    COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY,
} from './composerBubbleLayout';
import { FlexNode, findFrame, resolveFlexFrames, roundedRectClearance } from './flexFrames';

/**
 * WHAT THIS SPEC IS FOR, and why the three before it passed over a broken
 * composer (DROVE-214).
 *
 * Clay, on the shipped build: "Why does this still look like shit?" It was the
 * third round. Each of the first three asserted NUMBERS — rim to ink 4.000,
 * disc inset 4, bubble floor 44 — and every one of them was arithmetically
 * right. None of them could fail on his screenshot, because the thing that was
 * wrong was not a number: the discs were pinned with `position: absolute` to
 * the bottom of the row the TEXT lives in, and that row is the only thing in
 * the composer whose height nobody knows.
 *
 * Measured off his crop at 3px/pt: the bubble drew 66pt against a 44pt model,
 * both discs sat 10.7pt below its centre, and their clearance from the drawn
 * rounded corner had collapsed from 4pt to 0.69pt. Every spec was green.
 *
 * So this one resolves the real style objects through a flexbox engine and
 * asserts RELATIONSHIPS a screenshot could falsify, at several text heights.
 * If a disc ever stops being centred in its row, or leaves the bubble's drawn
 * shape, or the caret's column moves with what is drawn, something here fails.
 */

const screenWidth = 393;
const bubbleWidth = screenWidth - MOBILE_COMPOSER_METRICS.shellInset * 2;

/** One line of text, two, four, and past the cap. */
const textHeights = [22, 44, 88, 400];

function bubbleTree(textIntrinsic: number, withAdd = true): FlexNode {
    const actions: FlexNode[] = [];
    if (withAdd) actions.push({ name: 'add', style: COMPOSER_BUBBLE_DISC_GEOMETRY });
    actions.push({ name: 'spacer', style: COMPOSER_BUBBLE_SPACER_GEOMETRY });
    actions.push({ name: 'send', style: COMPOSER_BUBBLE_DISC_GEOMETRY });
    return {
        name: 'bubble',
        style: COMPOSER_BUBBLE_GEOMETRY,
        children: [
            {
                name: 'textRow',
                style: COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY,
                intrinsicHeight: textIntrinsic,
            },
            {
                name: 'actionRow',
                style: COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY,
                children: actions,
            },
        ],
    };
}

function layout(textIntrinsic: number, withAdd = true) {
    return resolveFlexFrames(bubbleTree(textIntrinsic, withAdd), bubbleWidth);
}

const centreY = (f: { y: number; height: number }) => f.y + f.height / 2;
const centreX = (f: { x: number; width: number }) => f.x + f.width / 2;

describe('the composer bubble, resolved rather than restated', () => {
    it('centres both discs in their row at every height the text ever reaches', () => {
        // THE SPEC THAT WOULD HAVE FAILED ON CLAY'S SCREENSHOT. The discs are
        // in a row that cannot grow, so this holds without anyone knowing how
        // tall the bubble is — which is the whole point, because nobody did.
        for (const text of textHeights) {
            const frames = layout(text);
            const row = findFrame(frames, 'actionRow');
            for (const name of ['add', 'send']) {
                const disc = findFrame(frames, name);
                expect(disc.width).toBe(MOBILE_COMPOSER_METRICS.primaryActionSize);
                expect(disc.height).toBe(MOBILE_COMPOSER_METRICS.primaryActionSize);
                expect(centreY(disc)).toBe(centreY(row));
            }
        }
    });

    it('keeps the discs off the bubble\'s DRAWN corner, not just inside its box', () => {
        // Yoga lays out rectangles and has never heard of `borderRadius`, so a
        // frame can be inside its parent while the pixels are outside the
        // shape. That is what "the disc breaches its rounded end" was.
        //
        // The shipped build measured 0.69pt of corner clearance at a 66pt
        // bubble, down from 4pt at 44, because a bottom-pinned disc slides
        // into the corner as the field grows. This does not move, because the
        // disc's distance from the bottom corner is the bubble's padding at
        // every height.
        //
        // 3.456 since DROVE-236, from 7.757, and that is the move: the floor
        // went 9 to 4 so the control row under the bubble comes up by 5. It is
        // above the 2 DROVE-214 measured as visibly broken and below the 4.7
        // the arrangement before it drew, with the whole margin stated.
        for (const text of textHeights) {
            const frames = layout(text);
            for (const name of ['add', 'send']) {
                const clearance = roundedRectClearance(
                    frames,
                    MOBILE_COMPOSER_METRICS.shellRadius,
                    findFrame(frames, name),
                );
                expect(clearance).toBeCloseTo(3.456, 3);
                expect(clearance).toBeGreaterThan(2);
            }
        }
    });

    /**
     * THE MOVE, measured rather than described (DROVE-236).
     *
     * Clay: "Move the bottom row up." The control row is pinned to the bottom
     * of the dock, so the only air between it and the bubble is the bubble's
     * own floor plus `controlGap`. This is what a disc at the trailing rim sees
     * of it, before and after.
     */
    it('brings the control row 5pt nearer the send button', () => {
        const frames = layout(22);
        const send = findFrame(frames, 'send');
        const floor = frames.height - (send.y + send.height);
        expect(floor).toBe(MOBILE_COMPOSER_METRICS.bubbleInsetBottom);
        expect(floor).toBe(4);
        // Send disc to the audio capsule's rim, which is the distance he is
        // actually looking at: the bubble's floor plus the one gap outside it.
        const toControlRow = floor + MOBILE_COMPOSER_METRICS.controlGap;
        expect(toControlRow).toBe(10);
        // It was 15 while the floor was 9. Nothing else in the stack moved.
        expect(MOBILE_COMPOSER_METRICS.bubbleInset + MOBILE_COMPOSER_METRICS.controlGap).toBe(15);
        expect(MOBILE_COMPOSER_METRICS.controlGap).toBe(6);
        // The floor is the only side that changed. The three that hold text
        // keep the square corner's number.
        expect(findFrame(frames, 'textRow').y).toBe(MOBILE_COMPOSER_METRICS.bubbleInset);
        expect(send.x + send.width).toBe(frames.width - MOBILE_COMPOSER_METRICS.bubbleInset);
    });

    it('draws the two discs as mirror images about the bubble\'s centre line', () => {
        for (const text of textHeights) {
            const frames = layout(text);
            const add = findFrame(frames, 'add');
            const send = findFrame(frames, 'send');
            expect(add.x - frames.x).toBe(frames.x + frames.width - (send.x + send.width));
            expect(add.x - frames.x).toBe(MOBILE_COMPOSER_METRICS.bubbleInset);
            expect(centreY(add)).toBe(centreY(send));
            expect(centreX(add) + centreX(send)).toBe(frames.width);
        }
    });

    it('gives the text the full interior width whatever else is drawn', () => {
        // DROVE-206 pinned 208 / 263 / 281 so the caret could not move between
        // an empty composer and a typed one. Nothing stands beside the text
        // now, so the constraint has no subject and the constants are deleted.
        for (const text of textHeights) {
            for (const withAdd of [true, false]) {
                const row = findFrame(layout(text, withAdd), 'textRow');
                expect(row.x).toBe(MOBILE_COMPOSER_METRICS.bubbleInset);
                expect(row.width).toBe(bubbleWidth - MOBILE_COMPOSER_METRICS.bubbleInset * 2);
                expect(row.width).toBe(resolveComposerTextWidth(screenWidth));
            }
        }
        // 355 at 393, against DROVE-206's pinned 281. The text gains 74pt.
        expect(resolveComposerTextWidth(393)).toBe(355);
        expect(resolveComposerTextWidth(375)).toBe(337);
        expect(resolveComposerTextWidth(320)).toBe(282);
    });

    it('starts the caret and the `+` on one column, which is the status strip\'s', () => {
        const frames = layout(22);
        const text = findFrame(frames, 'textRow');
        const add = findFrame(frames, 'add');
        expect(text.x).toBe(add.x);
        expect(MOBILE_COMPOSER_METRICS.shellInset + text.x).toBe(MOBILE_COMPOSER_LAYOUT.textInset);
        // DROVE-223's strip reads `textInset`, and it does not move: 19 used to
        // be a chosen number and is now the bubble's interior edge.
        expect(MOBILE_COMPOSER_LAYOUT.textInset).toBe(19);
    });

    it('holds send at the trailing end in zen mode, where no `+` is drawn', () => {
        const withAdd = findFrame(layout(22, true), 'send');
        const zen = findFrame(layout(22, false), 'send');
        expect(zen.x).toBe(withAdd.x);
        expect(zen.x + zen.width)
            .toBe(bubbleWidth - MOBILE_COMPOSER_METRICS.bubbleInset);
    });

    it('resolves to the height the module models, so the model cannot drift', () => {
        expect(layout(22).height).toBe(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);
        expect(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT).toBe(85);
        for (const text of textHeights) {
            expect(layout(text).height).toBe(resolveMobileComposerBubbleHeight(text));
        }
        // Two rows and their air. The transcript paid 46 for it in DROVE-214
        // and gets 5 back in DROVE-236, so the standing bill is 41.
        expect(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT - 44).toBe(41);
        expect(MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT).toBe(30);
        expect(MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT)
            .toBe(MOBILE_COMPOSER_METRICS.primaryActionSize);
    });

    it('pads the bubble by enough to clear its own corner radius', () => {
        // The one number the layout engine cannot derive, so it is derived
        // here instead: a SQUARE corner (the text's) clears a radius r when it
        // is inset r - r/sqrt(2).
        const needed = MOBILE_COMPOSER_METRICS.shellRadius
            * (1 - Math.SQRT1_2);
        expect(needed).toBeCloseTo(8.787, 3);
        expect(MOBILE_COMPOSER_METRICS.bubbleInset).toBe(Math.ceil(needed));
        expect(MOBILE_COMPOSER_METRICS.bubbleInset).toBe(9);
    });

    it('pads the FLOOR by what a circle needs, which is less (DROVE-236)', () => {
        // The 9 above is the TEXT's number and the text has square corners.
        // Nothing square is on the bottom row, so its floor is measured against
        // the shape that is actually there. This is the derivation, run rather
        // than restated: the clearance at each candidate padding.
        const clearanceAt = (paddingBottom: number) => {
            const height = MOBILE_COMPOSER_METRICS.bubbleInset
                + MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT
                + MOBILE_COMPOSER_METRICS.controlGap
                + MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT
                + paddingBottom;
            const size = MOBILE_COMPOSER_METRICS.primaryActionSize;
            return roundedRectClearance(
                { x: 0, y: 0, width: bubbleWidth, height },
                MOBILE_COMPOSER_METRICS.shellRadius,
                {
                    x: MOBILE_COMPOSER_METRICS.bubbleInset,
                    y: height - paddingBottom - size,
                    width: size,
                    height: size,
                },
            );
        };
        expect(clearanceAt(9)).toBeCloseTo(7.757, 3);
        expect(clearanceAt(4)).toBeCloseTo(3.456, 3);
        // Below the chosen number it reaches what DROVE-214 measured as broken,
        // then leaves the drawn shape entirely.
        expect(clearanceAt(2)).toBeLessThan(2);
        expect(clearanceAt(0)).toBeLessThan(0);
        expect(MOBILE_COMPOSER_METRICS.bubbleInsetBottom).toBe(4);
    });

    it('refuses any hand-placed offset in the bubble\'s geometry', () => {
        // The pin that caused this ticket was `position: absolute` with
        // `bottom: 4`, and no spec could see it because it lived in the
        // renderer's own stylesheet. Everything that places anything in the
        // bubble is exported now, and the resolver throws on a positional
        // property rather than ignoring it.
        for (const geometry of [
            COMPOSER_BUBBLE_GEOMETRY,
            COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY,
            COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY,
            COMPOSER_BUBBLE_SPACER_GEOMETRY,
            COMPOSER_BUBBLE_DISC_GEOMETRY,
        ]) {
            for (const key of ['position', 'top', 'bottom', 'left', 'right', 'marginTop', 'marginBottom']) {
                expect(geometry).not.toHaveProperty(key);
            }
        }
        expect(() => resolveFlexFrames({
            name: 'pinned',
            style: { position: 'absolute', bottom: 4 } as never,
        }, 100)).toThrow(/unmodelled style/);
    });

    it('reproduces the shipped bug, so what changed is on the record', () => {
        // The old arrangement: one row holding the text AND both discs, each
        // disc pinned 4 off the bottom. Modelled here by hand, because it is
        // exactly what the layout system was not being asked to do.
        const bubbleHeight = 66; // measured off Clay's crop at 3px/pt
        const inset = 4;
        const size = MOBILE_COMPOSER_METRICS.primaryActionSize;
        const disc = {
            x: inset,
            y: bubbleHeight - inset - size,
            width: size,
            height: size,
        };
        // The disc hung 11pt below the bubble's centre. Clay's crop measures
        // 10.67, the difference being the hairline border he photographed.
        expect(centreY(disc) - bubbleHeight / 2).toBe(11);
        // And its corner clearance had all but gone.
        const clearance = roundedRectClearance(
            { x: 0, y: 0, width: bubbleWidth, height: bubbleHeight },
            MOBILE_COMPOSER_METRICS.shellRadius,
            disc,
        );
        expect(clearance).toBeCloseTo(0.686, 3);
        // At the 44pt floor the same pin measured 4, which is why three passes
        // of arithmetic all looked correct: they were only ever checked empty.
        expect(roundedRectClearance(
            { x: 0, y: 0, width: bubbleWidth, height: 44 },
            MOBILE_COMPOSER_METRICS.shellRadius,
            { x: inset, y: inset, width: size, height: size },
        )).toBe(4);
    });
});
