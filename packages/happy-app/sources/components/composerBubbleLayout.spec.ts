import { describe, expect, it } from 'vitest';
import {
    MOBILE_COMPOSER_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_ACTION_ROW_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_BASE_HEIGHT,
    MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE,
    MOBILE_COMPOSER_CAPSULE_GLYPH_SIZE,
    MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
    MOBILE_COMPOSER_DISC_INNER_PADDING,
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    MOBILE_COMPOSER_TEXT_ROW_BASE_HEIGHT,
    resolveComposerTextWidth,
    resolveMobileComposerBubbleHeight,
} from './agentInputLayout';
import {
    COMPOSER_PRESS_TARGETS,
    composerPressTargetsAreDisjoint,
    resolveComposerPressTarget,
    resolveComposerShellInteractive,
    COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY,
    COMPOSER_BUBBLE_DISC_GEOMETRY,
    COMPOSER_BUBBLE_GAP_GEOMETRY,
    COMPOSER_BUBBLE_GEOMETRY,
    COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY,
    COMPOSER_BUBBLE_SESSION_MODEL_SEGMENT_GEOMETRY,
    COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY,
    COMPOSER_BUBBLE_SPACER_GEOMETRY,
    COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY,
} from './composerBubbleLayout';
import {
    COMPOSER_BUBBLE_ROW_GEOMETRY,
    COMPOSER_MODEL_SEGMENT,
    COMPOSER_ROW_MIN_MODEL_WIDTH,
    composerCapsuleWidth,
    composerIconSegmentPadding,
    composerModelBudget,
    composerModelFits,
    composerModelPresentation,
    composerModelScaleFor,
    composerModelSegmentWidth,
    composerRowFixedWidth,
} from './sessionPillLabel';
import {
    FlexNode, findFrame, measureFlexWidth, resolveFlexFrames, roundedRectClearance,
} from './flexFrames';

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
 * `+`, gap, the session capsule, gap, the MIC, gap, send — the spacer between
 * the capsule and the mic is gone with DROVE-353, because the capsule is the
 * row's flexible child now and there is nothing left for a spacer to hold. The
 * mic
 * came back off the primary in DROVE-264, because a single morphing button
 * cannot draw "type a bit, dictate the rest, then send"; read-aloud left in
 * DROVE-284, because Clay asked for it to join "the group".
 *
 * The capsule's own FOUR segments are modelled too, because the model's name
 * is the only variable width in the whole composer and the row's give-way
 * order is decided by exactly that measurement. FIVE from DROVE-284 to
 * DROVE-331: the auto-accept bolt sat second, touching the padlock with no
 * hairline (DROVE-281), until Clay ruled it redundant with the switch in the
 * padlock's sheet. Its 27 is the name's now, and the one asymmetry the tree
 * had to carry for it — `glyphSegments` 4 against `dividers` 3 — is gone with
 * it: three glyph segments, one rule at every boundary, three rules.
 *
 * ONE ASYMMETRY IS STILL MODELLED RATHER THAN TRUSTED, because it is the kind
 * of thing a budget can restate correctly while the drawn row disagrees: a
 * glyph segment is NOT square (DROVE-284). It is the capsule's height tall
 * and `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH` wide, which is what
 * `COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY` resolves to.
 */
function sessionCapsule(model: string, fontScale = 1, modelWidth?: number): FlexNode {
    const divider: FlexNode = { name: 'divider', style: { width: 1, height: 20 } };
    return {
        name: 'sessionCapsule',
        style: COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY,
        children: [
            { name: 'modeSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            // A rule here since DROVE-331. The bolt that touched the padlock
            // is gone, so this boundary is a change of subject like the others.
            divider,
            { name: 'readAloudSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            { ...divider, name: 'divider2' },
            { name: 'effortSegment', style: COMPOSER_BUBBLE_SESSION_SEGMENT_GEOMETRY },
            { ...divider, name: 'divider3' },
            {
                name: 'modelSegment',
                // THE REMAINDER, WHICH IS WHAT THE PHONE DRAWS (DROVE-353).
                // `flex: 1` inside a `flex: 1` capsule, so the segment is the
                // capsule less the three glyph segments and the three
                // hairlines and there is nothing left over for a spacer.
                //
                // A `modelWidth` still pins it, and two tests below use that
                // to model rows that no longer exist — the name at its own
                // width, which is what left the band, and the unshrunk name
                // overrunning the rim, which is what the cut is measured
                // against. Both are history now, asserted as history.
                style: modelWidth === undefined
                    ? COMPOSER_BUBBLE_SESSION_MODEL_SEGMENT_GEOMETRY
                    : { width: modelWidth, height: MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE },
            },
        ],
    };
}

interface TreeOptions {
    withAdd?: boolean;
    withControls?: boolean;
    model?: string;
    fontScale?: number;
    /** The model segment's resolved width, when the presentation decides it (DROVE-331). */
    modelWidth?: number;
}

function bubbleTree(textIntrinsic: number, options: TreeOptions = {}): FlexNode {
    const {
        withAdd = true, withControls = true, model = 'Opus 5', fontScale = 1, modelWidth,
    } = options;
    const gap: FlexNode = { name: 'gap', style: COMPOSER_BUBBLE_GAP_GEOMETRY };
    const actions: FlexNode[] = [];
    if (withAdd) actions.push({ name: 'add', style: COMPOSER_BUBBLE_DISC_GEOMETRY });
    if (withControls) {
        if (withAdd) actions.push({ ...gap, name: 'gapAddCapsule' });
        actions.push(sessionCapsule(model, fontScale, modelWidth));
        actions.push({ ...gap, name: 'gapCapsuleSpacer' });
    }
    // THE SPACER ONLY WHERE THERE IS NO CAPSULE TO BE IT (DROVE-353). Two
    // `flex: 1` children on one row split the slack, which is the band Clay
    // photographed at half width, so the two are mutually exclusive.
    if (!withControls) actions.push({ name: 'spacer', style: COMPOSER_BUBBLE_SPACER_GEOMETRY });
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
        // 33 SINCE DROVE-353, and derived rather than declared: the capsule's
        // 20pt glyph plus the air the `+` disc keeps around its own, which is
        // Clay's rule ("at least the + disc's own inner padding") written as
        // an addition. Every earlier value here was the LEAST a segment could
        // be and still let the row fit.
        expect(MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH).toBe(33);
        expect(MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH)
            .toBe(MOBILE_COMPOSER_CAPSULE_GLYPH_SIZE + 2 * MOBILE_COMPOSER_DISC_INNER_PADDING);
        // The disc's air, off the two metrics it is made of rather than off
        // the sentence in agentInputLayout.ts that first stated it.
        expect(MOBILE_COMPOSER_DISC_INNER_PADDING).toBe(6.5);
        expect(MOBILE_COMPOSER_DISC_INNER_PADDING).toBe(
            (MOBILE_COMPOSER_METRICS.primaryActionSize - MOBILE_COMPOSER_METRICS.addIconSize) / 2,
        );
        // 3 discs, 3 gaps, 3 glyph segments, 3 hairlines counted whole. 237,
        // up from DROVE-331's 219 by exactly the six points each of the three
        // segments gained, which is this ticket's whole cost on the row.
        expect(composerRowFixedWidth()).toBe(237);
        expect(composerRowFixedWidth() - 219)
            .toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.glyphSegments * (33 - 27));
        // Still 62 back on DROVE-281's 299, which is what the single row
        // bought and what this ticket spends a quarter of.
        expect(299 - composerRowFixedWidth()).toBe(62);
        // And the capsule the row DRAWS agrees with the budget that counts it.
        // Four segments, THREE hairlines: one at every boundary now that the
        // permission pair is a padlock alone.
        const capsuleParts = ['modeSegment', 'readAloudSegment', 'effortSegment', 'modelSegment'];
        for (const name of capsuleParts.slice(0, 3)) {
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
        // One hairline between every pair, and NOTHING touching: the bolt was
        // the one segment that did (DROVE-281), and a segment that touched
        // the padlock again would be it coming back.
        expect(parts[1].x - (parts[0].x + parts[0].width)).toBe(1);
        expect(parts[2].x - (parts[1].x + parts[1].width)).toBe(1);
        expect(parts[3].x - (parts[2].x + parts[2].width)).toBe(1);
        expect(parts.length - 1).toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.dividers);
        // And no node by the bolt's name is in the modelled tree at all.
        const names: string[] = [];
        const walk = (node: FlexNode) => { names.push(node.name); (node.children ?? []).forEach(walk); };
        walk(bubbleTree(22));
        expect(names).not.toContain('autoAcceptSegment');
        expect(names.filter((n) => n.endsWith('Segment')))
            .toEqual(['modeSegment', 'readAloudSegment', 'effortSegment', 'modelSegment']);
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
        // 27 wider at every width since DROVE-331: the auto-accept bolt's
        // whole segment, handed to the name. Four wider before that since
        // DROVE-320, one point off each of what were then four glyph segments.
        // 18 NARROWER AT EVERY WIDTH THAN DROVE-331 LEFT THEM (DROVE-353):
        // three glyph segments took six points each so the icons keep the `+`
        // disc's own air. Clay ranked those two against each other himself.
        expect(phones.map(composerModelBudget)).toEqual([45, 100, 118]);
        expect([430, 440].map(composerModelBudget)).toEqual([155, 165]);
        expect(phones.map((phone, i) => [63, 118, 136][i] - composerModelBudget(phone)))
            .toEqual([18, 18, 18]);
        for (const phone of [375, 390, 393, 430, 440]) {
            const frames = layout(22, {}, widthOf(phone));
            const row = findFrame(frames, 'actionRow');
            const send = findFrame(frames, 'send');
            // Send is at the trailing rim on every phone, which is the thing a
            // row that did not fit would break first.
            expect(send.x + send.width, `${phone}`)
                .toBe(frames.width - MOBILE_COMPOSER_METRICS.bubbleInset);
            // THERE IS NO SPACER IN THE ROW AT ALL (DROVE-353). Not one of
            // width zero — no node by that name, because the capsule is the
            // flexible child and a second one would split the slack with it.
            expect(findFrame(frames, 'spacer'), `${phone}`).toBeUndefined();
            // The row's fixed width plus the name IS the interior, with no
            // third term. If one ever comes back this is where it shows.
            const model = findFrame(frames, 'modelSegment');
            expect(composerRowFixedWidth() + model.width, `${phone}`).toBe(row.width);
        }
    });

    it('gives way in one order: the name\'s type, then its tail — the icons never', () => {
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
        // 375 SCALES THE 14-GLYPH NAMES AGAIN, AND THAT IS THE TRADE DROVE-353
        // TAKES RATHER THAN A REGRESSION THAT SLIPPED PAST. DROVE-331 had just
        // bought them whole on every supported width; the icons' padding costs
        // 18 of the 29 points that bought it, and Clay ranked the two in the
        // sentence that filed the ticket — "on a narrow phone with a long model
        // name the icons keep their padding and the label gives".
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeCloseTo(0.857, 3);
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375))
            .toBeGreaterThan(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        // 390 and up still draw every name in either picker whole at 13pt.
        for (const phone of [390, 393, 430, 440]) {
            expect(composerModelScaleFor('Gemini 3.1 Pro', phone), `${phone}`).toBe(1);
            expect(composerModelScaleFor('GPT-5.6 Luna', phone), `${phone}`).toBe(1);
        }
        expect(COMPOSER_MODEL_SEGMENT.minimumFontScale).toBe(0.8);
        // AND 320 IS PAST THE END OF THE ORDER ENTIRELY. It kept the five
        // short Claude names at DROVE-331's 63pt budget and keeps none at
        // DROVE-353's 45: every name in the picker is cut there. 320 has not
        // been a supported width since statusRowLayout.spec.ts said so, and
        // the argument for not rearranging the row to rescue it is unchanged
        // and on `COMPOSER_BUBBLE_ROW_GEOMETRY`.
        const at320 = (name: string) =>
            composerModelSegmentWidth(name, COMPOSER_MODEL_SEGMENT.minimumFontScale)
            <= composerModelBudget(320);
        expect(names.filter(at320)).toEqual([]);
        expect(names.filter((name) => !at320(name))).toEqual(names);
        // THE ICONS NEVER GIVE, WHICH IS THE ORDER'S FIRST CLAUSE AND THE ONE
        // THIS TICKET ADDS. At 375 with the longest name in either picker, and
        // at 320 where that name is cut, the three glyph segments are the same
        // width they are on a 440pt phone with `Opus 5`.
        for (const [phone, model] of [[375, 'Gemini 3.1 Pro'], [320, 'Gemini 3.1 Pro'],
            [440, 'Opus 5']] as const) {
            const frames = layout(22, {
                model, modelWidth: composerModelPresentation(model, phone).width,
            }, widthOf(phone));
            for (const name of ['modeSegment', 'readAloudSegment', 'effortSegment']) {
                expect(findFrame(frames, name).width, `${name} at ${phone}`)
                    .toBe(MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH);
            }
        }
    });

    /**
     * THE CAPSULE FILLS THE ROW, AND WHAT IT DOES WITH THE WIDTH (DROVE-353).
     *
     * Clay, for the fifth time, over a photograph of the padlock, the speaker
     * and the dial jammed against their hairlines with a band of nothing
     * between the capsule and the mic: "Why is everything squished here?
     * There's extra space. I keep pointing this out, this is like the fifth
     * time."
     *
     * BOTH HALVES OF THAT SENTENCE ARE ONE PROPERTY. The capsule sized to its
     * CONTENT and a `flex: 1` spacer beside it took every point the row had
     * spare, so the free width went to a view that draws nothing while the
     * thing that draws stayed at its floor. The capsule is the flexible child
     * now and the spacer is mounted only where there is no capsule.
     *
     * The rule, resolved rather than restated, at the three widths the ticket
     * names and with the three names it names:
     *
     *   the capsule's right edge is the mic's left edge less ONE `controlGap`
     *   every glyph segment keeps at least the `+` disc's own inner padding
     *   each hairline sits centred in the air between the glyphs it separates
     *   the name takes the remainder, whole while the remainder holds it
     */
    it('fills the row with the capsule and distributes it inside (DROVE-353)', () => {
        const names = ['Fable 5.1', 'Opus 5', 'A-model-name-of-24-chars'];
        expect(names[2].length).toBe(24);
        for (const phone of [375, 390, 430]) {
            for (const model of names) {
                const drawn = composerModelPresentation(model, phone);
                const frames = layout(22, { model, modelWidth: drawn.width }, widthOf(phone));
                const capsule = findFrame(frames, 'sessionCapsule');
                const mic = findFrame(frames, 'mic');
                const label = `${model} at ${phone}`;

                // NO BAND. One gap between the capsule and the mic and nothing
                // else, at every width and for every name.
                expect(mic.x - (capsule.x + capsule.width), label)
                    .toBe(MOBILE_COMPOSER_METRICS.controlGap);
                expect(capsule.width, label).toBe(composerCapsuleWidth(phone));

                // THE ICONS KEEP THEIR PADDING, whatever the name does.
                const glyphs = ['modeSegment', 'readAloudSegment', 'effortSegment']
                    .map((n) => findFrame(frames, n));
                for (const glyph of glyphs) {
                    const padding = (glyph.width - MOBILE_COMPOSER_CAPSULE_GLYPH_SIZE) / 2;
                    expect(padding, `${glyph.name} ${label}`)
                        .toBeGreaterThanOrEqual(MOBILE_COMPOSER_DISC_INNER_PADDING);
                    expect(padding, `${glyph.name} ${label}`).toBe(composerIconSegmentPadding());
                }

                // AND EACH HAIRLINE IS CENTRED IN THE GAP, which falls out of
                // the padding being equal rather than being placed: between
                // two glyph segments the midpoint of the air between the glyph
                // BOXES is the boundary between the segments, to the point.
                const model_ = findFrame(frames, 'modelSegment');
                const parts = [...glyphs, model_];
                for (const [i, rule] of ['divider', 'divider2'].entries()) {
                    const line = findFrame(frames, rule);
                    const before = parts[i];
                    const after = parts[i + 1];
                    const pad = composerIconSegmentPadding();
                    const air = [before.x + before.width - pad, after.x + pad];
                    expect(line.x + line.width / 2, `${rule} ${label}`)
                        .toBeCloseTo((air[0] + air[1]) / 2, 6);
                    // Equidistant from the two segment boxes as well, which is
                    // the same fact with the padding cancelled out.
                    expect(line.x - (before.x + before.width), `${rule} ${label}`)
                        .toBe(after.x - (line.x + line.width));
                }
                // THE LAST HAIRLINE MEETS THE NAME RATHER THAN A GLYPH, so
                // "centred in the gap" is stated against what is actually on
                // either side of it: the dial's own padding leading, and the
                // name's minimum air trailing. The name is CENTRED in the
                // remainder, so its drawn air is this or more, never less.
                const last = findFrame(frames, 'divider3');
                expect(last.x - (glyphs[2].x + glyphs[2].width), label).toBe(0);
                expect(model_.x - (last.x + last.width), label).toBe(0);
                expect(glyphs[2].x + glyphs[2].width - composerIconSegmentPadding(), label)
                    .toBe(last.x - composerIconSegmentPadding());
                expect(model_.width, label)
                    .toBeGreaterThanOrEqual(2 * COMPOSER_MODEL_SEGMENT.paddingHorizontal);

                // THE NAME TAKES THE REMAINDER, and the capsule is exactly its
                // parts: three segments, three hairlines, the name.
                expect(model_.width, label).toBe(composerModelBudget(phone));
                expect(glyphs.reduce((w, f) => w + f.width, 0)
                    + COMPOSER_BUBBLE_ROW_GEOMETRY.dividers + model_.width, label)
                    .toBe(capsule.width);
            }
        }

        // WHOLE AT FULL SIZE FOR THE TWO REAL NAMES, ON ALL THREE WIDTHS —
        // which is the point of spending the row's slack on the capsule rather
        // than on nothing.
        for (const phone of [375, 390, 430]) {
            for (const model of ['Fable 5.1', 'Opus 5']) {
                const drawn = composerModelPresentation(model, phone);
                expect(drawn.outcome, `${model} at ${phone}`).toBe('whole');
                expect(drawn.scale, `${model} at ${phone}`).toBe(1);
            }
        }
        // AND THE LONG NAME GIVES, in DROVE-331's order and nowhere else: it
        // steps down first and is cut only when the floor still will not fit.
        expect(composerModelPresentation('A-model-name-of-24-chars', 430).outcome).toBe('scaled');
        expect(composerModelPresentation('A-model-name-of-24-chars', 430).scale)
            .toBeCloseTo(0.827, 3);
        expect(composerModelPresentation('A-model-name-of-24-chars', 390).outcome).toBe('truncated');
        expect(composerModelPresentation('A-model-name-of-24-chars', 375).outcome).toBe('truncated');
        // For a 24-glyph name the step-down begins under 459 and the cut under
        // 426, both above every phone the app runs on — which is why a name
        // that long is the only way to reach either step at all.
        expect(composerModelPresentation('A-model-name-of-24-chars', 459).outcome).toBe('whole');
        expect(composerModelPresentation('A-model-name-of-24-chars', 458).outcome).toBe('scaled');
        expect(composerModelPresentation('A-model-name-of-24-chars', 426).outcome).toBe('scaled');
        expect(composerModelPresentation('A-model-name-of-24-chars', 425).outcome).toBe('truncated');
        // The capsule and the budget are the same measurement one level apart.
        for (const phone of [320, 375, 390, 393, 430, 440]) {
            expect(composerCapsuleWidth(phone), `${phone}`).toBe(
                composerModelBudget(phone)
                + COMPOSER_BUBBLE_ROW_GEOMETRY.glyphSegments * COMPOSER_BUBBLE_ROW_GEOMETRY.segment
                + COMPOSER_BUBBLE_ROW_GEOMETRY.dividers,
            );
        }
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
        // 390 drew the 14-glyph names at 0.980 until DROVE-331; the row is
        // resolved at the scale the phone actually draws, which is the
        // assertion's own rule, and that scale is 1 on every member now.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 390)).toBe(1);
        for (const [phone, model, fontScale] of [
            // 375 draws the longest name WHOLE since DROVE-331; the floor
            // scale stays in the list because the row must hold there too.
            [375, 'Gemini 3.1 Pro', 1],
            [375, 'Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale],
            [375, 'Opus 4.8 1M', 1],
            [390, 'Gemini 3.1 Pro', composerModelScaleFor('Gemini 3.1 Pro', 390)],
            [393, 'Gemini 3.1 Pro', 1],
            [430, 'Gemini 3.1 Pro', 1],
            [440, 'Gemini 3.1 Pro', 1],
        ] as const) {
            const frames = layout(22, { model, fontScale }, widthOf(phone));
            const send = findFrame(frames, 'send');
            const rim = frames.width - MOBILE_COMPOSER_METRICS.bubbleInset;
            expect(send.x + send.width, `${model} at ${phone}`).toBe(rim);
            const capsule = findFrame(frames, 'sessionCapsule');
            expect(capsule.x + capsule.width, `${model} at ${phone}`).toBeLessThan(rim);
            // ONE ROW: the capsule and send share it, which is the whole ticket.
            expect(capsule.y, `${model} at ${phone}`).toBe(send.y);
        }
    });

    it('overflows at no width at all, because the name is what gives (DROVE-353)', () => {
        // THIS TEST USED TO MEASURE AN OVERRUN AND THERE IS NONE LEFT TO
        // MEASURE. While the model segment was as wide as its NAME, a name too
        // long for the row pushed send past the rim, and the overrun was the
        // number DROVE-331's cut was sized against. The segment is `flex: 1`
        // now, so it can only ever be the remainder and the row holds at every
        // width by construction — including 320, where what gives is the name.
        for (const phone of [320, 375, 390, 393, 430, 440]) {
            const frames = layout(22, {}, widthOf(phone));
            const send = findFrame(frames, 'send');
            const rim = frames.width - MOBILE_COMPOSER_METRICS.bubbleInset;
            expect(send.x + send.width, `${phone}`).toBe(rim);
            expect(findFrame(frames, 'modelSegment').width, `${phone}`)
                .toBe(composerModelBudget(phone));
        }
        // THE OVERRUN SURVIVES AS A MEASUREMENT OF THE CAPSULE'S CONTENT,
        // which is the honest place for it now: send cannot be pushed off the
        // rim any more, because a `flex: 1` capsule is given a width rather
        // than taking one, so what "does not fit" means is that the capsule's
        // parts want more than the row hands it. At 320 with the longest name
        // at the type floor they want 50 more, and 50 is exactly what the
        // ellipsis stands in for.
        const wanted = measureFlexWidth({
            ...sessionCapsule('Gemini 3.1 Pro',
                COMPOSER_MODEL_SEGMENT.minimumFontScale,
                composerModelSegmentWidth('Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale)),
            // The flex removed, so the measurement is the CONTENT rather than
            // whatever the row would give it.
            style: { ...COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY, flex: undefined },
        }, widthOf(320));
        expect(wanted - composerCapsuleWidth(320)).toBe(50);
        expect(composerModelPresentation('Gemini 3.1 Pro', 320).cut).toBe(50);
    });

    /**
     * THE CUT, RESOLVED THROUGH THE ENGINE (DROVE-331).
     *
     * Clay: "you can even make the model text a bit smaller and truncate if it
     * ends up running under." The test above lets the unshrunk name overrun
     * the rim so the failure is measured; this one lays the segment out at the
     * width `composerModelPresentation` says it takes, which is what `flex: 1`
     * on the model segment resolves to on the phone (DROVE-353), and asserts
     * what the ellipsis buys: send on the rim, the three glyph segments at
     * their 33, and the cut exactly the overrun.
     */
    it('cuts the name rather than the row or the other segments, at the width the presentation resolves (DROVE-331)', () => {
        const drawn = composerModelPresentation('Gemini 3.1 Pro', 320);
        expect(drawn.outcome).toBe('truncated');
        const frames = layout(22, { model: 'Gemini 3.1 Pro', modelWidth: drawn.width }, widthOf(320));
        const rim = frames.width - MOBILE_COMPOSER_METRICS.bubbleInset;
        const send = findFrame(frames, 'send');
        expect(send.x + send.width).toBe(rim);
        for (const name of ['modeSegment', 'readAloudSegment', 'effortSegment']) {
            expect(findFrame(frames, name).width, name).toBe(MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH);
        }
        const model = findFrame(frames, 'modelSegment');
        expect(model.width).toBe(composerModelBudget(320));
        expect(model.width).toBe(45);
        expect(findFrame(frames, 'sessionCapsule').width)
            .toBe(3 * MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH + COMPOSER_BUBBLE_ROW_GEOMETRY.dividers + 45);
        // What the ellipsis stands in for is the overrun the unshrunk name
        // measures, to the point.
        const wanted = measureFlexWidth({
            ...sessionCapsule('Gemini 3.1 Pro',
                COMPOSER_MODEL_SEGMENT.minimumFontScale,
                composerModelSegmentWidth('Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale)),
            style: { ...COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY, flex: undefined },
        }, widthOf(320));
        expect(drawn.cut).toBe(wanted - composerCapsuleWidth(320));
        expect(drawn.cut).toBe(50);
        // Scaled, one step up the order: at the crossover the segment is the
        // whole budget, nothing is cut, and the row holds the same way.
        const scaled = composerModelPresentation('Gemini 3.1 Pro', COMPOSER_ROW_MIN_MODEL_WIDTH);
        expect(scaled.outcome).toBe('scaled');
        const atCrossover = layout(22, { model: 'Gemini 3.1 Pro', modelWidth: scaled.width },
            widthOf(COMPOSER_ROW_MIN_MODEL_WIDTH));
        const crossoverSend = findFrame(atCrossover, 'send');
        expect(crossoverSend.x + crossoverSend.width).toBe(atCrossover.width - MOBILE_COMPOSER_METRICS.bubbleInset);
        expect(findFrame(atCrossover, 'modelSegment').width).toBe(95);
        // And on a phone with the room the same call draws the name WHOLE —
        // still in the whole budget, because the segment IS the budget now
        // (DROVE-353). 393 rather than 375: the icons' padding costs the
        // 14-glyph names their full size on the narrowest supported phone, and
        // that is this ticket's stated trade rather than a surprise.
        const whole = composerModelPresentation('Gemini 3.1 Pro', 393);
        expect(whole.outcome).toBe('whole');
        expect(composerModelPresentation('Gemini 3.1 Pro', 375).outcome).toBe('scaled');
        const ok = layout(22, { model: 'Gemini 3.1 Pro', modelWidth: whole.width }, widthOf(393));
        expect(findFrame(ok, 'modelSegment').width).toBe(118);
        expect(findFrame(ok, 'modelSegment').width).toBe(composerModelBudget(393));
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

    it('hands the name back 62pt, which is still more than DROVE-281 spent', () => {
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
            expect(composerModelBudget(phone) - before284(phone), `${phone}`).toBe(62);
        }
        // THE LEDGER, IN THREE NAMED TERMS, IN THE ORDER THEY HAPPEN. Clay's
        // DROVE-284 instruction is the first: a loose disc and its gap leave
        // the row (45), and a segment and a hairline join the capsule at the
        // width a segment was then (40), which is 5 on its own. The second
        // moved three times: four glyph segments that were only square because
        // one prop set both axes went to the ink-tight 26, Clay's "spread them
        // out" brought them to 28, and DROVE-320 took one point back to pay
        // for the 13pt name — 12pt off each against the disc they were, four
        // of them at the time. The third is DROVE-331: the auto-accept bolt
        // leaves the capsule at the 27 it had reached, and no hairline goes
        // with it because it never had one (it touched the padlock).
        const discAndGap = g.disc + g.gap;
        const segmentThen = MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE + 1;
        const narrowing = 4 * (MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE - g.segment);
        const boltGone = g.segment;
        expect([discAndGap, segmentThen, narrowing, boltGone]).toEqual([45, 40, 24, 33]);
        expect(discAndGap - segmentThen + narrowing).toBe(29);
        expect(discAndGap - segmentThen + narrowing + boltGone).toBe(62);
        // AND THE FOURTH TERM IS DROVE-353 SPENDING SOME OF IT BACK, which is
        // why this line reads 62 and not 80. The three glyph segments go to
        // the `+` disc's own air (27 -> 33, six each) and the name's own air
        // follows the same rule up (5 -> 8, three a side), so 24 of DROVE-331's
        // 29 banked points go back out. It is one trade, made in Clay's own
        // order: the icons keep their padding and the label gives.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(8);
        const toSegments = g.glyphSegments * (g.segment - 27);
        const toPadding = 2 * (COMPOSER_MODEL_SEGMENT.paddingHorizontal - 5);
        expect([toSegments, toPadding]).toEqual([18, 6]);
        expect(toSegments + toPadding).toBe(24);
        // And that 24 is exactly where `COMPOSER_ROW_MIN_MODEL_WIDTH` moved to,
        // which is the same ledger read off the other end.
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH - 346).toBe(toSegments + toPadding);
        // The name's air is not a number anybody picked either: it is the
        // tightest clearance the glyph segments give their own ink, rounded up
        // — `eye` at 0.9355 of a 20pt em inside a 33pt segment.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal)
            .toBe(Math.ceil((g.segment - MOBILE_COMPOSER_CAPSULE_GLYPH_SIZE * 0.9355) / 2));
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

/**
 * THE THREE PRESS CASES, RESOLVED FROM THE TREE (DROVE-343).
 *
 * Clay, with the `+` mid-press: "whenever I push a button from that group, the
 * input box should not also have that touch effect. The input box should only
 * get the touch effect when I'm touching where the text is, not one of the
 * buttons on top of it."
 *
 * `UIGlassEffect.isInteractive` is a property of the effect VIEW and its
 * interaction sees every touch delivered inside it, so while the shell carried
 * it there was no per-region switch to reach for: a press on the `+` swelled the
 * whole bubble because the `+` mounts inside the shell's `contentView`. The
 * press had to MOVE, and where it moved to is a fact about the LAYOUT — which
 * frame is the bubble's press target and which is the group's.
 *
 * So this asks the resolver, at every text height, rather than restating an
 * offset. If the text row ever grew under the capsule, or the capsule moved
 * inside the text row, the cases would disagree here before anyone saw it on a
 * phone. That is DROVE-214's rule reaching the press as well as the geometry.
 */
describe('a press lands on exactly one surface (DROVE-343)', () => {
    const centre = (f: { x: number; y: number; width: number; height: number }) => ({
        x: centreX(f), y: centreY(f),
    });

    it('sends the text area to the bubble, a segment to the capsule, the + to the +', () => {
        for (const text of textHeights) {
            const frames = layout(text);
            // THE TEXT AREA -> THE BUBBLE. Its press target is the text row,
            // which is the frame the interactive surface is on.
            expect(resolveComposerPressTarget(frames, centre(findFrame(frames, 'textRow'))))
                .toBe('textRow');
            // A SEGMENT OF THE CAPSULE -> THE CAPSULE, and never the bubble.
            // Every segment reports the capsule that holds it: one interactive
            // surface for a grouped control (DROVE-169), so the segment under
            // the finger is a press INSIDE that surface rather than a surface
            // of its own.
            for (const segment of ['modeSegment', 'readAloudSegment', 'effortSegment', 'modelSegment']) {
                expect(
                    resolveComposerPressTarget(frames, centre(findFrame(frames, segment))),
                    segment,
                ).toBe('sessionCapsule');
            }
            // THE + -> THE +. It is a glass button of its own since DROVE-266,
            // and Clay's "I love the liquid glass experience I'm getting with
            // the plus button" is about that button, not about the bubble
            // answering under it.
            expect(resolveComposerPressTarget(frames, centre(findFrame(frames, 'add'))))
                .toBe('add');
        }
    });

    it('gives the bubble\'s press target no share of the group\'s hit rect', () => {
        // The acceptance criterion, stated as the geometric fact it is: no
        // point can land in two press targets at once, at any text height. A
        // sample of centres could pass while the rects overlapped at an edge;
        // this cannot.
        for (const text of textHeights) {
            expect(composerPressTargetsAreDisjoint(layout(text)), String(text)).toBe(true);
        }
        // And the corners agree with the middles: every corner of the capsule
        // reports the capsule, so the bubble's target does not reach under its
        // edges either.
        const frames = layout(22);
        const capsule = findFrame(frames, 'sessionCapsule');
        for (const point of [
            { x: capsule.x, y: capsule.y },
            { x: capsule.x + capsule.width, y: capsule.y },
            { x: capsule.x, y: capsule.y + capsule.height },
            { x: capsule.x + capsule.width, y: capsule.y + capsule.height },
        ]) {
            expect(resolveComposerPressTarget(frames, point)).toBe('sessionCapsule');
        }
    });

    it('gives send and the mic no material press at all, which is the cost of the ruling', () => {
        // They have no surface of their own (DROVE-254, DROVE-264) and drew the
        // shell's swell. With the shell calm they fall back to
        // `BubblePressable`'s own pressed state — what they have on any phone
        // without the material. Asserted rather than left as a gap, because it
        // is the one thing DROVE-343 takes away.
        const frames = layout(22);
        // 'spacer' was on this list and is not in the tree any more
        // (DROVE-353): the capsule is the row's flexible child, so the point
        // that used to be over the spacer is over the capsule and answers.
        for (const name of ['mic', 'send']) {
            expect(resolveComposerPressTarget(frames, centre(findFrame(frames, name))), name)
                .toBeNull();
        }
        expect(findFrame(frames, 'spacer')).toBeUndefined();
        expect([...COMPOSER_PRESS_TARGETS]).toEqual(['textRow', 'sessionCapsule', 'add']);
    });

    it('turns the shell\'s glass on for the field and for nothing else', () => {
        /**
         * THE END OF THE CHAIN (DROVE-343, second pass).
         *
         * The frames say where a press lands; this says what the material does
         * about it. The first pass answered the second half with a nested
         * surface on the text row, and a surface mounted at rest draws at
         * rest — Clay photographed the field as a lighter panel. So the shell
         * carries `isInteractive` again and it is scoped in TIME instead: on
         * while the text row is held, off otherwise.
         *
         * Resolved from the same tree as the press cases above, so the two
         * halves cannot drift: a point that reports the capsule must leave the
         * shell calm, at every text height.
         */
        for (const text of textHeights) {
            const frames = layout(text);
            const shellAt = (name: string) => resolveComposerShellInteractive(
                resolveComposerPressTarget(frames, centre(findFrame(frames, name))),
            );
            expect(shellAt('textRow'), String(text)).toBe(true);
            for (const quiet of ['modeSegment', 'readAloudSegment', 'effortSegment',
                'modelSegment', 'sessionCapsule', 'add', 'mic', 'send']) {
                expect(shellAt(quiet), `${quiet} at ${text}`).toBe(false);
            }
        }
    });

    it('still answers when zen mode draws neither the + nor the capsule', () => {
        // Nothing in the composer then owns a press but the text row, and the
        // resolver has to say so rather than throw on the frames that are not
        // there.
        const frames = layout(22, { withAdd: false, withControls: false });
        expect(resolveComposerPressTarget(frames, centre(findFrame(frames, 'textRow'))))
            .toBe('textRow');
        expect(composerPressTargetsAreDisjoint(frames)).toBe(true);
    });
});
