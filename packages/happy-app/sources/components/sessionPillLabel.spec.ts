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
        // DROVE-324: the minor version reads as `5.1`, so the pill shows the
        // model actually picked rather than collapsing it onto Fable 5.
        expect(shortModelName({ key: 'claude-fable-5-1' })).toBe('Fable 5.1');
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
    it('has 136pt at 393, 133 at 390, 118 at 375 and 63 at 320', () => {
        // TWENTY-SEVEN WIDER THAN DROVE-320 LEFT THEM (DROVE-331). Clay:
        // "because of the toggles in the sheet for auto-accept, we don't need
        // it also in the bar group." The bolt was a 27pt segment with no
        // hairline of its own, and the name is where its width goes — the
        // segments beside it keep their 27, argued on
        // `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`. Before that, four wider
        // than the air refinement (DROVE-320): one point off each of what were
        // then four glyph segments, to pay for the 13pt name.
        expect(composerModelBudget(393)).toBe(136);
        expect(composerModelBudget(390)).toBe(133);
        expect(composerModelBudget(375)).toBe(118);
        // 320 holds the SHORT names now — it was -17 with DROVE-281's row and
        // 36 after DROVE-320, under `Opus 5`'s 44 at the floor. 63 clears the
        // five short Claude names and still cuts the long ones, which is the
        // honest failure halved rather than smoothed over, and it is asserted
        // below name by name.
        expect(composerModelBudget(320)).toBe(63);
        // The Pro Max pair, which had the only single row before DROVE-284.
        expect(composerModelBudget(430)).toBe(173);
        expect(composerModelBudget(440)).toBe(183);
        // Every one of them is DROVE-320's number plus one segment.
        for (const [width, then] of [[320, 36], [375, 91], [390, 106], [393, 109], [430, 146], [440, 156]] as const) {
            expect(composerModelBudget(width) - then, `${width}`).toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.segment);
        }
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
    it('counts THREE discs, three gaps and THREE glyph segments since DROVE-331', () => {
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
        // Permission mode, READ-ALOUD and the effort gauge. Four from DROVE-284
        // to DROVE-331, while DROVE-281's auto-accept bolt sat second; Clay
        // ruled it redundant with the switch in the padlock's sheet.
        expect(g.glyphSegments).toBe(3);
        // THREE RULES FOR FOUR SEGMENTS, one between every pair. The count did
        // not move when the bolt left, because the bolt never had a rule: it
        // touched the padlock (DROVE-281). The hairlines still mark where the
        // subject changes, permission -> read-aloud -> effort -> the name.
        expect(g.dividers).toBe(3);
        expect(g.dividers).toBe(g.glyphSegments);
        // 219 since DROVE-331 took the bolt's 27 off the row. 246 after
        // DROVE-320 took a point back off each glyph segment to pay for the
        // name's type, 250 with the air refinement, 242 before it.
        expect(composerRowFixedWidth()).toBe(219);
        expect(246 - composerRowFixedWidth()).toBe(g.segment);
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
        // 27: DROVE-284's ink-tight 26, plus ONE of the two points Clay's
        // "spread them out" granted. He granted them against "you can make
        // the model text smaller", and DROVE-320 is him taking that payment
        // back — "I told you to make this bigger" — so one point goes back to
        // the type and one stays as air. The derivation is asserted on its
        // own below and still returns this number rather than being told it.
        expect(g.segment).toBe(27);
        expect(g.segment).toBeLessThan(g.disc);
        // What the narrowing was worth across the four glyph segments the
        // capsule had at DROVE-284, against what moving read-aloud in is worth
        // on its own. The move alone is 45 off the row for 28 back on it; the
        // narrowing was 48 more, and 36 of that is still on the row's three.
        expect(4 * (g.disc - g.segment)).toBe(48);
        expect(g.glyphSegments * (g.disc - g.segment)).toBe(36);
        expect((g.disc + g.gap) - (g.segment + 1)).toBe(17);
        // 299 -> 246 was both together, and it was more than DROVE-281 spent.
        // 299 -> 219 adds DROVE-331's bolt leaving at the 27 it had reached.
        expect(299 - composerRowFixedWidth()).toBe(80);
        expect(80 - 53).toBe(g.segment);
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

    it('gives 10 back out of the segment’s own padding, and derives the 5 from the capsule', () => {
        // The give, measured rather than described. Without the padding cut,
        // `Gemini 3.1 Pro` fell under the floor at 375 until DROVE-331 handed
        // the name the bolt's 27; now it clears 375 with either padding, and
        // the cut decides at the crossover instead: with the old 10 the
        // longest name is under the floor at `COMPOSER_ROW_MIN_MODEL_WIDTH`,
        // with 5 it clears — which is what "the crossover is 346" means.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(5);
        const withOldPadding = (name: string, width: number) =>
            (composerModelBudget(width) - 2 * 10) / (name.length * COMPOSER_MODEL_SEGMENT.glyphWidth);
        expect(withOldPadding('Gemini 3.1 Pro', COMPOSER_ROW_MIN_MODEL_WIDTH))
            .toBeLessThan(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(composerModelScaleFor('Gemini 3.1 Pro', COMPOSER_ROW_MIN_MODEL_WIDTH))
            .toBeGreaterThanOrEqual(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(withOldPadding('Gemini 3.1 Pro', 375)).toBeGreaterThanOrEqual(1);
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBe(1);
        // 5 IS DERIVED, WHICH IS THE HALF OF DROVE-320 THAT COULD MOST EASILY
        // HAVE BEEN A SHAVE. 6 was `controlGap` — the air BETWEEN two objects
        // on the row — applied to a clearance INSIDE one, so it was borrowed
        // from the wrong family. The family this inset belongs to is the four
        // glyph segments beside it, which are bounded by the same hairlines,
        // and the binding member is the widest mark the capsule draws: `eye`
        // at 0.9355 of the em. The rule is that clearance, rounded UP to a
        // whole point, so the name is never held tighter than its neighbours'
        // ink and never given more air than the capsule itself allows.
        const eyeClearance = (COMPOSER_BUBBLE_ROW_GEOMETRY.segment - 20 * 0.9355) / 2;
        expect(eyeClearance).toBeCloseTo(4.145, 3);
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(Math.ceil(eyeClearance));
        // And it is NOT merely the smallest thing that fits: rounding up is
        // what makes it 5 rather than 4.145, and 4 would leave the name more
        // room than this asks for.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBeGreaterThan(eyeClearance);
    });

    /**
     * THE NAME'S SIZE STEPPED BACK UP ON CLAY'S INSTRUCTION, AND THE ESTIMATE
     * STEPPED WITH IT (DROVE-320).
     *
     * "I told you to make this bigger." 13 is DROVE-178's size coming back,
     * one step and no further — the name is the row's one VALUE and the floor
     * below is what keeps it legible. `glyphWidth` scales with the type it
     * estimates and 7 is DROVE-178's own value at this size, which is also the
     * least the invariant permits, so the model still only ever errs toward
     * "does not fit".
     *
     * THE TRAP THIS TEST EXISTS FOR: a bigger base size makes every name need
     * more ink, so the SAME budget yields a SMALLER scale and the longest names
     * walk through the type floor into DROVE-138's cut. The width was bought
     * first, which is why the last assertion here goes UP rather than down.
     */
    it('draws the name at 13pt and estimates its width at that size', () => {
        expect(COMPOSER_MODEL_SEGMENT.fontSize).toBe(13);
        expect(COMPOSER_MODEL_SEGMENT.glyphWidth).toBe(7);
        expect(COMPOSER_MODEL_SEGMENT.glyphWidth)
            .toBeGreaterThanOrEqual(7 * COMPOSER_MODEL_SEGMENT.fontSize / 13);
        // What the step COSTS, which is the half a bigger-type ticket forgets:
        // the longest name in either picker needs 5pt more whole and 4 more at
        // the floor. The segments and the padding hand over 6, so the name
        // ends up with room to spare rather than borrowing from the floor.
        expect(composerModelSegmentWidth('Gemini 3.1 Pro')).toBe(108);
        expect(composerModelSegmentWidth('Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale)).toBe(89);
        // And the smallest type anything actually draws WAS 0.827 of 13pt at
        // 375, about 10.7pt — where the 12pt name drew 9.89pt at 0.824. Both
        // the type AND the scale improved, which is the check that the point
        // was PAID for rather than borrowed from the narrowest phone. Since
        // DROVE-331 it is 13pt whole at 375; the inequalities are kept because
        // they are the check, and the equality is the new fact.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBe(1);
        expect(13 * composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeGreaterThan(10.7);
        expect(13 * composerModelScaleFor('Gemini 3.1 Pro', 375))
            .toBeGreaterThan(12 * (75 / 91));
        // Back over the 10.4pt minimum the 12pt step gave up, without moving
        // the floor to get there — the thing DROVE-284 said it could not do.
        expect(13 * composerModelScaleFor('Gemini 3.1 Pro', 375))
            .toBeGreaterThan(13 * COMPOSER_MODEL_SEGMENT.minimumFontScale);
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
        expect(composerModelSegmentWidth('Opus 5 1M')).toBe(73);
        expect(composerModelSegmentWidth('Opus 4.8 1M')).toBe(87);
    });

    it('scales rather than truncating, and no supported width scales any more (DROVE-331)', () => {
        // Smaller before shorter is the rule the segment draws by, so the
        // honest number is how long a name each size buys.
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        // 0.80 since DROVE-236, and DROVE-284 refuses to move it too: the
        // capsule's own row is gone, so this is the last line before a name is
        // cut, and lowering it would not rescue 320 anyway. Neither the 12pt
        // step nor DROVE-320's 13pt step moves it — the argument is on the
        // constant, and the point of buying the width first is that the floor
        // did not have to move. DROVE-331 does not move it either; it moves
        // the width at which it is reached, 373 -> 346, under every phone.
        expect(scale).toBe(0.8);
        // The three 14-glyph Gemini names, on the two supported widths that
        // used to scale. 375 went 0.824 -> 0.827 at DROVE-320 and 390 was the
        // air's one named softening at 0.980; the bolt's 27 clears both, so
        // every name either picker offers draws WHOLE at 13pt on every
        // supported width, and 393 — the phone Clay reads — gives nothing
        // back. Asserted exactly, at every width, so a segment coming back
        // onto the row shows up here as a scale under 1.
        for (const width of [375, 390, 393, 430, 440]) {
            for (const name of ['GPT-5.6 Luna', 'GPT-5.6 Sol', 'Gemini 3.1 Pro', 'Gemini 3 Flash']) {
                expect(composerModelScaleFor(name, width), `${name} at ${width}`).toBe(1);
            }
        }
        // And the type on the glass at 375 is the full 13, against the 10.74
        // DROVE-320 bought and the 9.89 before it.
        expect(13 * composerModelScaleFor('Gemini 3.1 Pro', 375)).toBe(13);

        // WHAT THE ROW STILL BUYS, in reach rather than in any name the app
        // has. THE TWO WIDTHS THAT DECIDE ANYTHING GAIN FOUR GLYPHS AT FULL
        // SIZE: 375 goes [11, 14] -> [15, 19] and 393 goes [14, 17] ->
        // [18, 22], because 27pt is 3.86 glyphs at 7pt each and the floor's
        // 5.6pt buys one more. 430 goes [19, 24] -> [23, 29].
        const longest = (width: number, fontScale: number) => {
            let glyphs = 0;
            while (composerModelSegmentWidth('x'.repeat(glyphs + 1), fontScale)
                <= composerModelBudget(width)) glyphs += 1;
            return glyphs;
        };
        expect([longest(375, 1), longest(375, scale)]).toEqual([15, 19]);
        expect([longest(393, 1), longest(393, scale)]).toEqual([18, 22]);
        expect([longest(430, 1), longest(430, scale)]).toEqual([23, 29]);
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
    it('holds every name on every supported width, and only the short ones at 320', () => {
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
        }
        // AT 320 THE LINE RUNS THROUGH THE LIST (DROVE-331). DROVE-264 found
        // none held; the bolt's 27 holds the five short Claude names at the
        // floor and still cuts the four long ones. Name by name, so a segment
        // coming back moves a name across the line here before it reaches a
        // phone.
        const holdsAt320 = (name: string) =>
            composerModelSegmentWidth(name, scale) <= composerModelBudget(320);
        expect(every.filter(holdsAt320)).toEqual(['Haiku 4.5', 'Opus 5 1M', 'Sonnet 5', 'Fable 5', 'Opus 5']);
        expect(every.filter((name) => !holdsAt320(name)))
            .toEqual(['Opus 4.8 1M', 'Sonnet 4.5', 'GPT-5.6 Luna', 'Gemini 3.1 Pro']);
        // 393 IS THE WIDTH CLAY READS and it is the one this ticket is about.
        // Every name in either picker draws there WHOLE, at full type size, on
        // one row — where DROVE-281 gave it a second row for `Opus 5`.
        for (const name of every) {
            expect(composerModelFits(name, 393), `${name} whole at 393`).toBe(true);
        }
    });

    /**
     * 320 IS ONLY HALF FIXABLE BY REARRANGING THIS ROW, and that is worth an
     * assertion rather than a paragraph (DROVE-284, halved by DROVE-331).
     *
     * The ticket's instruction is one row, so the question a reader will ask
     * is whether a bit more shaving would rescue 320 too. For the shortest
     * name it no longer has to: the bolt's 27 holds `Opus 5` at the floor with
     * the segments exactly as drawn. For the longest it would not: the three
     * glyph segments would have to come down to 18, under the 20pt glyph
     * itself, so it is not a width a segment can be.
     */
    it('holds the shortest name at 320 as drawn, and cannot buy the longest by shrinking the segments', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        const withSegment = (width: number, segment: number) => width
            - 2 * g.screenInset - 2 * g.bubbleInset
            - (g.discs * g.disc + g.gaps * g.gap + g.glyphSegments * segment + g.dividers);
        // The shortest name in any picker, at the type floor and the 13pt size.
        const shortest = composerModelSegmentWidth('Opus 5', scale);
        expect(shortest).toBe(44);
        // 63 against 44: it holds as drawn, with 19 to spare. Until DROVE-331
        // this was 36 against 44 and the segments would have had to come down
        // to 25 — under DROVE-284's ink floor of 26 — to buy it.
        expect(withSegment(320, g.segment)).toBe(63);
        expect(withSegment(320, g.segment)).toBeGreaterThanOrEqual(shortest);
        let segment = g.segment;
        while (segment > 0 && withSegment(320, segment) < shortest) segment -= 1;
        expect(segment).toBe(g.segment);
        // At zero the interior is the same 144 it was, because the bolt took
        // its width with it and the terms that are not segments did not move.
        expect(withSegment(320, 0)).toBe(144);
        // The longest name is still out of reach: 18 buys it, under the 20pt
        // glyph itself. It was 13 with four segments sharing the shrink.
        let forLongest = g.segment;
        const longest = composerModelSegmentWidth('Gemini 3.1 Pro', scale);
        while (forLongest > 0 && withSegment(320, forLongest) < longest) forLongest -= 1;
        expect(forLongest).toBe(18);
        expect(forLongest).toBeLessThan(20);
        // And 27 itself is still over DROVE-284's ink floor, which is the
        // width the shortest name is held at.
        expect(g.segment).toBeGreaterThanOrEqual(Math.ceil(20 * 0.6875 + 12));
    });

    it('puts the floor where the arithmetic puts it, not where a device list does', () => {
        // `COMPOSER_ROW_MIN_MODEL_WIDTH` is a claim and this is the claim being
        // checked: the crossover is the narrowest width at which the longest
        // name the app draws still clears the type floor. 346 since DROVE-331;
        // 373 after the air refinement — DROVE-284 left it at 371, DROVE-281
        // at 428, DROVE-266 at 389. The smaller name freed four points at the
        // floor and the wider segments took eight, so the line moved up by
        // half the spend; then the bolt left and it moved down by a segment.
        const worst = 'Gemini 3.1 Pro';
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        let crossover = 320;
        while (composerModelSegmentWidth(worst, scale) > composerModelBudget(crossover)) {
            crossover += 1;
        }
        expect(crossover).toBe(346);
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(crossover);
        // 373 until DROVE-331, and the bolt's segment is the whole of the move:
        // 27 down, no hairline with it.
        expect(373 - COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.segment);
        // BELOW EVERY PHONE THE APP SUPPORTS, which is the whole point of
        // spending the segments: 375 is the narrowest handset
        // statusRowLayout.spec.ts still supports and it clears this by 29 —
        // the two points that were NOT spent on the segments at DROVE-320,
        // plus the bolt's 27.
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBeLessThan(375);
        expect(375 - COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(2 + COMPOSER_BUBBLE_ROW_GEOMETRY.segment);
    });

    /**
     * THE SEGMENT WIDTH IS DERIVED, NOT PICKED, AND THE DERIVATION FLIPPED
     * DIRECTION ON CLAY'S INSTRUCTION (DROVE-284, then its air refinement),
     * AND STOPPED BINDING WHEN THE BOLT LEFT (DROVE-331).
     *
     * DROVE-284 derived 26 bottom-up: the padlock's measured ink plus
     * `controlGap` either side, the least a segment could be, to win the
     * one-row fight. Clay, with that row on his phone: "It's a bit crowded
     * here and you have a little more space to spread them out and you can
     * make the model text smaller." So the width was then derived TOP-DOWN
     * from the space he granted: the widest whole point at which the longest
     * name either picker offers still clears the type floor on the narrowest
     * supported phone. With four segments that ceiling was 27 and it bound.
     *
     * DROVE-331 takes the auto-accept bolt off the row, so the same 110 is
     * shared three ways and the ceiling is 36. The segment does NOT follow it:
     * the width the bolt held is the model name's by that ticket's own
     * criterion, and 27 is Clay's ruling twice over, "spread them out" and
     * "make this bigger", which nobody has reopened. So 27 now stands on the
     * lower bound alone — the ink floor plus the one point of granted air —
     * and the 3 x 9 the ceiling would allow is exactly the 27 the name got.
     * This checks all three numbers rather than a value tuned until the tests
     * went green.
     */
    it('keeps a glyph segment at 27 under a 375 ceiling that has moved to 36, and hands the gap to the name', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        // Everything at 375 that is not the glyph segments or the name: the
        // two insets, three discs, three gaps, three hairlines. Unmoved by
        // DROVE-331, because the bolt had no hairline of its own.
        const immovable = 2 * g.screenInset + 2 * g.bubbleInset
            + g.discs * g.disc + g.gaps * g.gap + g.dividers;
        expect(immovable).toBe(176);
        // What the longest name needs at the floor, at the 13pt size and the
        // 5pt padding. 85 when the name was 12pt on 6pt padding; the type
        // costs 6 more points of ink at the floor and the padding hands 2 of
        // them straight back.
        const nameFloor = composerModelSegmentWidth('Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(nameFloor).toBe(89);
        // The widest whole point THREE segments can be with both held: 36.
        // THE FORMULA IS UNCHANGED BY DROVE-331 AND ITS ANSWER IS: the count
        // moved under the same derivation, 4 -> 3, and 27 -> 36 is what it
        // returns. One more point per segment would cut the longest name at
        // 375, which is the DROVE-138 failure, so 36 is a ceiling and not a
        // taste.
        const ceiling = Math.floor((375 - immovable - nameFloor) / g.glyphSegments);
        expect(ceiling).toBe(36);
        expect(375 - immovable - g.glyphSegments * (ceiling + 1)).toBeLessThan(nameFloor);
        // AND THE SEGMENT IS UNDER IT, NOT AT IT. 27, where it was: the
        // ceiling stopped binding when the bolt left, and what it would allow
        // — nine more on each of three — is the bolt's own 27, handed to the
        // name instead. That identity is the ticket's criterion in one line.
        expect(g.segment).toBe(27);
        expect(g.segment).toBeLessThan(ceiling);
        expect(g.glyphSegments * (ceiling - g.segment)).toBe(g.segment);
        expect(composerModelBudget(375) - 91).toBe(g.segment);
        // DROVE-284's bottom-up rule is now the bound the number stands on:
        // never under the padlock's measured ink (0.6875 of the em off
        // Ionicons.ttf, 13.75 at 20pt) plus `controlGap` either side. 27
        // clears it by one point, which is the half of Clay's granted air the
        // name did not take back at DROVE-320.
        const ink = 20 * 0.6875;
        expect(g.segment).toBeGreaterThanOrEqual(
            Math.ceil(ink + 2 * MOBILE_COMPOSER_METRICS.controlGap),
        );
        expect(g.segment - Math.ceil(ink + 2 * MOBILE_COMPOSER_METRICS.controlGap)).toBe(1);
        // And the widest glyph the capsule draws, `eye` at 0.9355, keeps
        // 4.1pt a side — half a point off what DROVE-284's air gave it, still
        // wider than the 26 Clay called crowded, and well over the 2pt
        // DROVE-118 measured as where two marks read as one blob. Since
        // DROVE-320 this number does a second job: rounded up it IS the
        // model segment's `paddingHorizontal`, asserted above.
        const widest = (g.segment - 20 * 0.9355) / 2;
        expect(widest).toBeGreaterThan(4);
        expect(widest).toBeCloseTo(4.145, 3);
        expect(Math.ceil(widest)).toBe(COMPOSER_MODEL_SEGMENT.paddingHorizontal);
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
        expect(composerModelSegmentWidth('Opus 5') - glyphInstead).toBe(25);
        expect(composerModelSegmentWidth('Opus 4.8 1M') - glyphInstead).toBe(60);
        // What it would buy against what it would cost: the name draws whole at
        // and above the line as it is.
        expect(composerModelFits('Opus 5', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
        expect(composerModelFits('Opus 4.8 1M', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
    });
});
