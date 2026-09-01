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
     * the discs. Then Clay, with the shipped one-row capsule on his phone:
     * "It's a bit crowded here and you have a little more space to spread
     * them out and you can make the model text smaller." So the segments go
     * 26 -> 28 and the name 13pt -> 12pt, and the fixed row lands at 250 —
     * still 49 better than DROVE-281's 299 and 10 better than DROVE-266's
     * 260, with one more control in the capsule than either had.
     */
    it('has 105pt at 393, 102 at 390, 87 at 375 and 32 at 320', () => {
        // Eight narrower than DROVE-284 left them: Clay's "spread them out"
        // put 2pt on each of the four glyph segments, and his "make the model
        // text smaller" is what made that affordable — at 12pt every name
        // NEEDS less than these budgets shrank by (the longest, `Gemini 3.1
        // Pro`, drops from 110 to 103 whole and from 91 to 85 at the floor).
        expect(composerModelBudget(393)).toBe(105);
        expect(composerModelBudget(390)).toBe(102);
        expect(composerModelBudget(375)).toBe(87);
        // 320 is positive again — it was -17 with DROVE-281's row — and it is
        // still not enough for any name. That is the one honest failure of the
        // single row and it is asserted below rather than smoothed over.
        expect(composerModelBudget(320)).toBe(32);
        // The Pro Max pair, which had the only single row before this ticket.
        expect(composerModelBudget(430)).toBe(142);
        expect(composerModelBudget(440)).toBe(152);
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
        expect(composerRowFixedWidth()).toBe(250);
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
        // 28, up from DROVE-284's 26: Clay ruled the ink-tight cut crowded —
        // "spread them out ... you have a little more space" — and the 12pt
        // name is what pays for the two points. The derivation is asserted on
        // its own below.
        expect(g.segment).toBe(28);
        expect(g.segment).toBeLessThan(g.disc);
        // What the narrowing is worth across the capsule's four glyph segments,
        // against what moving read-aloud in is worth on its own. The move alone
        // is 45 off the row for 29 back on it; the narrowing is 44 more.
        expect(4 * (g.disc - g.segment)).toBe(44);
        expect((g.disc + g.gap) - (g.segment + 1)).toBe(16);
        // 299 -> 250 is both together, and it is more than DROVE-281 spent.
        expect(299 - composerRowFixedWidth()).toBe(49);
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

    /**
     * THE NAME'S SIZE STEPPED DOWN ON CLAY'S INSTRUCTION, AND THE ESTIMATE
     * STEPPED WITH IT (DROVE-284 refinement).
     *
     * "You can make the model text smaller." 12 is DROVE-111's size coming
     * back, one step and no further — the name is the row's one VALUE and the
     * floor below is what keeps it legible. `glyphWidth` scales with the type
     * it estimates: DROVE-178's 7 at 13pt is 6.46 at 12, kept at 6.5 so the
     * model still only ever errs toward "does not fit".
     */
    it('draws the name at 12pt and estimates its width at that size', () => {
        expect(COMPOSER_MODEL_SEGMENT.fontSize).toBe(12);
        expect(COMPOSER_MODEL_SEGMENT.glyphWidth).toBe(6.5);
        expect(COMPOSER_MODEL_SEGMENT.glyphWidth)
            .toBeGreaterThanOrEqual(7 * COMPOSER_MODEL_SEGMENT.fontSize / 13);
        // The step is what pays for the wider segments: the longest name in
        // either picker needs 7pt less whole and 6 less at the floor, which is
        // within a point of the 8 the four segments took.
        expect(composerModelSegmentWidth('Gemini 3.1 Pro')).toBe(103);
        expect(composerModelSegmentWidth('Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale)).toBe(85);
        // And the smallest type anything actually draws is 0.824 of 12pt at
        // 375, about 9.9pt — a step, not a shrink to nothing.
        expect(12 * composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeGreaterThan(9.8);
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
        expect(composerModelSegmentWidth('Opus 5 1M')).toBe(71);
        expect(composerModelSegmentWidth('Opus 4.8 1M')).toBe(84);
    });

    it('scales rather than truncating, and only 375 and 390 ever scale', () => {
        // Smaller before shorter is the rule the segment draws by, so the
        // honest number is how long a name each size buys.
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        // 0.80 since DROVE-236, and DROVE-284 refuses to move it too: the
        // capsule's own row is gone, so this is the last line before a name is
        // cut, and lowering it would not rescue 320 anyway. The 12pt step does
        // not move it either — the argument is on the constant.
        expect(scale).toBe(0.8);
        // The three 14-glyph Gemini names, on the two supported widths where
        // anything still scales.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeCloseTo(0.824, 3);
        expect(composerModelScaleFor('GPT-5.6 Luna', 375)).toBeCloseTo(0.962, 3);
        // 390 IS THE AIR'S ONE NAMED SOFTENING (DROVE-284 refinement). The
        // 14-glyph names drew whole there at 26pt segments; at 28 they draw at
        // 0.989 — 1.1% under full size, on the one supported width between the
        // 375 floor and the 393 Clay reads. Asserted exactly, so the trade is
        // on the record rather than smoothed over.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 390)).toBeCloseTo(0.989, 3);
        // And 393 up, where the longest name in either picker draws WHOLE —
        // 393 is the phone the ticket is about and it gives nothing back.
        for (const width of [393, 430, 440]) {
            expect(composerModelScaleFor('Gemini 3.1 Pro', width), `at ${width}`).toBe(1);
        }
        for (const [name, width] of [['GPT-5.6 Luna', 375], ['GPT-5.6 Sol', 375],
            ['Gemini 3.1 Pro', 375], ['Gemini 3 Flash', 375],
            ['Gemini 3.1 Pro', 390]] as const) {
            expect(
                composerModelScaleFor(name, width),
                `${name} at ${width}`,
            ).toBeGreaterThanOrEqual(scale);
        }

        // WHAT THE ROW STILL BUYS, in reach rather than in any name the app
        // has. 393 holds 14 glyphs at FULL size — every name either picker
        // offers — and the smaller type REACHES further at the floor than
        // 13pt did (17 and 25 glyphs against 18 and 24 are the two directions
        // of the same trade; 375 is unchanged at [11, 14]).
        const longest = (width: number, fontScale: number) => {
            let glyphs = 0;
            while (composerModelSegmentWidth('x'.repeat(glyphs + 1), fontScale)
                <= composerModelBudget(width)) glyphs += 1;
            return glyphs;
        };
        expect([longest(375, 1), longest(375, scale)]).toEqual([11, 14]);
        expect([longest(393, 1), longest(393, scale)]).toEqual([14, 17]);
        expect([longest(430, 1), longest(430, scale)]).toEqual([20, 25]);
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
        // The shortest name in any picker, at the type floor and the 12pt size.
        const shortest = composerModelSegmentWidth('Opus 5', scale);
        expect(shortest).toBe(44);
        expect(withSegment(320, g.segment)).toBeLessThan(shortest);
        // At zero the interior would hold either name, so the honest statement
        // is not "no width works": it is that no width a SEGMENT can be works.
        // 25 buys the shortest name — under the 26 the padlock's measured ink
        // plus `controlGap` demands, DROVE-284's own floor — and 14 buys the
        // longest, under the 20pt glyph itself.
        expect(withSegment(320, 0)).toBe(144);
        let segment = g.segment;
        while (segment > 0 && withSegment(320, segment) < shortest) segment -= 1;
        expect(segment).toBe(25);
        let forLongest = g.segment;
        const longest = composerModelSegmentWidth('Gemini 3.1 Pro', scale);
        while (forLongest > 0 && withSegment(320, forLongest) < longest) forLongest -= 1;
        expect(forLongest).toBe(14);
        // Which is the point: both are under the least a segment can honestly
        // be, so 320 is not reachable by narrowing this segment further.
        expect(segment).toBeLessThan(Math.ceil(20 * 0.6875 + 12));
        expect(forLongest).toBeLessThan(20);
    });

    it('puts the floor where the arithmetic puts it, not where a device list does', () => {
        // `COMPOSER_ROW_MIN_MODEL_WIDTH` is a claim and this is the claim being
        // checked: the crossover is the narrowest width at which the longest
        // name the app draws still clears the type floor. 373 after the air
        // refinement — DROVE-284 left it at 371, DROVE-281 at 428, DROVE-266
        // at 389. The smaller name freed four points at the floor and the
        // wider segments took eight, so the line moved up by half the spend.
        const worst = 'Gemini 3.1 Pro';
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        let crossover = 320;
        while (composerModelSegmentWidth(worst, scale) > composerModelBudget(crossover)) {
            crossover += 1;
        }
        expect(crossover).toBe(373);
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(crossover);
        // BELOW EVERY PHONE THE APP SUPPORTS, which is the whole point of
        // spending the segments: 375 is the narrowest handset
        // statusRowLayout.spec.ts still supports and it clears this by 2 —
        // the two points that were NOT spent on the segments, which is why 28
        // is the ceiling and not a taste.
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBeLessThan(375);
    });

    /**
     * THE SEGMENT WIDTH IS DERIVED, NOT PICKED, AND THE DERIVATION FLIPPED
     * DIRECTION ON CLAY'S INSTRUCTION (DROVE-284, then its air refinement).
     *
     * DROVE-284 derived 26 bottom-up: the padlock's measured ink plus
     * `controlGap` either side, the least a segment could be, to win the
     * one-row fight. Clay, with that row on his phone: "It's a bit crowded
     * here and you have a little more space to spread them out and you can
     * make the model text smaller." So the width is now derived TOP-DOWN from
     * the space he granted: the widest whole point at which the longest name
     * either picker offers still clears the type floor on the narrowest
     * supported phone. This checks both directions of that arithmetic rather
     * than a value tuned until the tests went green.
     */
    it('sizes a glyph segment as wide as the 375 floor affords, and no wider', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        // Everything at 375 that is not the four glyph segments or the name:
        // the two insets, three discs, three gaps, three hairlines.
        const immovable = 2 * g.screenInset + 2 * g.bubbleInset
            + g.discs * g.disc + g.gaps * g.gap + g.dividers;
        expect(immovable).toBe(176);
        // What the longest name needs at the floor, at the 12pt size.
        const nameFloor = composerModelSegmentWidth('Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(nameFloor).toBe(85);
        // The widest whole point four segments can be with both held: 28.
        expect(Math.floor((375 - immovable - nameFloor) / g.glyphSegments)).toBe(g.segment);
        // One more point per segment cuts the longest name at 375, which is
        // the DROVE-138 failure and the reason 28 is a ceiling, not a taste.
        expect(375 - immovable - g.glyphSegments * (g.segment + 1)).toBeLessThan(nameFloor);
        // DROVE-284's bottom-up rule survives as the LOWER bound: never under
        // the padlock's measured ink (0.6875 of the em off Ionicons.ttf,
        // 13.75 at 20pt) plus `controlGap` either side.
        const ink = 20 * 0.6875;
        expect(g.segment).toBeGreaterThanOrEqual(
            Math.ceil(ink + 2 * MOBILE_COMPOSER_METRICS.controlGap),
        );
        // And the widest glyph the capsule draws, `eye` at 0.9355, now keeps
        // 4.6pt a side — a point more than DROVE-284 gave it, and well over
        // the 2pt DROVE-118 measured as where two marks read as one blob.
        const widest = (g.segment - 20 * 0.9355) / 2;
        expect(widest).toBeGreaterThan(4);
        expect(widest).toBeCloseTo(4.645, 3);
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
        expect(composerModelSegmentWidth('Opus 5') - glyphInstead).toBe(23);
        expect(composerModelSegmentWidth('Opus 4.8 1M') - glyphInstead).toBe(56);
        // What it would buy against what it would cost: the name draws whole at
        // and above the line as it is.
        expect(composerModelFits('Opus 5', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
        expect(composerModelFits('Opus 4.8 1M', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
    });
});
