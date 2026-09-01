/**
 * The composer's session label, and the room the model's name has on the
 * button row (DROVE-83, DROVE-111, DROVE-138, DROVE-178).
 *
 * The short names come from the model id, the mode and the effort are drawn
 * as glyphs, and the model's name is the capsule's third segment again. The
 * width arithmetic came back with it: DROVE-138 moved the name away because
 * six 63pt buttons were cutting `Opus 5 1M` to `Opus 5...`, so the point of
 * pinning it here is to show that the gap DROVE-153 opened is wide enough
 * that the same cut cannot happen twice.
 */
import { describe, expect, it } from 'vitest';
import {
    buildSessionPillLabel,
    COMPOSER_MODEL_SEGMENT,
    composerModelBudget,
    composerModelFits,
    composerModelScaleFor,
    composerModelSegmentWidth,
    composerRowFixedWidth,
    COMPOSER_BUBBLE_ROW_GEOMETRY,
    COMPOSER_ROW_MIN_MODEL_WIDTH,
    SESSION_PILL_SEPARATOR,
    shortModelName,
} from './sessionPillLabel';
import { MOBILE_COMPOSER_METRICS } from './agentInputLayout';

describe('shortModelName', () => {
    it('maps the Claude ids to the names people use', () => {
        expect(shortModelName({ key: 'claude-fable-5' })).toBe('Fable 5');
        expect(shortModelName({ key: 'claude-opus-5' })).toBe('Opus 5');
        expect(shortModelName({ key: 'claude-sonnet-5' })).toBe('Sonnet 5');
        expect(shortModelName({ key: 'claude-haiku-4-5' })).toBe('Haiku 4.5');
    });

    it('marks the 1M variant and drops a snapshot date', () => {
        expect(shortModelName({ key: 'claude-opus-5[1m]' })).toBe('Opus 5 1M');
        expect(shortModelName({ key: 'claude-sonnet-4-6-20260201' })).toBe('Sonnet 4.6');
    });

    it('maps from the id even when the picker named it after the id', () => {
        // includePaneModel adds a pane's model with name === key.
        expect(shortModelName({ key: 'claude-opus-4-8', name: 'claude-opus-4-8' })).toBe('Opus 4.8');
        expect(shortModelName({ key: 'claude-opus-5[1m]', name: 'Opus 5 [1M]' })).toBe('Opus 5 1M');
    });

    it('prefers modelId over key when both are present', () => {
        expect(shortModelName({ key: 'pane', modelId: 'claude-fable-5', name: 'pane' })).toBe('Fable 5');
    });

    it('keeps an unknown model as the picker names it, or as-is', () => {
        expect(shortModelName({ key: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' })).toBe('GPT-5.6 Sol');
        expect(shortModelName({ key: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' })).toBe('Gemini 2.5 Pro');
        expect(shortModelName({ key: 'my-fine-tune' })).toBe('my-fine-tune');
        expect(shortModelName({ key: 'claude-mythos-9' })).toBe('claude-mythos-9');
    });

    it('is null with no model', () => {
        expect(shortModelName(null)).toBeNull();
        expect(shortModelName(undefined)).toBeNull();
        expect(shortModelName({})).toBeNull();
    });
});

describe('buildSessionPillLabel', () => {
    it('reads mode, short model, effort with the middle dot', () => {
        const label = buildSessionPillLabel({
            modeLabel: 'Yolo',
            model: { key: 'claude-fable-5', name: 'Fable 5' },
            effortLabel: 'High',
        });
        expect(label).toEqual({ mode: 'Yolo', model: 'Fable 5', effort: 'High', text: 'Yolo · Fable 5 · High' });
        expect(SESSION_PILL_SEPARATOR).toBe(' · ');
    });

    it('drops a segment the session does not have rather than leaving a dangling dot', () => {
        expect(buildSessionPillLabel({ modeLabel: 'Default', model: { key: 'claude-opus-5' } }).text)
            .toBe('Default · Opus 5');
        expect(buildSessionPillLabel({ model: { key: 'claude-opus-5' }, effortLabel: 'Max' }).text)
            .toBe('Opus 5 · Max');
        expect(buildSessionPillLabel({ modeLabel: '  ' }).text).toBe('');
    });

});


/**
 * The budget, at the widths that decide something.
 *
 * `statusRowLayout.spec.ts` calls 375 the narrowest phone still supported and
 * 393 the handset Clay is on. 390 joins them because the crossover has moved
 * between the two before now. 320 is below the supported floor and is measured
 * anyway, because DROVE-284 is where it stops being rescuable.
 */
describe('the model segment on the button row (DROVE-178)', () => {
    /**
     * ONE ROW AT EVERY WIDTH, AND WHAT PAID FOR IT (DROVE-284).
     *
     * Clay, on DROVE-281's second row: "Dude I don't like that extra row. Add
     * the reading mode whatever thing to the group and keep it all on the same
     * row as send and +." Read-aloud stops being a loose disc and becomes a
     * capsule segment, and the capsule's glyph segments stop being as wide as
     * the discs. The fixed row goes 299 -> 242, which is 18pt better than
     * DROVE-266 left it with one fewer control on the row.
     */
    it('has 113pt at 393, 110 at 390, 95 at 375 and 40 at 320', () => {
        expect(composerModelBudget(393)).toBe(113);
        expect(composerModelBudget(390)).toBe(110);
        expect(composerModelBudget(375)).toBe(95);
        // 320 is positive again — it was -17 with DROVE-281's row — and it is
        // still not enough for any name. That is the one honest failure of the
        // single row and it is asserted below rather than smoothed over.
        expect(composerModelBudget(320)).toBe(40);
        // The Pro Max pair, which had the only single row before this ticket.
        expect(composerModelBudget(430)).toBe(150);
        expect(composerModelBudget(440)).toBe(160);
    });

    /**
     * The budget is only worth a number if the terms it subtracts are the row
     * that is drawn, and for three tickets they were not: the `+` was counted
     * after DROVE-196 put it beside the field, the card's padding was counted
     * on top of the screen inset after DROVE-196 moved that padding onto the
     * row, and `audioButtons: 3` went stale the moment DROVE-236 collapsed the
     * audio pair, which left the budget 45pt pessimistic.
     *
     * So the claim is arithmetic rather than a remembered number: everything
     * on the row, plus the name's budget, is exactly the phone. A term that
     * goes stale fails this before it reaches a screenshot.
     */
    it('adds up to the phone, which is what makes the budget checkable', () => {
        for (const width of [320, 375, 390, 393, 430, 440]) {
            expect(
                2 * COMPOSER_BUBBLE_ROW_GEOMETRY.screenInset
                + 2 * COMPOSER_BUBBLE_ROW_GEOMETRY.bubbleInset
                + composerRowFixedWidth()
                + composerModelBudget(width),
                `the row at ${width}`,
            ).toBe(width);
        }
    });

    /** The row Clay drew, term by term, so a control that appears or vanishes shows up here. */
    it('counts THREE discs, three gaps and FOUR glyph segments since DROVE-284', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        // The `+`, the MIC and send. Read-aloud was the fourth and is a capsule
        // segment now.
        expect(g.discs).toBe(3);
        expect(g.disc).toBe(39);
        expect(g.gaps).toBe(3);
        // No audio capsule left either: the pair collapsed into one button in
        // DROVE-236, and `audioButtons: 3` was stale from that moment.
        expect(g).not.toHaveProperty('audioButtons');
        expect(g).not.toHaveProperty('audioButton');
        // Permission mode, the auto-accept bolt, READ-ALOUD and the effort
        // gauge.
        expect(g.glyphSegments).toBe(4);
        // THREE RULES FOR FIVE SEGMENTS. The padlock and the bolt are the
        // permission pair and they touch (DROVE-281); the hairlines mark where
        // the subject changes, permission -> read-aloud -> effort -> the name.
        expect(g.dividers).toBe(3);
        expect(composerRowFixedWidth()).toBe(242);
    });

    /**
     * A SEGMENT IS NOT A DISC, WHICH IS MOST OF WHAT BOUGHT THE ROW BACK
     * (DROVE-284).
     *
     * DROVE-266's spec asserted `disc === segment`, which was true and was
     * never a decision: `size` set the capsule's height and its segments' width
     * from one number. A disc needs its own diameter because it is a circle; a
     * segment is bounded by hairlines, which is the argument
     * `COMPOSER_MODEL_SEGMENT.paddingHorizontal` already won one segment over.
     */
    it('draws a glyph segment narrower than a disc, and says what that is worth', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        expect(g.segment).toBe(26);
        expect(g.segment).toBeLessThan(g.disc);
        // What the narrowing is worth across the capsule's four glyph segments,
        // against what moving read-aloud in is worth on its own. The move alone
        // is 45 off the row for 27 back on it; the narrowing is 52 more.
        expect(4 * (g.disc - g.segment)).toBe(52);
        expect((g.disc + g.gap) - (g.segment + 1)).toBe(18);
        // 299 -> 242 is both together, and it is more than DROVE-281 spent.
        expect(299 - composerRowFixedWidth()).toBe(57);
    });

    it('keeps the bare-glyph controls at the disc’s width, which is why the cost is 45', () => {
        // The obvious saving, refused and written down. Send draws no circle at
        // all now and the mic draws none at rest, so their INK is about 18pt and
        // a narrower box would hand the name back some of this. Both still draw
        // a full disc on one of their faces — Stop and the gate's lock for send,
        // an open capture for the mic — so a narrower box would either put a
        // second size of circle on a row DROVE-214 gave one, or resize per face
        // and reflow the row every time the agent starts a turn.
        //
        // THE CAPSULE'S SEGMENTS ARE NOT THAT CASE (DROVE-284), which is why one
        // narrowed and these did not: a segment draws no circle on any face.
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        expect(g.disc).toBe(MOBILE_COMPOSER_METRICS.primaryActionSize);
        // 45 exactly: one disc and one gap, which is what read-aloud gave back.
        expect(g.disc + g.gap).toBe(45);
    });

    it('gives 8 back out of the segment’s own padding, which is DROVE-264’s give', () => {
        // The give, measured rather than described. Without the padding cut,
        // `Gemini 3.1 Pro` falls under the floor at 375; with it, it clears.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(6);
        const withOldPadding = (name: string, width: number) =>
            (composerModelBudget(width) - 2 * 10) / (name.length * COMPOSER_MODEL_SEGMENT.glyphWidth);
        expect(withOldPadding('Gemini 3.1 Pro', 375)).toBeLessThan(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375))
            .toBeGreaterThanOrEqual(COMPOSER_MODEL_SEGMENT.minimumFontScale);
    });

    it('draws every Claude name whole at 375 and up, at full size', () => {
        // `Opus 4.8 1M` is the longest of the family and the one that has to
        // hold. It draws WHOLE on every supported width, which after DROVE-284
        // is every width the app runs on rather than the Pro Max pair.
        for (const name of ['Fable 5', 'Opus 5 1M', 'Opus 5', 'Sonnet 5', 'Haiku 4.5', 'Opus 4.8 1M']) {
            for (const width of [375, 390, 393, 430, 440]) {
                expect(composerModelFits(name, width), `${name} at ${width}`).toBe(true);
            }
        }
        expect(composerModelSegmentWidth('Opus 5 1M')).toBe(75);
        expect(composerModelSegmentWidth('Opus 4.8 1M')).toBe(89);
    });

    it('scales rather than truncating, and 375 is the only supported width that scales', () => {
        // Smaller before shorter is the rule the segment draws by, so the
        // honest number is how long a name each size buys.
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        // 0.80 since DROVE-236, and DROVE-284 refuses to move it too: the
        // capsule's own row is gone, so this is the last line before a name is
        // cut, and lowering it would not rescue 320 anyway.
        expect(scale).toBe(0.8);
        // The three 14-glyph Gemini names, on the one supported width where
        // anything still scales.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeCloseTo(0.847, 3);
        expect(composerModelScaleFor('GPT-5.6 Luna', 375)).toBeCloseTo(0.988, 3);
        // And 390 up, where the longest name in either picker draws WHOLE.
        for (const width of [390, 393, 430, 440]) {
            expect(composerModelScaleFor('Gemini 3.1 Pro', width), `at ${width}`).toBe(1);
        }
        for (const [name, width] of [['GPT-5.6 Luna', 375], ['GPT-5.6 Sol', 375],
            ['Gemini 3.1 Pro', 375], ['Gemini 3 Flash', 375]] as const) {
            expect(
                composerModelScaleFor(name, width),
                `${name} at ${width}`,
            ).toBeGreaterThanOrEqual(scale);
        }

        // WHAT THE TICKET ACTUALLY BUYS, in reach rather than in any name the
        // app has. 393 goes from a second row to 14 glyphs at FULL size, which
        // is more than DROVE-266's single row bought at 430.
        const longest = (width: number, fontScale: number) => {
            let glyphs = 0;
            while (composerModelSegmentWidth('x'.repeat(glyphs + 1), fontScale)
                <= composerModelBudget(width)) glyphs += 1;
            return glyphs;
        };
        expect([longest(375, 1), longest(375, scale)]).toEqual([11, 14]);
        expect([longest(393, 1), longest(393, scale)]).toEqual([14, 18]);
        expect([longest(430, 1), longest(430, scale)]).toEqual([19, 24]);
    });

    it('is what the row could NOT hold before DROVE-153, which is why DROVE-138 moved it', () => {
        // Six 63pt buttons left 63 for the name, and `Opus 5 1M` needs 75.
        expect(composerModelSegmentWidth('Opus 5 1M')).toBeGreaterThan(63);
        // The single row beats that on every phone the app supports now.
        expect(composerModelBudget(375)).toBeGreaterThan(63);
    });

    /**
     * EVERY SUPPORTED WIDTH HOLDS EVERY NAME, AND 320 HOLDS NONE (DROVE-284).
     *
     * DROVE-264 asserted the failure rather than hiding it and DROVE-266 built
     * the capsule's own row to answer it. Clay has now refused that row by
     * name, so the failure is back at 320 and only at 320, and it is asserted
     * here for the same reason DROVE-264 asserted it: it is the fact that
     * decides the layout.
     */
    it('holds every name on every supported width, and none at 320', () => {
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        const every = ['Opus 4.8 1M', 'Sonnet 4.5', 'Haiku 4.5', 'Opus 5 1M',
            'Sonnet 5', 'Fable 5', 'Opus 5', 'GPT-5.6 Luna', 'Gemini 3.1 Pro'];
        for (const name of every) {
            for (const width of [375, 390, 393, 430, 440]) {
                expect(
                    composerModelSegmentWidth(name, scale),
                    `${name} at ${width}`,
                ).toBeLessThanOrEqual(composerModelBudget(width));
            }
            // And none of them at 320, which is DROVE-264's finding unchanged.
            expect(
                composerModelSegmentWidth(name, scale),
                `${name} at 320`,
            ).toBeGreaterThan(composerModelBudget(320));
        }
        // 393 IS THE WIDTH CLAY READS and it is the one this ticket is about.
        // Every name in either picker draws there WHOLE, at full type size, on
        // one row — where DROVE-281 gave it a second row for `Opus 5`.
        for (const name of every) {
            expect(composerModelFits(name, 393), `${name} whole at 393`).toBe(true);
        }
    });

    /**
     * 320 IS NOT FIXABLE BY REARRANGING THIS ROW, and that is worth an
     * assertion rather than a paragraph (DROVE-284).
     *
     * The ticket's instruction is one row, so the question a reader will ask is
     * whether a bit more shaving would have rescued 320 too. It would not: with
     * the capsule's four glyph segments at ZERO width the shortest name in any
     * picker still fails, because three discs, three gaps and the two insets
     * already take 173 of a 320pt screen.
     */
    it('cannot rescue 320 by shrinking the segments, however far they go', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        const withSegment = (width: number, segment: number) => width
            - 2 * g.screenInset - 2 * g.bubbleInset
            - (g.discs * g.disc + g.gaps * g.gap + g.glyphSegments * segment + g.dividers);
        // The shortest name in any picker, at the type floor.
        const shortest = composerModelSegmentWidth('Opus 5', scale);
        expect(shortest).toBe(46);
        expect(withSegment(320, g.segment)).toBeLessThan(shortest);
        // At zero the interior would hold either name, so the honest statement
        // is not "no width works": it is that no width a SEGMENT can be works.
        // 24 buys the shortest name and 13 the longest, and the capsule draws a
        // 20pt glyph, which fits in neither.
        expect(withSegment(320, 0)).toBe(144);
        let segment = g.segment;
        while (segment > 0 && withSegment(320, segment) < shortest) segment -= 1;
        expect(segment).toBe(24);
        let forLongest = g.segment;
        const longest = composerModelSegmentWidth('Gemini 3.1 Pro', scale);
        while (forLongest > 0 && withSegment(320, forLongest) < longest) forLongest -= 1;
        expect(forLongest).toBe(13);
        // Which is the point: both are under the 20pt glyph the capsule draws,
        // so 320 is not reachable by narrowing this segment further.
        expect(segment).toBeLessThan(26);
        expect(forLongest).toBeLessThan(20);
    });

    it('puts the floor where the arithmetic puts it, not where a device list does', () => {
        // `COMPOSER_ROW_MIN_MODEL_WIDTH` is a claim and this is the claim being
        // checked: the crossover is the narrowest width at which the longest
        // name the app draws still clears the type floor. 371 after DROVE-284,
        // where DROVE-281 left it at 428 and DROVE-266 at 389.
        const worst = 'Gemini 3.1 Pro';
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        let crossover = 320;
        while (composerModelSegmentWidth(worst, scale) > composerModelBudget(crossover)) {
            crossover += 1;
        }
        expect(crossover).toBe(371);
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(crossover);
        // BELOW EVERY PHONE THE APP SUPPORTS, which is the whole point of
        // spending the segments: 375 is the narrowest handset
        // statusRowLayout.spec.ts still supports and it clears this by 4.
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBeLessThan(375);
    });

    /**
     * THE SEGMENT WIDTH IS DERIVED, NOT PICKED (DROVE-284).
     *
     * It is the padlock's measured ink at 20pt plus `controlGap` either side,
     * and this checks that the number the layout uses is that arithmetic rather
     * than a value tuned until the tests went green.
     */
    it('sizes a glyph segment off the measured ink, not off the disc', () => {
        // lock-closed is 0.6875 of the em, measured off Ionicons.ttf the way
        // IONICON_INK_RATIO is. At the capsule's 20pt glyph that is 13.75.
        const ink = 20 * 0.6875;
        expect(Math.ceil(ink + 2 * MOBILE_COMPOSER_METRICS.controlGap))
            .toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.segment);
        // And the widest glyph the capsule draws, `eye` at 0.9355, still keeps
        // more than the 2pt DROVE-118 measured as the distance at which two
        // marks read as one blob.
        const widest = (COMPOSER_BUBBLE_ROW_GEOMETRY.segment - 20 * 0.9355) / 2;
        expect(widest).toBeGreaterThan(3);
    });

    /**
     * THE CANDIDATE THAT WAS REFUSED, on the record so it is not quietly taken
     * next time (DROVE-236).
     *
     * Dropping the NAME for a glyph makes every width comfortable at a stroke,
     * 320 included. It is refused because the name is the only thing on this row
     * carrying a value rather than a state: a padlock reads as a mode and a dial
     * reads as a level, and no glyph reads as "Opus 5". DROVE-138 was filed
     * about exactly this name being cut, and DROVE-178 brought it back up here
     * after Clay circled it on the status row and drew an arrow at the gap.
     */
    it('would gain room by dropping the name, and does not', () => {
        // A glyph segment where the name is would be the capsule's segment.
        const glyphInstead = COMPOSER_BUBBLE_ROW_GEOMETRY.segment;
        expect(composerModelSegmentWidth('Opus 5') - glyphInstead).toBe(28);
        expect(composerModelSegmentWidth('Opus 4.8 1M') - glyphInstead).toBe(63);
        // What it would buy against what it would cost: the name draws whole at
        // and above the line as it is.
        expect(composerModelFits('Opus 5', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
        expect(composerModelFits('Opus 4.8 1M', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
    });
});
