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
    composerModelPresentation,
    composerModelScaleFor,
    composerModelSegmentWidth,
    composerRowFixedWidth,
    COMPOSER_BUBBLE_ROW_GEOMETRY,
    COMPOSER_ROW_MIN_MODEL_WIDTH,
    SESSION_PILL_SEPARATOR,
    shortModelName,
} from './sessionPillLabel';
import {
    MOBILE_COMPOSER_DISC_INNER_PADDING,
    MOBILE_COMPOSER_METRICS,
} from './agentInputLayout';

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
        // AND 18 NARROWER AT EVERY WIDTH SINCE DROVE-353, which is the three
        // glyph segments taking the `+` disc's own air, six points each.
        expect(composerModelBudget(393)).toBe(118);
        expect(composerModelBudget(390)).toBe(115);
        expect(composerModelBudget(375)).toBe(100);
        // 320 holds the SHORT names now — it was -17 with DROVE-281's row and
        // 36 after DROVE-320, under `Opus 5`'s 44 at the floor. 63 clears the
        // five short Claude names and still cuts the long ones, which is the
        // honest failure halved rather than smoothed over, and it is asserted
        // below name by name.
        // 320 holds NO name now, short or long: 45 is under `Opus 5`'s 50 at
        // the floor. It has not been a supported width for several tickets and
        // the argument for not rearranging the row to rescue it is unchanged.
        expect(composerModelBudget(320)).toBe(45);
        // The Pro Max pair, which had the only single row before DROVE-284.
        expect(composerModelBudget(430)).toBe(155);
        expect(composerModelBudget(440)).toBe(165);
        // Every one of them is DROVE-331's number less the three segments'
        // six points each.
        for (const [width, then] of [[320, 63], [375, 118], [390, 133], [393, 136], [430, 173], [440, 183]] as const) {
            expect(then - composerModelBudget(width), `${width}`)
                .toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.glyphSegments * (33 - 27));
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
        // 237 SINCE DROVE-353, the three segments' six points each.
        expect(composerRowFixedWidth()).toBe(237);
        expect(composerRowFixedWidth() - 219).toBe(g.glyphSegments * (33 - 27));
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
        // 33 SINCE DROVE-353, and it is still under a disc — which is the
        // claim this test is named for. What changed is where it comes from:
        // the `+` disc's own inner air rather than the least the row could
        // spare, so a segment is now a glyph plus a disc's clearance, and a
        // disc is bigger only because a circle needs its own diameter.
        expect(g.segment).toBe(33);
        expect(g.segment).toBeLessThan(g.disc);
        // What a segment still saves against a disc, across the four the
        // capsule had at DROVE-284 and the three it has now.
        expect(4 * (g.disc - g.segment)).toBe(24);
        expect(g.glyphSegments * (g.disc - g.segment)).toBe(18);
        expect((g.disc + g.gap) - (g.segment + 1)).toBe(11);
        // 299 -> 237: still more than DROVE-281 spent, with DROVE-353 handing
        // a quarter of it back to the icons' air.
        expect(299 - composerRowFixedWidth()).toBe(62);
        expect(62 - 29).toBe(g.segment);
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
        // 8 SINCE DROVE-353, and by the same derivation rather than a new one:
        // the segments went to the `+` disc's air, so `eye`'s clearance inside
        // one went 4.145 -> 7.145 and this follows it up. It is asserted
        // against that formula further down rather than declared here.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(8);
        const withOldPadding = (name: string, width: number) =>
            (composerModelBudget(width) - 2 * 10) / (name.length * COMPOSER_MODEL_SEGMENT.glyphWidth);
        expect(withOldPadding('Gemini 3.1 Pro', COMPOSER_ROW_MIN_MODEL_WIDTH))
            .toBeLessThan(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(composerModelScaleFor('Gemini 3.1 Pro', COMPOSER_ROW_MIN_MODEL_WIDTH))
            .toBeGreaterThanOrEqual(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        // AND THE CUT STILL DECIDES AT 375, one step down the order from where
        // DROVE-331 left it: the derived 8 draws the longest name at 0.857
        // where the old 10 would draw it at 0.816. Both are over the floor;
        // the derived one is the better of the two, which is the check.
        expect(withOldPadding('Gemini 3.1 Pro', 375))
            .toBeLessThan(composerModelScaleFor('Gemini 3.1 Pro', 375));
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeCloseTo(0.857, 3);
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
        expect(eyeClearance).toBeCloseTo(7.145, 3);
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(Math.ceil(eyeClearance));
        // And it is NOT merely the smallest thing that fits: rounding up is
        // what makes it 8 rather than 7.145, and 7 would leave the name more
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
        expect(composerModelSegmentWidth('Gemini 3.1 Pro')).toBe(114);
        expect(composerModelSegmentWidth('Gemini 3.1 Pro', COMPOSER_MODEL_SEGMENT.minimumFontScale)).toBe(95);
        // And the smallest type anything actually draws WAS 0.827 of 13pt at
        // 375, about 10.7pt — where the 12pt name drew 9.89pt at 0.824. Both
        // the type AND the scale improved, which is the check that the point
        // was PAID for rather than borrowed from the narrowest phone. Since
        // DROVE-331 it is 13pt whole at 375; the inequalities are kept because
        // they are the check, and the equality is the new fact.
        // 0.857 at 375 SINCE DROVE-353 — the icons' padding costs the longest
        // name its full size on the narrowest supported phone, which is the
        // trade Clay ranked. Still 11.14pt drawn, over both earlier marks.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeCloseTo(0.857, 3);
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
        expect(composerModelSegmentWidth('Opus 5 1M')).toBe(79);
        expect(composerModelSegmentWidth('Opus 4.8 1M')).toBe(93);
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
        // 390 AND UP SINCE DROVE-353; 375 is the one width that steps down,
        // and only for the two 14-glyph names.
        for (const width of [390, 393, 430, 440]) {
            for (const name of ['GPT-5.6 Luna', 'GPT-5.6 Sol', 'Gemini 3.1 Pro', 'Gemini 3 Flash']) {
                expect(composerModelScaleFor(name, width), `${name} at ${width}`).toBe(1);
            }
        }
        // At 375 the 12-glyph-and-under names still draw whole; the two
        // 14-glyph ones are the pair that steps down.
        for (const name of ['GPT-5.6 Luna', 'GPT-5.6 Sol']) {
            expect(composerModelScaleFor(name, 375), `${name} at 375`).toBe(1);
        }
        for (const name of ['Gemini 3.1 Pro', 'Gemini 3 Flash']) {
            expect(composerModelScaleFor(name, 375), `${name} at 375`).toBeCloseTo(0.857, 3);
        }
        // And the type on the glass at 375 is 11.14, against the 10.74
        // DROVE-320 bought and the 9.89 before it. Still up on both.
        expect(13 * composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeCloseTo(11.14, 2);

        // WHAT THE ROW STILL BUYS, in reach rather than in any name the app
        // has, and DROVE-353 hands three glyphs of it back at every width:
        // 375 goes [15, 19] -> [12, 15], 393 [18, 22] -> [14, 18] and 430
        // [23, 29] -> [19, 24]. 24 points of budget is 3.4 glyphs at 7pt each,
        // which is where the three come from. Every name in either picker is
        // 14 or under, so the reach that matters is still there: 375 draws
        // twelve glyphs whole and fifteen at the floor.
        const longest = (width: number, fontScale: number) => {
            let glyphs = 0;
            while (composerModelSegmentWidth('x'.repeat(glyphs + 1), fontScale)
                <= composerModelBudget(width)) glyphs += 1;
            return glyphs;
        };
        expect([longest(375, 1), longest(375, scale)]).toEqual([12, 15]);
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
        // AND SINCE DROVE-353 IT RUNS PAST THE END OF IT: 45 is under `Opus
        // 5`'s 50 at the floor, so every name is cut at 320. The icons keep
        // the `+` disc's air at every width and 320 is where that is paid for
        // in full — a width the app has not supported for several tickets.
        expect(every.filter(holdsAt320)).toEqual([]);
        expect(every.filter((name) => !holdsAt320(name))).toEqual(every);
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
    it('does not buy 320 back by shrinking the segments, which is the one lever refused (DROVE-353)', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        const withSegment = (width: number, segment: number) => width
            - 2 * g.screenInset - 2 * g.bubbleInset
            - (g.discs * g.disc + g.gaps * g.gap + g.glyphSegments * segment + g.dividers);
        // The shortest name in any picker, at the type floor and the 13pt size.
        const shortest = composerModelSegmentWidth('Opus 5', scale);
        expect(shortest).toBe(50);
        // 45 against 50: it does NOT hold at 320 any more. DROVE-331 had it at
        // 63 against 44; the icons' air costs 18 of that and the name's own
        // air 6, and 320 is where the whole 24 lands at once.
        expect(withSegment(320, g.segment)).toBe(45);
        expect(withSegment(320, g.segment)).toBeLessThan(shortest);
        // THE LEVER THAT WOULD BUY IT BACK IS THE ONE THIS TICKET REFUSES.
        // 31pt segments hold the shortest name at 320 — two points off each,
        // still over DROVE-284's ink floor — and it is refused because Clay
        // ranked the icons above the name by name: "the icons keep their
        // padding and the label gives".
        let segment = g.segment;
        while (segment > 0 && withSegment(320, segment) < shortest) segment -= 1;
        expect(segment).toBe(31);
        expect(segment).toBeLessThan(g.segment);
        expect(g.segment - segment).toBe(2);
        // At zero the interior is the same 144 it was, because the bolt took
        // its width with it and the terms that are not segments did not move.
        expect(withSegment(320, 0)).toBe(144);
        // The longest name is still out of reach whatever the segments do: 16
        // buys it, under the 20pt glyph itself, so there is no segment width
        // that draws it at 320 at all.
        let forLongest = g.segment;
        const longest = composerModelSegmentWidth('Gemini 3.1 Pro', scale);
        while (forLongest > 0 && withSegment(320, forLongest) < longest) forLongest -= 1;
        expect(forLongest).toBe(16);
        expect(forLongest).toBeLessThan(20);
        // And 33 is comfortably over DROVE-284's ink floor, which stopped
        // being the binding rule when the `+` disc's air became one.
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
        expect(crossover).toBe(370);
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(crossover);
        // 346 until DROVE-353, and the whole of the move is the air the icons
        // and the name each took: 18 on the three segments, 6 on the name's
        // two sides.
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH - 346).toBe(
            COMPOSER_BUBBLE_ROW_GEOMETRY.glyphSegments * (33 - 27)
            + 2 * (COMPOSER_MODEL_SEGMENT.paddingHorizontal - 5),
        );
        // BELOW EVERY PHONE THE APP SUPPORTS, which is the whole point of
        // spending the segments: 375 is the narrowest handset
        // statusRowLayout.spec.ts still supports and it clears this by 29 —
        // the two points that were NOT spent on the segments at DROVE-320,
        // plus the bolt's 27.
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBeLessThan(375);
        expect(375 - COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(5);
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
        expect(nameFloor).toBe(95);
        // The widest whole point THREE segments can be with both held: 36.
        // THE FORMULA IS UNCHANGED BY DROVE-331 AND ITS ANSWER IS: the count
        // moved under the same derivation, 4 -> 3, and 27 -> 36 is what it
        // returns. One more point per segment would cut the longest name at
        // 375, which is the DROVE-138 failure, so 36 is a ceiling and not a
        // taste.
        const ceiling = Math.floor((375 - immovable - nameFloor) / g.glyphSegments);
        expect(ceiling).toBe(34);
        expect(375 - immovable - g.glyphSegments * (ceiling + 1)).toBeLessThan(nameFloor);
        // AND THE SEGMENT IS UNDER IT, NOT AT IT. 27, where it was: the
        // ceiling stopped binding when the bolt left, and what it would allow
        // — nine more on each of three — is the bolt's own 27, handed to the
        // name instead. That identity is the ticket's criterion in one line.
        // AND THE SEGMENT IS STILL UNDER IT, by one point rather than nine
        // (DROVE-353). The ceiling barely binds now, which is the difference
        // between a width the row can spare and a width the `+` disc sets: 33
        // is what the disc's air asks for and 34 is the most 375 would allow,
        // so the two rules very nearly meet.
        expect(g.segment).toBe(33);
        expect(g.segment).toBeLessThan(ceiling);
        expect(ceiling - g.segment).toBe(1);
        // DROVE-284's bottom-up rule is now the bound the number stands on:
        // never under the padlock's measured ink (0.6875 of the em off
        // Ionicons.ttf, 13.75 at 20pt) plus `controlGap` either side. 27
        // clears it by one point, which is the half of Clay's granted air the
        // name did not take back at DROVE-320.
        const ink = 20 * 0.6875;
        expect(g.segment).toBeGreaterThanOrEqual(
            Math.ceil(ink + 2 * MOBILE_COMPOSER_METRICS.controlGap),
        );
        expect(g.segment - Math.ceil(ink + 2 * MOBILE_COMPOSER_METRICS.controlGap)).toBe(7);
        // And the widest glyph the capsule draws, `eye` at 0.9355, keeps
        // 4.1pt a side — half a point off what DROVE-284's air gave it, still
        // wider than the 26 Clay called crowded, and well over the 2pt
        // DROVE-118 measured as where two marks read as one blob. Since
        // DROVE-320 this number does a second job: rounded up it IS the
        // model segment's `paddingHorizontal`, asserted above.
        const widest = (g.segment - 20 * 0.9355) / 2;
        expect(widest).toBeGreaterThan(MOBILE_COMPOSER_DISC_INNER_PADDING);
        expect(widest).toBeCloseTo(7.145, 3);
        expect(Math.ceil(widest)).toBe(COMPOSER_MODEL_SEGMENT.paddingHorizontal);
    });

    /**
     * THE NAME'S THREE FACES, PINNED (DROVE-331).
     *
     * Clay: "you can even make the model text a bit smaller and truncate if it
     * ends up running under." So the give-way order has a last step: after the
     * spacer, the padding and the type size, the ellipsis. DROVE-138 was filed
     * about `Opus 5...` and the fix is still "smaller before shorter" — the
     * cut is the LAST thing, never the first, and on every supported width it
     * never happens at all.
     */
    it('draws the name whole where it fits, smaller where it must, and cuts it last (DROVE-331)', () => {
        const floor = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        // WHOLE on every supported width, for the longest name either picker
        // offers: 13pt, the segment as wide as the name, nothing cut. It
        // stays whole down to 365, ten under the narrowest phone.
        for (const width of [389, 390, 393, 430, 440]) {
            expect(composerModelPresentation('Gemini 3.1 Pro', width), `${width}`)
                .toEqual({ outcome: 'whole', scale: 1, width: composerModelBudget(width), cut: 0 });
        }
        // THE SEGMENT IS THE BUDGET EVEN WHEN THE NAME IS WHOLE (DROVE-353).
        // It used to be the name's own 108 at every one of those widths, and
        // the difference is the band Clay photographed. 375 is off this list
        // because it scales now — the stated trade, not a surprise.
        expect(composerModelPresentation('Gemini 3.1 Pro', 375).outcome).toBe('scaled');
        // And 320 cuts even the shortest name, where DROVE-331 drew it whole.
        expect(composerModelPresentation('Opus 5', 320).outcome).toBe('truncated');
        // SCALED from 364 down to the crossover: the segment is the whole
        // budget and the type steps down, to 0.806 at 346 — just over the
        // floor, which is what makes 346 the crossover.
        expect(composerModelPresentation('Gemini 3.1 Pro', 388).outcome).toBe('scaled');
        const atCrossover = composerModelPresentation('Gemini 3.1 Pro', COMPOSER_ROW_MIN_MODEL_WIDTH);
        expect(atCrossover.outcome).toBe('scaled');
        expect(atCrossover.width).toBe(composerModelBudget(COMPOSER_ROW_MIN_MODEL_WIDTH));
        expect(atCrossover.scale).toBeCloseTo(0.806, 3);
        expect(atCrossover.scale).toBeGreaterThanOrEqual(floor);
        expect(atCrossover.cut).toBe(0);
        expect(composerModelPresentation('Opus 5 1M', 375)).toMatchObject({ outcome: 'whole', width: 100, cut: 0 });
        // TRUNCATED one point under the crossover, and at 320 for every long
        // name: the type is at the floor, the segment is still exactly the
        // budget — so send stays on the rim and the padlock, the speaker and
        // the dial keep their 27 — and the ellipsis stands in for what is
        // left. 26 points of `Gemini 3.1 Pro` at 320: the same 26 the
        // unshrunk name overruns the rim by in composerBubbleLayout.spec.ts.
        expect(composerModelPresentation('Gemini 3.1 Pro', COMPOSER_ROW_MIN_MODEL_WIDTH - 1).outcome).toBe('truncated');
        const cut = composerModelPresentation('Gemini 3.1 Pro', 320);
        expect(cut).toEqual({ outcome: 'truncated', scale: floor, width: 45, cut: 50 });
        expect(cut.width).toBe(composerModelBudget(320));
        expect(cut.cut).toBe(composerModelSegmentWidth('Gemini 3.1 Pro', floor) - composerModelBudget(320));
        for (const name of ['Opus 4.8 1M', 'Sonnet 4.5', 'GPT-5.6 Luna', 'Gemini 3.1 Pro']) {
            const p = composerModelPresentation(name, 320);
            expect(p.outcome, name).toBe('truncated');
            expect(p.scale, name).toBe(floor);
            expect(p.width, name).toBe(45);
            expect(p.cut, name).toBeGreaterThan(0);
        }
        // THE ORDER: whole -> scaled -> truncated as the phone narrows, and
        // never back. Walked width by width for the longest name.
        const outcomes: string[] = [];
        for (let width = 440; width >= 300; width -= 1) {
            const o = composerModelPresentation('Gemini 3.1 Pro', width).outcome;
            if (outcomes[outcomes.length - 1] !== o) outcomes.push(o);
        }
        expect(outcomes).toEqual(['whole', 'scaled', 'truncated']);
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
