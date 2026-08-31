import { describe, expect, it } from 'vitest';
import {
    MOBILE_COMPOSER_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT,
    resolveComposerTextWidth,
    resolveMobileComposerBubbleHeight,
} from './agentInputLayout';
import {
    COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY,
    COMPOSER_BUBBLE_DISC_GEOMETRY,
    COMPOSER_BUBBLE_GAP_GEOMETRY,
    COMPOSER_BUBBLE_GEOMETRY,
    COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY,
    COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY,
    COMPOSER_BUBBLE_SPACER_GEOMETRY,
    COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY,
} from './composerBubbleLayout';
import {
    COMPOSER_BUBBLE_ROW_GEOMETRY,
    COMPOSER_MODEL_SEGMENT,
    composerModelBudget,
    composerModelFits,
    composerModelScaleFor,
    composerModelSegmentWidth,
    composerRowFixedWidth,
} from './sessionPillLabel';
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
const widthOf = (screen: number) => screen - MOBILE_COMPOSER_METRICS.shellInset * 2;
const bubbleWidth = widthOf(screenWidth);

/** One line of text, two, four, and past the cap. */
const textHeights = [22, 44, 88, 400];

/** The three phones the ticket names. */
const phones = [320, 375, 393];

/**
 * THE ROW AS IT IS DRAWN SINCE DROVE-236: five things where there were two.
 *
 * `+`, gap, the session capsule, gap, the spacer, the audio disc, gap, send.
 * The capsule's own three segments are modelled too, because the model's name
 * is the only variable width in the whole composer and the row's give-way
 * order is decided by exactly that measurement.
 */
function sessionCapsule(model: string, fontScale = 1): FlexNode {
    const divider: FlexNode = { name: 'divider', style: { width: 1, height: 20 } };
    return {
        name: 'sessionCapsule',
        style: COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY,
        children: [
            { name: 'modeSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            divider,
            { name: 'effortSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            { ...divider, name: 'divider2' },
            {
                name: 'modelSegment',
                style: {
                    width: composerModelSegmentWidth(model, fontScale),
                    height: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
                },
            },
        ],
    };
}

interface TreeOptions {
    withAdd?: boolean;
    withControls?: boolean;
    model?: string;
    fontScale?: number;
}

function bubbleTree(textIntrinsic: number, options: TreeOptions = {}): FlexNode {
    const { withAdd = true, withControls = true, model = 'Opus 5', fontScale = 1 } = options;
    const gap: FlexNode = { name: 'gap', style: COMPOSER_BUBBLE_GAP_GEOMETRY };
    const actions: FlexNode[] = [];
    if (withAdd) actions.push({ name: 'add', style: COMPOSER_BUBBLE_DISC_GEOMETRY });
    if (withControls) {
        if (withAdd) actions.push({ ...gap, name: 'gapAddCapsule' });
        actions.push(sessionCapsule(model, fontScale));
        actions.push({ ...gap, name: 'gapCapsuleSpacer' });
    }
    actions.push({ name: 'spacer', style: COMPOSER_BUBBLE_SPACER_GEOMETRY });
    actions.push({ name: 'audio', style: COMPOSER_BUBBLE_DISC_GEOMETRY });
    actions.push({ ...gap, name: 'gapAudioSend' });
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

function layout(textIntrinsic: number, options: TreeOptions = {}, width = bubbleWidth) {
    return resolveFlexFrames(bubbleTree(textIntrinsic, options), width);
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
            // All THREE discs since DROVE-236: the audio button joined them.
            for (const name of ['add', 'audio', 'send']) {
                const disc = findFrame(frames, name);
                expect(disc.width).toBe(MOBILE_COMPOSER_METRICS.primaryActionSize);
                expect(disc.height).toBe(MOBILE_COMPOSER_METRICS.primaryActionSize);
                expect(centreY(disc)).toBe(centreY(row));
            }
            // And the capsule is the row's own height, so it needs no
            // centring: that is why the bubble did not grow to take it.
            const capsule = findFrame(frames, 'sessionCapsule');
            expect(capsule.height).toBe(MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE);
            expect(capsule.height).toBe(row.height);
            expect(centreY(capsule)).toBe(centreY(row));
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
     * Clay: "Move the bottom row up", then, when it moved up by 5 and stayed a
     * row: "Dude didn't I tell you to do this already?" with the composer
     * marked up in red. His annotation is a diagram: the session capsule
     * circled with an arrow into the bubble's empty middle, the audio button
     * circled with an arrow to the right rim, an X through the mic that was
     * already in there, the middle scribbled over. So the row is not nearer,
     * it is IN, and there is nothing under the bubble.
     */
    it('puts every control the row held inside the bubble, and leaves nothing under it', () => {
        const frames = layout(22);
        const row = findFrame(frames, 'actionRow');
        for (const name of ['add', 'sessionCapsule', 'modeSegment', 'effortSegment',
            'modelSegment', 'audio', 'send']) {
            const child = findFrame(frames, name);
            expect(child, name).toBeDefined();
            // Inside the bubble's box on both axes, which is what "in the
            // bubble" has to mean before it means anything else.
            expect(child.y, name).toBeGreaterThanOrEqual(row.y);
            expect(child.y + child.height, name).toBeLessThanOrEqual(row.y + row.height);
            expect(child.x, name).toBeGreaterThanOrEqual(MOBILE_COMPOSER_METRICS.bubbleInset);
            expect(child.x + child.width, name)
                .toBeLessThanOrEqual(frames.width - MOBILE_COMPOSER_METRICS.bubbleInset);
        }
        // The order Clay drew: `+`, the session controls, the audio button,
        // send.
        const order = ['add', 'sessionCapsule', 'audio', 'send']
            .map((name) => findFrame(frames, name).x);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        // And the block under the bubble is now the gap over the status strip
        // and nothing else: no row, no row height, no gap above a row.
        expect(MOBILE_COMPOSER_BASE_HEIGHT - MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT)
            .toBe(MOBILE_COMPOSER_METRICS.controlsBottomGap);
        expect(MOBILE_COMPOSER_BASE_HEIGHT).toBe(93);
        // 143 before, and the whole 50 is the row plus the gap over it.
        expect(143 - MOBILE_COMPOSER_BASE_HEIGHT).toBe(
            MOBILE_COMPOSER_METRICS.actionRowHeight + MOBILE_COMPOSER_METRICS.controlGap,
        );
    });

    it('keeps the three discs and the three gaps at the sizes the budget counts', () => {
        const frames = layout(22);
        const gaps = ['gapAddCapsule', 'gapCapsuleSpacer', 'gapAudioSend'];
        for (const name of gaps) {
            expect(findFrame(frames, name).width, name)
                .toBe(MOBILE_COMPOSER_METRICS.controlGap);
        }
        expect(gaps.length).toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.gaps);
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.discs).toBe(3);
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.disc)
            .toBe(MOBILE_COMPOSER_METRICS.primaryActionSize);
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.segment).toBe(MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE);
        expect(MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE).toBe(36);
        // 3 discs, 3 gaps, 2 glyph segments, 2 hairlines counted whole.
        expect(composerRowFixedWidth()).toBe(200);
    });

    /**
     * THE WIDTH, at the three phones the ticket names.
     *
     * The row holds five things where it held two and the model's name is the
     * widest term on it, so this is the measurement the ticket actually asks
     * for. Resolved through the engine rather than restated: the spacer is
     * what is left over, and when it reaches zero the row is full.
     */
    it('fits the row at 320, 375 and 393, and says what the name has left', () => {
        expect(phones.map(composerModelBudget)).toEqual([82, 137, 155]);
        for (const phone of phones) {
            const frames = layout(22, {}, widthOf(phone));
            const row = findFrame(frames, 'actionRow');
            const spacer = findFrame(frames, 'spacer');
            const send = findFrame(frames, 'send');
            // Send is at the trailing rim on every phone, which is the thing a
            // row that did not fit would break first.
            expect(send.x + send.width, `${phone}`)
                .toBe(frames.width - MOBILE_COMPOSER_METRICS.bubbleInset);
            // The row's fixed width plus the name plus the spacer IS the
            // interior. If a term ever goes missing this is where it shows.
            const model = findFrame(frames, 'modelSegment');
            expect(composerRowFixedWidth() + model.width + spacer.width, `${phone}`)
                .toBe(row.width);
        }
    });

    it('gives way in one order: the spacer, then the name\'s type size, and never the name', () => {
        // Every name the Claude picker offers, longest first.
        const names = ['Opus 4.8 1M', 'Sonnet 4.5', 'Haiku 4.5', 'Opus 5 1M',
            'Sonnet 5', 'Fable 5', 'Opus 5'];
        // At 375 and 393 nothing gives at all: every name draws whole at 13pt.
        for (const phone of [375, 393]) {
            for (const name of names) {
                expect(composerModelFits(name, phone), `${name} at ${phone}`).toBe(true);
            }
        }
        // At 320 the three longest scale. `Opus 4.8 1M` is the worst case and
        // it is what sets the floor.
        expect(names.filter((name) => !composerModelFits(name, 320)))
            .toEqual(['Opus 4.8 1M', 'Sonnet 4.5', 'Haiku 4.5', 'Opus 5 1M']);
        expect(composerModelScaleFor('Opus 4.8 1M', 320)).toBeCloseTo(0.805, 3);
        // Which is why the floor moved 0.85 -> 0.80, and why 0.85 would now
        // CUT the longest name rather than shrink it.
        expect(COMPOSER_MODEL_SEGMENT.minimumFontScale).toBe(0.8);
        expect(composerModelScaleFor('Opus 4.8 1M', 320))
            .toBeGreaterThan(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(composerModelScaleFor('Opus 4.8 1M', 320)).toBeLessThan(0.85);
        // Every name draws WHOLE on the narrowest phone at the floor. That is
        // the whole claim: nothing is ever cut, and nothing is replaced by a
        // glyph.
        for (const name of names) {
            expect(
                composerModelSegmentWidth(name, COMPOSER_MODEL_SEGMENT.minimumFontScale),
                name,
            ).toBeLessThanOrEqual(composerModelBudget(320));
        }
        // And the spacer really does go first: at 320 with the longest name at
        // the floor there is nothing left of it.
        const frames = layout(22, {
            model: 'Opus 4.8 1M',
            fontScale: COMPOSER_MODEL_SEGMENT.minimumFontScale,
        }, widthOf(320));
        expect(findFrame(frames, 'spacer').width).toBeLessThanOrEqual(2);
    });

    it('costs the name 33pt at every width, which is what the move is paid in', () => {
        // What the row drew OUTSIDE the bubble, measured the same way: one
        // screen inset each side, two 44pt glyph segments and two hairlines,
        // one gap, and the collapsed audio pair as two 44pt buttons with one
        // hairline between them.
        const outside = (screen: number) => screen
            - 2 * MOBILE_COMPOSER_METRICS.shellInset
            - (2 * 44 + 2)
            - MOBILE_COMPOSER_METRICS.controlGap
            - (2 * MOBILE_COMPOSER_METRICS.actionSize + 1);
        expect(phones.map(outside)).toEqual([115, 170, 188]);
        for (const phone of phones) {
            expect(outside(phone) - composerModelBudget(phone), `${phone}`).toBe(33);
        }
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
                const row = findFrame(layout(text, { withAdd }), 'textRow');
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
        const withAdd = findFrame(layout(22), 'send');
        // Zen draws neither the `+` nor the session capsule.
        const zen = findFrame(layout(22, { withAdd: false, withControls: false }), 'send');
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
        // Two rows and their air. The transcript paid 46 for it in DROVE-214,
        // got 5 back on this ticket's first pass, and gets the control row's
        // whole 50 on this one. Against DROVE-196's 143 composer the block is
        // 50pt shorter with every control still on the screen.
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
            COMPOSER_BUBBLE_GAP_GEOMETRY,
            COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY,
            COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY,
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
