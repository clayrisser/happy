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
 * The budget, at the three widths DROVE-236 names.
 *
 * `statusRowLayout.spec.ts` calls 375 the narrowest phone still supported and
 * 393 the handset Clay is on. 320 is below that floor and is measured anyway,
 * because it is where the row full of five controls actually has to decide
 * something.
 */
describe('the model segment on the button row (DROVE-178)', () => {
    /**
     * WHAT THE SECOND VOICE CONTROL COSTS THE NAME (DROVE-264).
     *
     * DROVE-236 collapsed send and the mic into one slot and DROVE-264 pulls
     * them apart, because a single morphing button cannot draw "type a bit,
     * dictate the rest, then send". One more 36pt object and one more 6pt gap,
     * 42pt at every width, against which the segment's own padding gives back 8.
     */
    it('has 113pt at 393, 95 at 375 and 40 at 320, with six objects on the row', () => {
        expect(composerModelBudget(393)).toBe(113);
        expect(composerModelBudget(375)).toBe(95);
        expect(composerModelBudget(320)).toBe(40);
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
        for (const width of [320, 375, 393]) {
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
        // DROVE-264 adds, and it is the whole cost of this ticket.
        expect(g.discs).toBe(4);
        expect(g.disc).toBe(36);
        expect(g.gaps).toBe(4);
        // No audio capsule left: the pair collapsed into one button in
        // DROVE-236, and `audioButtons: 3` was stale from that moment.
        expect(g).not.toHaveProperty('audioButtons');
        expect(g).not.toHaveProperty('audioButton');
        // The glyph segments are the row's own size, not the 44 they wore
        // outside it.
        expect(g.segment).toBe(36);
        expect(g.glyphSegments).toBe(2);
        expect(g.dividers).toBe(2);
        expect(composerRowFixedWidth()).toBe(242);
    });

    it('keeps the bare-glyph controls at the disc’s width, which is why the cost is 42', () => {
        // The obvious saving, refused and written down. Send draws no circle at
        // all now and the mic draws none at rest, so their INK is about 18pt and
        // a narrower box would hand the name back some of this. Both still draw
        // a full 36pt disc on one of their faces — Stop and the gate's lock for
        // send, an open capture for the mic — so a narrower box would either put
        // a second size of circle on a row DROVE-214 gave one, or resize per
        // face and reflow the row every time the agent starts a turn.
        expect(COMPOSER_BUBBLE_ROW_GEOMETRY.disc)
            .toBe(COMPOSER_BUBBLE_ROW_GEOMETRY.segment);
        // 42 exactly: one disc and one gap.
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        expect(g.disc + g.gap).toBe(42);
    });

    it('costs the name 42pt of row and gives 8 back out of its own padding', () => {
        // The give, measured rather than described. Without the padding cut,
        // `Gemini 3.1 Pro` lands under the floor at 375, which is a shipping
        // name being CUT and is the DROVE-138 failure.
        expect(COMPOSER_MODEL_SEGMENT.paddingHorizontal).toBe(6);
        const withOldPadding = (name: string, width: number) =>
            (composerModelBudget(width) - 2 * 10) / (name.length * COMPOSER_MODEL_SEGMENT.glyphWidth);
        expect(withOldPadding('Gemini 3.1 Pro', 375)).toBeLessThan(COMPOSER_MODEL_SEGMENT.minimumFontScale);
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375))
            .toBeGreaterThanOrEqual(COMPOSER_MODEL_SEGMENT.minimumFontScale);
    });

    it('draws every Claude name whole at 375 and 393, at full size', () => {
        // `Opus 4.8 1M` is the longest of the family and the one that has to
        // hold. It needed the scale at 320 before this ticket and draws WHOLE at
        // 375 after it, because the padding cut is worth more to it than the
        // extra control costs.
        for (const name of ['Fable 5', 'Opus 5 1M', 'Opus 5', 'Sonnet 5', 'Haiku 4.5', 'Opus 4.8 1M']) {
            expect(composerModelFits(name, 393), `${name} at 393`).toBe(true);
            expect(composerModelFits(name, 375), `${name} at 375`).toBe(true);
        }
        expect(composerModelSegmentWidth('Opus 5 1M')).toBe(75);
        expect(composerModelSegmentWidth('Opus 4.8 1M')).toBe(89);
    });

    it('scales rather than truncating, and the scale is still headroom at 375 and up', () => {
        // Smaller before shorter is the rule the segment draws by, so the
        // honest number is how long a name each size buys.
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        // 0.80 since DROVE-236, and DROVE-264 deliberately did not move it: no
        // floor above zero rescues 320 once a sixth object is on the row, so
        // lowering it would buy nothing and cost type everywhere.
        expect(scale).toBe(0.8);
        // The two non-Claude names that need the scale at 375 and get it.
        expect(composerModelScaleFor('Gemini 3.1 Pro', 375)).toBeCloseTo(0.847, 3);
        expect(composerModelScaleFor('GPT-5.6 Luna', 375)).toBeCloseTo(0.988, 3);
        for (const [name, width] of [['GPT-5.6 Luna', 375], ['GPT-5.6 Sol', 375],
            ['Gemini 3.1 Pro', 393], ['Gemini 3 Flash', 393]] as const) {
            expect(
                composerModelScaleFor(name, width),
                `${name} at ${width}`,
            ).toBeGreaterThanOrEqual(scale);
        }

        // WHAT THE TICKET ACTUALLY SPENDS, in reach rather than in any name the
        // app has: at 375 the segment drew 16 glyphs at full size and 20 at the
        // floor, and now draws 11 and 14; at 393, 19 and 24 become 14 and 18.
        // Every name either picker offers is inside that.
        const longest = (width: number, fontScale: number) => {
            let glyphs = 0;
            while (composerModelSegmentWidth('x'.repeat(glyphs + 1), fontScale)
                <= composerModelBudget(width)) glyphs += 1;
            return glyphs;
        };
        expect([longest(375, 1), longest(375, scale)]).toEqual([11, 14]);
        expect([longest(393, 1), longest(393, scale)]).toEqual([14, 18]);
    });

    it('is what the row could NOT hold before DROVE-153, which is why DROVE-138 moved it', () => {
        // Six 63pt buttons left 63 for the name, and `Opus 5 1M` needs 75.
        expect(composerModelSegmentWidth('Opus 5 1M')).toBeGreaterThan(63);
        expect(composerModelBudget(393)).toBeGreaterThan(63);
    });

    /**
     * 320, AND THIS TIME IT IS A REFUSAL RATHER THAN A SQUEEZE (DROVE-264).
     *
     * DROVE-236 asked what gives when the row will not hold five things, and
     * the answer was that 320 shrinks its type and nothing is cut. Six things
     * is past that: 40pt of budget is 12 of padding and 28 of room, and 28pt
     * holds four glyphs at the floor. No name in either picker clears it,
     * `Opus 5` at 0.667 included.
     *
     * So this suite asserts the failure rather than hiding it. The remedy when
     * a 320pt handset actually matters is the capsule getting a row of its own
     * again below that width — vertical space, which a phone has, instead of the
     * name, which it does not — and that is a layout change with a screenshot to
     * check, not a number to retune here.
     */
    it('holds every name at 375 and above, and NO name at 320', () => {
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        const every = ['Opus 4.8 1M', 'Sonnet 4.5', 'Haiku 4.5', 'Opus 5 1M',
            'Sonnet 5', 'Fable 5', 'Opus 5', 'GPT-5.6 Luna', 'Gemini 3.1 Pro'];
        for (const name of every) {
            for (const width of [COMPOSER_ROW_MIN_MODEL_WIDTH, 393]) {
                expect(
                    composerModelSegmentWidth(name, scale),
                    `${name} at ${width}`,
                ).toBeLessThanOrEqual(composerModelBudget(width));
            }
            // And none of them at 320, which is the honest half.
            expect(
                composerModelSegmentWidth(name, scale),
                `${name} at 320`,
            ).toBeGreaterThan(composerModelBudget(320));
        }
        expect(composerModelScaleFor('Opus 5', 320)).toBeCloseTo(0.667, 3);
    });

    it('puts the floor where the arithmetic puts it, not where a device list does', () => {
        // `COMPOSER_ROW_MIN_MODEL_WIDTH` is a claim and this is the claim being
        // checked: the crossover is the narrowest width at which the longest
        // name the app draws still clears the type floor. 371, so 375 is the
        // narrowest real phone above it and the constant is not a guess.
        const worst = 'Gemini 3.1 Pro';
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        let crossover = 320;
        while (composerModelSegmentWidth(worst, scale) > composerModelBudget(crossover)) {
            crossover += 1;
        }
        expect(crossover).toBe(371);
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBeGreaterThanOrEqual(crossover);
        expect(COMPOSER_ROW_MIN_MODEL_WIDTH).toBe(375);
    });

    /**
     * THE CANDIDATE THAT WAS REFUSED, on the record so it is not quietly taken
     * next time (DROVE-236).
     *
     * Dropping the NAME for a glyph makes 320 comfortable at a stroke. It is
     * refused because the name is the only thing on this row carrying a value
     * rather than a state: a padlock reads as a mode and a dial reads as a
     * level, and no glyph reads as "Opus 5". DROVE-138 was filed about exactly
     * this name being cut, and DROVE-178 brought it back up here after Clay
     * circled it on the status row and drew an arrow at the gap.
     */
    it('would gain room by dropping the name, and does not', () => {
        // A glyph segment where the name is would be the row's own 36.
        const glyphInstead = COMPOSER_BUBBLE_ROW_GEOMETRY.segment;
        expect(composerModelSegmentWidth('Opus 5') - glyphInstead).toBe(18);
        expect(composerModelSegmentWidth('Opus 4.8 1M') - glyphInstead).toBe(53);
        // What it would buy against what it would cost: the name draws whole at
        // 375 and 393 as it is, which is every phone this row holds on.
        expect(composerModelFits('Opus 5', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
        expect(composerModelFits('Opus 4.8 1M', COMPOSER_ROW_MIN_MODEL_WIDTH)).toBe(true);
    });
});
