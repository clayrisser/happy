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
     * WHAT THE MOVE INTO THE BUBBLE COSTS THE NAME (DROVE-236).
     *
     * The row is not a row any more, it is the bubble's own button row, so the
     * name shares its width with the `+` and send and pays the bubble's
     * padding as well as the composer's gutter. 33pt at every phone.
     */
    it('has 155pt at 393, 137 at 375 and 82 at 320, inside the bubble', () => {
        expect(composerModelBudget(393)).toBe(155);
        expect(composerModelBudget(375)).toBe(137);
        expect(composerModelBudget(320)).toBe(82);
    });

    /**
     * The budget is only worth a number if the terms it subtracts are the row
     * that is drawn, and for three tickets they were not: the `+` was counted
     * after DROVE-196 put it beside the field, the card's padding was counted
     * on top of the screen inset after DROVE-196 moved that padding onto the
     * row, and `audioButtons: 3` went stale the moment this same ticket
     * collapsed the audio pair, which left the budget 45pt pessimistic.
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
    it('counts three discs, three gaps and two glyph segments, and no audio capsule', () => {
        const g = COMPOSER_BUBBLE_ROW_GEOMETRY;
        // The `+` and send are ON this row now, which is the whole change.
        expect(g.discs).toBe(3);
        expect(g.disc).toBe(36);
        expect(g.gaps).toBe(3);
        // No audio capsule left: the pair collapsed into one button earlier in
        // this ticket, and the mic that was its other half is the primary.
        expect(g).not.toHaveProperty('audioButtons');
        expect(g).not.toHaveProperty('audioButton');
        // The glyph segments are the row's own size, not the 44 they wore
        // outside it.
        expect(g.segment).toBe(36);
        expect(g.glyphSegments).toBe(2);
        expect(g.dividers).toBe(2);
        expect(composerRowFixedWidth()).toBe(200);
    });

    it('costs the name 33pt at every phone, which is what the move is paid in', () => {
        // The row as it was DRAWN outside the bubble, measured the same way:
        // one gutter each side, two 44pt glyph segments with two hairlines,
        // one gap, and the collapsed audio pair as two 44pt buttons with one
        // hairline between them.
        const outside = (width: number) => width - 20 - (2 * 44 + 2) - 6 - (2 * 44 + 1);
        expect([320, 375, 393].map(outside)).toEqual([115, 170, 188]);
        for (const width of [320, 375, 393]) {
            expect(outside(width) - composerModelBudget(width), `${width}`).toBe(33);
        }
    });

    it('draws every Claude name whole at both widths, at full size', () => {
        // The two Clay named on the ticket are the first two. `Opus 4.8 1M`
        // is the longest of the family and the one that has to hold: 97pt
        // against 125 at 375, which is the tightest the row ever gets.
        for (const name of ['Fable 5', 'Opus 5 1M', 'Opus 5', 'Sonnet 5', 'Haiku 4.5', 'Opus 4.8 1M']) {
            expect(composerModelFits(name, 393), `${name} at 393`).toBe(true);
            expect(composerModelFits(name, 375), `${name} at 375`).toBe(true);
        }
        expect(composerModelSegmentWidth('Opus 5 1M')).toBe(83);
        expect(composerModelSegmentWidth('Opus 4.8 1M')).toBe(97);
    });

    it('scales rather than truncating, and the scale is still headroom at 375 and up', () => {
        // Smaller before shorter is the rule the segment draws by, so the
        // honest number is how long a name each size buys. The full size still
        // carries every name the app has at 375 and above: `GPT-5.6 Luna` and
        // `Gemini 3.1 Pro` both used to need the scale at their width and
        // neither does.
        const scale = COMPOSER_MODEL_SEGMENT.minimumFontScale;
        // 0.80 since DROVE-236, and the one number the move actually spends.
        expect(scale).toBe(0.8);
        for (const [name, width] of [['GPT-5.6 Luna', 375], ['GPT-5.6 Sol', 375],
            ['Gemini 3.1 Pro', 393], ['Gemini 3 Flash', 393]] as const) {
            expect(composerModelFits(name, width), `${name} at ${width}`).toBe(true);
        }

        // What the scale is still FOR: a name longer than any shipping one.
        // 15 glyphs at full size on the narrow phone, 17 with the scale; 17
        // and 20 on Clay's. The reach is the claim, not the model list, so a
        // longer name arriving is measured rather than guessed at.
        const longest = (width: number, fontScale: number) => {
            let glyphs = 0;
            while (composerModelSegmentWidth('x'.repeat(glyphs + 1), fontScale)
                <= composerModelBudget(width)) glyphs += 1;
            return glyphs;
        };
        expect([longest(375, 1), longest(375, scale)]).toEqual([16, 20]);
        expect([longest(393, 1), longest(393, scale)]).toEqual([19, 24]);
    });

    it('is what the row could NOT hold before DROVE-153, which is why DROVE-138 moved it', () => {
        // Six 63pt buttons left 63 for the name, and `Opus 5 1M` needs 83.
        expect(composerModelSegmentWidth('Opus 5 1M')).toBeGreaterThan(63);
        expect(composerModelBudget(393)).toBeGreaterThan(63);
    });

    /**
     * 320, WHICH IS WHERE THE ROW ACTUALLY DECIDES SOMETHING (DROVE-236).
     *
     * The ticket asks what gives when the row will not hold five things. This
     * is the answer, run rather than argued: at 375 and 393 nothing gives, and
     * at 320 the four longest names shrink their type and none of them is cut.
     * Nothing is dropped and no name becomes a glyph.
     */
    it('holds every name whole at 320 by shrinking type, never by cutting it', () => {
        expect(composerModelBudget(320)).toBe(82);
        // Whole at 13pt: the short names.
        for (const name of ['Opus 5', 'Fable 5', 'Sonnet 5']) {
            expect(composerModelFits(name, 320), name).toBe(true);
        }
        // Scaled, not cut: the long ones, worst case first.
        expect(composerModelScaleFor('Opus 4.8 1M', 320)).toBeCloseTo(0.805, 3);
        expect(composerModelScaleFor('Sonnet 4.5', 320)).toBeCloseTo(0.886, 3);
        expect(composerModelScaleFor('Opus 5 1M', 320)).toBeCloseTo(0.984, 3);
        // And every one of them draws WHOLE at the floor, which is the claim
        // the floor exists to make.
        for (const name of ['Opus 4.8 1M', 'Sonnet 4.5', 'Haiku 4.5', 'Opus 5 1M',
            'Sonnet 5', 'Fable 5', 'Opus 5']) {
            expect(
                composerModelSegmentWidth(name, COMPOSER_MODEL_SEGMENT.minimumFontScale),
                name,
            ).toBeLessThanOrEqual(composerModelBudget(320));
        }
        // 0.85 would not have. That is why the floor moved, and it is the
        // whole of what the move into the bubble costs the name.
        expect(composerModelSegmentWidth('Opus 4.8 1M', 0.85))
            .toBeGreaterThan(composerModelBudget(320));
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
    it('would gain room at 320 by dropping the name, and does not', () => {
        // A glyph segment where the name is would be the row's own 36.
        const glyphInstead = COMPOSER_BUBBLE_ROW_GEOMETRY.segment;
        expect(composerModelSegmentWidth('Opus 5') - glyphInstead).toBe(26);
        expect(composerModelSegmentWidth('Opus 4.8 1M') - glyphInstead).toBe(61);
        // What it would buy against what it would cost: the name draws at 320
        // as it is.
        expect(composerModelFits('Opus 5', 320)).toBe(true);
    });
});
