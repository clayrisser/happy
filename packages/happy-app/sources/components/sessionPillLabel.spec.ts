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
    composerCapsuleOwnRow,
    composerRowFixedWidth,
    COMPOSER_BUBBLE_ROW_GEOMETRY,
    COMPOSER_ROW_MIN_MODEL_WIDTH,
    SESSION_PILL_SEPARATOR,
    shortModelName,
} from './sessionPillLabel';
import {
    getClaudeEffortLevels,
    getClaudeModelModes,
    getCodexEffortLevels,
    getCodexModelModes,
    getGeminiModelModes,
} from './modelModeOptions';

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
 * 393 the handset Clay is on. 390 joins them in DROVE-266, because the crossover
 * moved between the two and the gap between them is now where the composer
 * changes shape. 320 is below the supported floor and is measured anyway.
 */
describe('the model segment on the button row (DROVE-178)', () => {
    /**
     * WHAT A BIGGER BUTTON COSTS THE NAME (DROVE-266, after DROVE-264).
     *
     * DROVE-264 pulled send and the mic apart, which was one more object and
     * one more gap, 42pt at every width. DROVE-266 grows every object on the row
     * from 36 to 39 on Clay's "you can make the buttons in the speech bubble a
     * little bigger", and SIX objects take that size — four discs and the
     * capsule's two glyph segments — so a point costs the name six and three
     * points cost it 18.
     */
    it('has 95pt at 393, 92 at 390, 77 at 375 and 22 at 320, with six objects at 39', () => {
        expect(composerModelBudget(393)).toBe(95);
        expect(composerModelBudget(390)).toBe(92);
        expect(composerModelBudget(375)).toBe(77);
        expect(composerModelBudget(320)).toBe(22);
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
        for (const width of [320, 375, 390, 393]) {
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
    it('counts four discs, four gaps and two glyph segments, and no audio capsule', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        // The `+`, the audio button, the MIC and send. The mic is the one
        // DROVE-264 added.
        expect(g.discs).toBe(4);
        expect(g.disc).toBe(39);
        expect(g.gaps).toBe(4);
        // No audio capsule left: the pair collapsed into one button in
        // DROVE-236, and `audioButtons: 3` was stale from that moment.
        expect(g).not.toHaveProperty('audioButtons');
        expect(g).not.toHaveProperty('audioButton');
        // The glyph segments are the row's own size, not the 44 they wore
        // outside it.
        expect(g.segment).toBe(39);
        expect(g.glyphSegments).toBe(2);
        expect(g.dividers).toBe(2);
        expect(composerRowFixedWidth()).toBe(260);
    });

    /**
     * SIX OBJECTS TAKE THE SIZE, WHICH IS WHY A POINT COSTS SIX (DROVE-266).
     *
     * The number Clay asked to move is a single control's diameter, and this is
     * the multiplier that turns "a little bigger" into a layout decision. It is
     * asserted rather than described because the next person to grow these will
     * want 40 and needs to meet the 6x before they do.
     */
    it('spends six points of the name for every point of button', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        expect(g.discs + g.glyphSegments).toBe(6);
        // 36 -> 39 is 18pt off every width, which is the whole delta in the
        // budget table above.
        expect(composerModelBudget(393) + 18).toBe(113);
        expect(composerModelBudget(320) + 18).toBe(40);
    });

    it('keeps the bare-glyph controls at the disc’s width, which is why the cost is 45', () => {
        // The obvious saving, refused and written down. Send draws no circle at
        // all now and the mic draws none at rest, so their INK is about 18pt and
        // a narrower box would hand the name back some of this. Both still draw
        // a full disc on one of their faces — Stop and the gate's lock for send,
        // an open capture for the mic — so a narrower box would either put a
        // second size of circle on a row DROVE-214 gave one, or resize per face
        // and reflow the row every time the agent starts a turn.
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.disc)
            .toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.segment);
        // 45 exactly: one disc and one gap.
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        expect(g.disc + g.gap).toBe(45);
    });

    it('gives 8 back out of the segment’s own padding, which is DROVE-264’s give', () => {
        // The give, measured rather than described. Without the padding cut,
        // `Gemini 3.1 Pro` is under the floor at 393 as well as at 375, which is
        // a shipping name being CUT on the phone Clay reads.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(6);
        const withOldPadding = (name: string, width: number) =>
            (composerModelBudget(width) - 2 * 10) / (name.length * COMPOSER_MODEL_SEGMENT.glyphWidth);
        expect(withOldPadding('Gemini 3.1 Pro', 393)).toBeLessThan(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(composerModelScaleFor('Gemini 3.1 Pro', 393))
            .toBeGreaterThanOrEqual(COMPOSER_MODEL_SEGMENT.minimumFontScale);
    });

    it('draws every Claude name whole at 390 and 393, at full size', () => {
        // `Opus 4.8 1M` is the longest of the family and the one that has to
        // hold. It draws WHOLE on both widths that keep the single row.
        for (const name of ['Fable 5', 'Opus 5 1M', 'Opus 5', 'Sonnet 5', 'Haiku 4.5', 'Opus 4.8 1M']) {
            expect(composerModelFits(name, 393), `${name} at 393`).toBe(true);
            expect(composerModelFits(name, 390), `${name} at 390`).toBe(true);
        }
        expect(composerModelSegmentWidth('Opus 5 1M')).toBe(75);
        expect(composerModelSegmentWidth('Opus 4.8 1M')).toBe(89);
    });

    it('scales rather than truncating, and the scale is still headroom above the line', () => {
        // Smaller before shorter is the rule the segment draws by, so the
        // honest number is how long a name each size buys.
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        // 0.80 since DROVE-236. DROVE-264 refused to lower it and DROVE-266
        // refuses again: below the line the capsule takes its own row, which is
        // a give with no bottom, so spending type everywhere buys nothing.
        expect(scale).toBe(0.8);
        // The two 14-glyph names, on the two widths that keep the single row.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 393)).toBeCloseTo(0.847, 3);
        expect(composerModelScaleFor('Gemini 3.1 Pro', 390)).toBeCloseTo(0.816, 3);
        expect(composerModelScaleFor('GPT-5.6 Luna', 393)).toBeCloseTo(0.988, 3);
        for (const [name, width] of [['GPT-5.6 Luna', 393], ['GPT-5.6 Sol', 393],
            ['Gemini 3.1 Pro', 393], ['Gemini 3 Flash', 390]] as const) {
            expect(
                composerModelScaleFor(name, width),
                `${name} at ${width}`,
            ).toBeGreaterThanOrEqual(scale);
        }

        // WHAT THE TICKET ACTUALLY SPENDS, in reach rather than in any name the
        // app has: at 393 the segment drew 14 glyphs at full size and 18 at the
        // floor before the buttons grew, and draws 11 and 14 after.
        const longest = (width: number, fontScale: number) => {
            let glyphs = 0;
            while (composerModelSegmentWidth('x'.repeat(glyphs + 1), fontScale)
                <= composerModelBudget(width)) glyphs += 1;
            return glyphs;
        };
        expect([longest(393, 1), longest(393, scale)]).toEqual([11, 14]);
        expect([longest(390, 1), longest(390, scale)]).toEqual([11, 14]);
    });

    it('is what the row could NOT hold before DROVE-153, which is why DROVE-138 moved it', () => {
        // Six 63pt buttons left 63 for the name, and `Opus 5 1M` needs 75.
        expect(composerModelSegmentWidth('Opus 5 1M')).toBeGreaterThan(63);
        expect(composerModelBudget(393)).toBeGreaterThan(63);
    });

    /**
     * 375 AND 320, AND THIS TIME THERE IS SOMEWHERE FOR THEM TO GO (DROVE-266).
     *
     * DROVE-264 asserted the failure rather than hiding it: six objects on one
     * row leave no name in either picker legible at 320, and it named the remedy
     * — the capsule taking a row of its own — without building it. Growing the
     * buttons put 375 in the same position, and 375 is a phone people hold, so
     * the remedy is built.
     *
     * So this suite still asserts that the SINGLE row cannot hold those widths,
     * because that is the fact that decides the layout, and then asserts that
     * the layout answers it.
     */
    it('holds every name above the line, cuts the long ones at 375 and every one at 320', () => {
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        const every = ['Opus 4.8 1M', 'Sonnet 4.5', 'Haiku 4.5', 'Opus 5 1M',
            'Sonnet 5', 'Fable 5', 'Opus 5', 'GPT-5.6 Luna', 'Gemini 3.1 Pro'];
        for (const name of every) {
            for (const width of [390, 393]) {
                expect(
                    composerModelSegmentWidth(name, scale),
                    `${name} at ${width}`,
                ).toBeLessThanOrEqual(composerModelBudget(width));
            }
            // And none of them at 320, which is DROVE-264's finding unchanged
            // and now three times worse.
            expect(
                composerModelSegmentWidth(name, scale),
                `${name} at 320`,
            ).toBeGreaterThan(composerModelBudget(320));
        }
        // 375 is the interesting width and it is where the STACKING RULE has to
        // be about the layout rather than about the name. The two 12-and-longer
        // names are cut there and the Claude family is not, so a per-name rule
        // would change the composer's shape when Clay switched model. It does
        // not: `composerCapsuleOwnRow` reads the width, so 375 stacks for
        // `Opus 5` as well, and the row keeps one shape per phone.
        for (const cut of ['GPT-5.6 Luna', 'Gemini 3.1 Pro']) {
            expect(composerModelSegmentWidth(cut, scale), `${cut} at 375`)
                .toBeGreaterThan(composerModelBudget(375));
        }
        expect(composerModelSegmentWidth('Opus 4.8 1M', scale))
            .toBeLessThanOrEqual(composerModelBudget(375));
        expect(composerCapsuleOwnRow(375)).toBe(true);
        expect(composerModelScaleFor('Opus 5', 320)).toBeCloseTo(0.238, 3);
    });

    it('puts the floor where the arithmetic puts it, not where a device list does', () => {
        // `COMPOSER_ROW_MIN_MODEL_WIDTH` is a claim and this is the claim being
        // checked: the crossover is the narrowest width at which the longest
        // name the app draws still clears the type floor. 389 at 39pt buttons,
        // where it was 371 at 36, and the constant IS the crossover now rather
        // than the next real handset above it, because falling below it is a
        // layout change rather than a cut name.
        const worst = 'Gemini 3.1 Pro';
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        let crossover = 320;
        while (composerModelSegmentWidth(worst, scale) > composerModelBudget(crossover)) {
            crossover += 1;
        }
        expect(crossover).toBe(389);
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(crossover);
    });

    /**
     * THE CAPSULE'S OWN ROW, which is what makes every width work (DROVE-266).
     */
    it('stacks below the line and shares the row above it', () => {
        expect(composerCapsuleOwnRow(320)).toBe(true);
        expect(composerCapsuleOwnRow(375)).toBe(true);
        expect(composerCapsuleOwnRow(388)).toBe(true);
        expect(composerCapsuleOwnRow(389)).toBe(false);
        expect(composerCapsuleOwnRow(390)).toBe(false);
        expect(composerCapsuleOwnRow(393)).toBe(false);
    });

    it('is decided by the SAME arithmetic the budget is, not by a second number', () => {
        // The failure this guards is the one that has bitten this composer
        // three times: a model of the layout that agrees with itself while the
        // renderer does something else. The stacking predicate and the budget
        // read one constant, so a width where the name will not fit is exactly
        // a width where the capsule stacks, by construction rather than by
        // maintenance.
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        const worst = 'Gemini 3.1 Pro';
        for (let width = 320; width <= 440; width += 1) {
            const fitsOnOneRow = composerModelSegmentWidth(worst, scale) <= composerModelBudget(width);
            expect(composerCapsuleOwnRow(width), `at ${width}`).toBe(!fitsOnOneRow);
        }
    });

    it('gives the name the bubble’s whole interior once it has its own row', () => {
        // What the trade buys, in the only unit that matters here: glyphs. On
        // the shared row at 320 the name has 22pt, which is nothing; on its own
        // row it has the interior less the two glyph segments and their two
        // hairlines.
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        const ownRowBudget = (width: number) => width
            - 2 * g.screenInset
            - 2 * g.bubbleInset
            - (g.glyphSegments * g.segment + g.dividers);
        expect(ownRowBudget(320)).toBe(202);
        expect(ownRowBudget(375)).toBe(257);
        // Every name in either picker, whole, at full size, on the narrowest
        // width the app runs on.
        for (const name of ['Opus 4.8 1M', 'Gemini 3.1 Pro', 'GPT-5.6 Luna', 'Opus 5 1M']) {
            expect(composerModelSegmentWidth(name), `${name} at 320`)
                .toBeLessThanOrEqual(ownRowBudget(320));
        }
    });

    /**
     * THE CANDIDATE THAT WAS REFUSED, on the record so it is not quietly taken
     * next time (DROVE-236).
     *
     * Dropping the NAME for a glyph makes every width comfortable at a stroke.
     * It is refused because the name is the only thing on this row carrying a
     * value rather than a state: a padlock reads as a mode and a dial reads as a
     * level, and no glyph reads as "Opus 5". DROVE-138 was filed about exactly
     * this name being cut, and DROVE-178 brought it back up here after Clay
     * circled it on the status row and drew an arrow at the gap.
     */
    it('would gain room by dropping the name, and does not', () => {
        // A glyph segment where the name is would be the row's own size.
        const glyphInstead = COMPOSER_BUBBLE_ROW_GEOMETRY.segment;
        expect(composerModelSegmentWidth('Opus 5') - glyphInstead).toBe(15);
        expect(composerModelSegmentWidth('Opus 4.8 1M') - glyphInstead).toBe(50);
        // What it would buy against what it would cost: the name draws whole
        // above the line as it is, and below it the capsule has a row rather
        // than a glyph.
        expect(composerModelFits('Opus 5', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
        expect(composerModelFits('Opus 4.8 1M', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
    });
});
