import { describe, expect, it } from 'vitest';
import {
    MOBILE_COMPOSER_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
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

/**
 * The phones the tickets name. DROVE-266 kept the same three and added 390 at
 * the call sites that cared, because the crossover where the capsule took a row
 * of its own had moved to 389 — between 375 and 393. DROVE-281 moved it again
 * to 428, which put all three below it.
 *
 * DROVE-284 TAKES THAT ROW AWAY. Clay: "I don't like that extra row." Its air
 * refinement then spreads the segments on his "you have a little more space":
 * the crossover is 373 now, so 375 and 393 are above it and share one row, and
 * 320 is the only width below — where the name is cut rather than stacked.
 */
const phones = [320, 375, 393];

/**
 * THE ROW AS IT IS DRAWN SINCE DROVE-284: five things, where DROVE-264 had six.
 *
 * `+`, gap, the session capsule, gap, the spacer, the MIC, gap, send. The mic
 * came back off the primary in DROVE-264, because a single morphing button
 * cannot draw "type a bit, dictate the rest, then send"; read-aloud left in
 * DROVE-284, because Clay asked for it to join "the group".
 *
 * The capsule's own FIVE segments are modelled too, because the model's name is
 * the only variable width in the whole composer and the row's give-way order is
 * decided by exactly that measurement.
 *
 * TWO ASYMMETRIES ARE MODELLED RATHER THAN TRUSTED, because both are the kind
 * of thing a budget can restate correctly while the drawn row disagrees:
 *
 *  1. `glyphSegments` 4 against `dividers` 3. The bolt touches the padlock with
 *     no hairline between them (DROVE-281), because those two are the permission
 *     pair and a hairline in this capsule reads as a separate press.
 *  2. A glyph segment is NOT square (DROVE-284). It is the capsule's height
 *     tall and `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH` wide, which is what
 *     `COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY` now resolves to.
 */
function sessionCapsule(model: string, fontScale = 1): FlexNode {
    const divider: FlexNode = { name: 'divider', style: { width: 1, height: 20 } };
    return {
        name: 'sessionCapsule',
        style: COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY,
        children: [
            { name: 'modeSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            // No divider here. The pair, touching (DROVE-281).
            { name: 'autoAcceptSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            divider,
            { name: 'readAloudSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            { ...divider, name: 'divider2' },
            { name: 'effortSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            { ...divider, name: 'divider3' },
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
    const {
        withAdd = true, withControls = true, model = 'Opus 5', fontScale = 1,
    } = options;
    const gap: FlexNode = { name: 'gap', style: COMPOSER_BUBBLE_GAP_GEOMETRY };
    const actions: FlexNode[] = [];
    if (withAdd) actions.push({ name: 'add', style: COMPOSER_BUBBLE_DISC_GEOMETRY });
    if (withControls) {
        if (withAdd) actions.push({ ...gap, name: 'gapAddCapsule' });
        actions.push(sessionCapsule(model, fontScale));
        actions.push({ ...gap, name: 'gapCapsuleSpacer' });
    }
    actions.push({ name: 'spacer', style: COMPOSER_BUBBLE_SPACER_GEOMETRY });
    actions.push({ name: 'mic', style: COMPOSER_BUBBLE_DISC_GEOMETRY });
    actions.push({ ...gap, name: 'gapMicSend' });
    actions.push({ name: 'send', style: COMPOSER_BUBBLE_DISC_GEOMETRY });
    // ONE ROW, at every width (DROVE-284). The `capsuleRow` DROVE-266 added
    // here is gone: Clay rejected it by name and the capsule's segments pay for
    // the single row instead.
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
            // THREE discs: the `+`, the mic and send. Read-aloud was the
            // fourth until DROVE-284 moved it into the capsule.
            for (const name of ['add', 'mic', 'send']) {
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
        // 3.456 at DROVE-236, from 7.757, and that was the move: the floor
        // went 9 to 4 so the control row under the bubble comes up by 5.
        // DROVE-266 puts it at 3.829, because a BIGGER disc inset against the
        // same corner reaches further away from it, so growing the buttons buys
        // clearance rather than spending it. Above the 2 DROVE-214 measured as
        // visibly broken either way, with the whole margin stated.
        for (const text of textHeights) {
            const frames = layout(text);
            for (const name of ['add', 'send']) {
                const clearance = roundedRectClearance(
                    frames,
                    MOBILE_COMPOSER_METRICS.shellRadius,
                    findFrame(frames, name),
                );
                expect(clearance).toBeCloseTo(3.829, 3);
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
        for (const name of ['add', 'sessionCapsule', 'modeSegment', 'readAloudSegment',
            'effortSegment', 'modelSegment', 'mic', 'send']) {
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
        // The order Clay drew, with read-aloud now inside the capsule rather
        // than between it and the mic (DROVE-284): `+`, the session controls,
        // the mic, send.
        const order = ['add', 'sessionCapsule', 'mic', 'send']
            .map((name) => findFrame(frames, name).x);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        // And the block under the bubble is now the gap over the status strip
        // and nothing else: no row, no row height, no gap above a row.
        expect(MOBILE_COMPOSER_BASE_HEIGHT - MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT)
            .toBe(MOBILE_COMPOSER_METRICS.controlsBottomGap);
        expect(MOBILE_COMPOSER_BASE_HEIGHT).toBe(96);
        // 143 before. The move was worth the row plus the gap over it, 50, and
        // DROVE-266 spends 3 of that on bigger buttons, so what is left with
        // the transcript is 47. Written as the two terms, not as 47, so the
        // ledger says who took what.
        expect(143 - MOBILE_COMPOSER_BASE_HEIGHT).toBe(
            MOBILE_COMPOSER_METRICS.actionRowHeight
            + MOBILE_COMPOSER_METRICS.controlGap
            - (MOBILE_COMPOSER_METRICS.primaryActionSize - 36),
        );
    });

    it('keeps the three discs and the three gaps at the sizes the budget counts', () => {
        const frames = layout(22);
        const gaps = ['gapAddCapsule', 'gapCapsuleSpacer', 'gapMicSend'];
        for (const name of gaps) {
            expect(findFrame(frames, name).width, name)
                .toBe(MOBILE_COMPOSER_METRICS.controlGap);
        }
        expect(gaps.length).toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.gaps);
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.discs).toBe(3);
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.disc)
            .toBe(MOBILE_COMPOSER_METRICS.primaryActionSize);
        expect(MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE).toBe(39);
        // A SEGMENT IS NOT A DISC ANY MORE (DROVE-284). It is the capsule's
        // height tall and its own width wide, and the difference is what buys
        // the single row back with a fourth control in the capsule. 27 since
        // DROVE-320: Clay ruled DROVE-284's ink-tight 26 crowded and was given
        // two points, then asked for the model text back bigger, which is what
        // had paid for them — so one point returns to the type and one stays
        // as air. The derivation is asserted in sessionPillLabel.spec.ts and
        // still RETURNS this number rather than being handed it.
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.segment).toBe(MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH);
        expect(MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH).toBe(27);
        // 3 discs, 3 gaps, 4 glyph segments, 3 hairlines counted whole. 246,
        // which is 53 back on DROVE-281's 299 and 14 back on DROVE-266's 260 —
        // with one more control in the capsule than either of them had.
        expect(composerRowFixedWidth()).toBe(246);
        expect(299 - composerRowFixedWidth()).toBe(53);
        // And the capsule the row DRAWS agrees with the budget that counts it.
        // Five segments, THREE hairlines, which is the permission pair touching.
        const capsuleParts = ['modeSegment', 'autoAcceptSegment', 'readAloudSegment',
            'effortSegment', 'modelSegment'];
        for (const name of capsuleParts.slice(0, 4)) {
            expect(findFrame(frames, name).width, name)
                .toBe(MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH);
            // Full height though it is not full width: the touch target this
            // ticket spends is the horizontal one and only the horizontal one.
            expect(findFrame(frames, name).height, name)
                .toBe(MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE);
        }
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.glyphSegments).toBe(capsuleParts.length - 1);
        const capsule = findFrame(frames, 'sessionCapsule');
        const parts = capsuleParts.map((n) => findFrame(frames, n));
        expect(parts.reduce((w, f) => w + f.width, 0) + COMPOSER_BUBBLE_ROW_GEOMETRY.dividers)
            .toBe(capsule.width);
        // The padlock and the bolt TOUCH: nothing between their frames.
        expect(parts[1].x).toBe(parts[0].x + parts[0].width);
        // And the other three do not: one hairline each.
        expect(parts[2].x - (parts[1].x + parts[1].width)).toBe(1);
        expect(parts[3].x - (parts[2].x + parts[2].width)).toBe(1);
        expect(parts[4].x - (parts[3].x + parts[3].width)).toBe(1);
    });

    /**
     * THE WIDTH, at every phone the app runs on, because after DROVE-284 they
     * all draw the same row.
     *
     * The row holds five things and the model's name is the widest term on it,
     * so this is the measurement the ticket actually asks for. Resolved through
     * the engine rather than restated: the spacer is what is left over, and when
     * it reaches zero the row is full.
     */
    it('fits the row on every supported phone, and says what the name has left', () => {
        // Four wider at every width since DROVE-320: one point off each of the
        // four glyph segments, handed to the name so it can draw at 13pt.
        expect(phones.map(composerModelBudget)).toEqual([36, 91, 109]);
        expect([430, 440].map(composerModelBudget)).toEqual([146, 156]);
        for (const phone of [375, 390, 393, 430, 440]) {
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

    it('gives way in one order: the spacer, then the padding, then the type size', () => {
        // Every name the Claude picker offers, longest first.
        const names = ['Opus 4.8 1M', 'Sonnet 4.5', 'Haiku 4.5', 'Opus 5 1M',
            'Sonnet 5', 'Fable 5', 'Opus 5'];
        // On every supported phone nothing gives beyond the spacer and
        // DROVE-264's padding cut: every Claude name draws whole at 13pt. That
        // includes 375, which has not been true since DROVE-264.
        for (const phone of [375, 390, 393, 430, 440]) {
            for (const name of names) {
                expect(composerModelFits(name, phone), `${name} at ${phone}`).toBe(true);
            }
        }
        // The names that DO need the scale, and where. 375 and 390 are still
        // the two supported widths where anything scales after DROVE-320 —
        // 390's 0.980 on the three 14-glyph names is the air refinement's one
        // named softening, deepened by the bigger type and asserted in
        // sessionPillLabel.spec.ts. 375's scale goes UP while its type does
        // too, because the budget grew by more than the extra ink costs.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeCloseTo(0.827, 3);
        expect(composerModelScaleFor('GPT-5.6 Luna', 375)).toBeCloseTo(0.964, 3);
        expect(composerModelScaleFor('Gemini 3.1 Pro', 390)).toBeCloseTo(0.980, 3);
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375))
            .toBeGreaterThan(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        for (const phone of [393, 430, 440]) {
            expect(composerModelScaleFor('Gemini 3.1 Pro', phone), `${phone}`).toBe(1);
        }
        expect(COMPOSER_MODEL_SEGMENT.minimumFontScale).toBe(0.8);
        // AND 320 IS PAST THE END OF THE ORDER, which is this ticket's one
        // honest failure rather than a fault it can fix. Clay asked for one row
        // and one row is what a 320pt screen cannot spell a name on: no name of
        // any length at the floor fits, `Opus 5` included.
        for (const name of names) {
            expect(
                composerModelSegmentWidth(name, COMPOSER_MODEL_SEGMENT.minimumFontScale),
                `${name} at 320`,
            ).toBeGreaterThan(composerModelBudget(320));
        }
        // The spacer really does go first: at 375, the narrowest supported
        // width, with the longest name in either picker at the floor there are
        // 2pt of it left — the same 2 the crossover clears 375 by, and STILL
        // 2 after DROVE-320 because the 13pt name's 4 extra points at the floor
        // were paid for rather than borrowed from here. A bigger name that had
        // simply been asked for would have eaten this and then the name.
        const frames = layout(22, {
            model: 'Gemini 3.1 Pro',
            fontScale: COMPOSER_MODEL_SEGMENT.minimumFontScale,
        }, widthOf(375));
        expect(findFrame(frames, 'spacer').width).toBe(2);
        expect(findFrame(frames, 'spacer').width).toBeLessThanOrEqual(MOBILE_COMPOSER_METRICS.controlGap);
    });

    /**
     * THE SINGLE ROW, RESOLVED THROUGH THE ENGINE RATHER THAN ARGUED
     * (DROVE-284).
     *
     * DROVE-264 measured the single row overflowing at 320, DROVE-266 built the
     * capsule's own row to answer it, and DROVE-281 put every phone on that
     * second row. Clay: "Dude I don't like that extra row." So the assertion
     * flips: the single row must now HOLD at every width the app supports, at
     * the scale the name is actually drawn at, and 320 is the one that does not.
     */
    it('holds on one row at every supported phone, at the scale the name is drawn', () => {
        for (const [phone, model, fontScale] of [
            [375, 'Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale],
            [375, 'Opus 4.8 1M', 1],
            // 390 draws the 14-glyph names at 0.989 since the air refinement,
            // so the row is resolved at the scale the phone actually draws —
            // which is the assertion's own rule, now with a second member.
            [390, 'Gemini 3.1 Pro', composerModelScaleFor('Gemini 3.1 Pro', 390)],
            [393, 'Gemini 3.1 Pro', 1],
            [430, 'Gemini 3.1 Pro', 1],
            [440, 'Gemini 3.1 Pro', 1],
        ] as const) {
            const frames = layout(22, { model, fontScale }, widthOf(phone));
            const send = findFrame(frames, 'send');
            const rim = frames.width - MOBILE_COMPOSER_METRICS.bubbleInset;
            expect(send.x + send.width, `${model} at ${phone}`).toBe(rim);
            expect(findFrame(frames, 'spacer').width, `${model} at ${phone}`)
                .toBeGreaterThanOrEqual(0);
            const capsule = findFrame(frames, 'sessionCapsule');
            expect(capsule.x + capsule.width, `${model} at ${phone}`).toBeLessThan(rim);
            // ONE ROW: the capsule and send share it, which is the whole ticket.
            expect(capsule.y, `${model} at ${phone}`).toBe(send.y);
        }
    });

    it('overflows at 320 and nowhere else, even at the type floor', () => {
        // The failure, measured rather than described. The shortest name in any
        // picker at the smallest type the segment will draw still overruns the
        // rim by 8pt at 320 — DROVE-320's 4pt narrows a failure that was
        // already total, on a width below the supported floor, and no scale
        // rescues it. sessionPillLabel.ts carries what would have to give.
        const frames = layout(22, {
            model: 'Opus 5', fontScale: COMPOSER_MODEL_SEGMENT.minimumFontScale,
        }, widthOf(320));
        const send = findFrame(frames, 'send');
        const rim = frames.width - MOBILE_COMPOSER_METRICS.bubbleInset;
        expect(send.x + send.width - rim).toBe(8);
        // And 375, the narrowest phone the app supports, does not: it is the
        // first supported width above `COMPOSER_ROW_MIN_MODEL_WIDTH`'s 373.
        const ok = layout(22, {
            model: 'Gemini 3.1 Pro', fontScale: COMPOSER_MODEL_SEGMENT.minimumFontScale,
        }, widthOf(375));
        const okSend = findFrame(ok, 'send');
        expect(okSend.x + okSend.width).toBe(ok.width - MOBILE_COMPOSER_METRICS.bubbleInset);
    });

    it('opens at one height on every phone again, which is what the row buys back', () => {
        // DROVE-266 made the bubble's height depend on the WIDTH, and DROVE-281
        // put every phone on the taller shape. This is the transcript coming
        // back: one height, no width term, and the same 45pt DROVE-266 spent.
        const bubble = layout(22);
        expect(bubble.height).toBe(resolveMobileComposerBubbleHeight(22));
        expect(bubble.height)
            .toBe(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT);
        for (const phone of [320, 375, 393, 430]) {
            expect(layout(22, {}, widthOf(phone)).height, `${phone}`).toBe(bubble.height);
        }
        // Send keeps the bubble's bottom-trailing corner, which is where
        // DROVE-214 put it and where its clearance is measured.
        const send = findFrame(bubble, 'send');
        expect(send.y + send.height)
            .toBe(bubble.height - MOBILE_COMPOSER_METRICS.bubbleInsetBottom);
    });

    it('hands the name back 53pt, which is still more than DROVE-281 spent', () => {
        // The row DROVE-281 shipped, reconstructed from its own terms rather
        // than from constants that have since moved: four discs, four gaps,
        // three 39pt glyph segments, two hairlines.
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        const before284 = (screen: number) => screen
            - 2 * g.screenInset
            - 2 * g.bubbleInset
            - (4 * g.disc + 4 * g.gap + 3 * MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE + 2);
        expect(phones.map(before284)).toEqual([-17, 38, 56]);
        for (const phone of phones) {
            expect(composerModelBudget(phone) - before284(phone), `${phone}`).toBe(53);
        }
        // THE LEDGER, IN TWO NAMED TERMS, IN THE ORDER THEY HAPPEN. Clay's
        // DROVE-284 instruction is the first: a loose disc and its gap leave
        // the row (45), and a segment and a hairline join the capsule at the
        // width a segment was then (40), which is 5 on its own. The second is
        // the one that has now moved three times: four glyph segments that were
        // only square because one prop set both axes went to the ink-tight 26,
        // Clay's "spread them out" brought them to 28, and DROVE-320 took one
        // point back to pay for the 13pt name — 12pt off each against the disc
        // they were.
        const discAndGap = g.disc + g.gap;
        const segmentThen = MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE + 1;
        const narrowing = 4 * (MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE - g.segment);
        expect([discAndGap, segmentThen, narrowing]).toEqual([45, 40, 48]);
        expect(discAndGap - segmentThen + narrowing).toBe(53);
        // And the padding hands back 10 on top of it, 8 of which was
        // DROVE-264's give and the last 2 DROVE-320's. THE TWO GIVES DO NOT
        // ADD UP TO THE AIR ANY MORE, and that is the ticket: the air
        // refinement spent 8 (2pt on each of four segments) and DROVE-320
        // spends 6 of it back on type — 4 off the segments and 2 off the
        // padding — leaving 4 of Clay's granted air still on the row.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(5);
        expect(2 * (10 - COMPOSER_MODEL_SEGMENT.paddingHorizontal)).toBe(10);
        // What is still standing of Clay's granted air: 4pt, one per segment.
        expect(4 * (g.segment - 26)).toBe(4);
        // And what DROVE-320 took to pay for the 13pt name: 4 off the four
        // segments and 2 off the two sides of the padding, which is exactly
        // the 6 more points the longest name needs at the type floor
        // (85 -> 89 on the name, and 4 of the 6 land in the budget itself).
        const fromSegments = 4 * (28 - g.segment);
        const fromPadding = 2 * (6 - COMPOSER_MODEL_SEGMENT.paddingHorizontal);
        expect([fromSegments, fromPadding]).toEqual([4, 2]);
        expect(fromSegments + fromPadding).toBe(6);
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
        expect(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT).toBe(88);
        for (const text of textHeights) {
            expect(layout(text).height).toBe(resolveMobileComposerBubbleHeight(text));
        }
        // Two rows and their air. The transcript paid 46 for it in DROVE-214,
        // got 5 back on this ticket's first pass, and gets the control row's
        // whole 50 on this one. Against DROVE-196's 143 composer the block is
        // 50pt shorter with every control still on the screen.
        expect(MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT - 44).toBe(44);
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
        expect(clearanceAt(9)).toBeCloseTo(8.379, 3);
        expect(clearanceAt(4)).toBeCloseTo(3.829, 3);
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
        // 36 LITERALLY, not `primaryActionSize`. This reproduces a build that
        // shipped, so it has to be the size that shipped: reading the live
        // constant made the reproduction quietly follow DROVE-266's 39 and stop
        // reproducing anything.
        const size = 36;
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
